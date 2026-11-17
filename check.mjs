// AUT-014 uptime pinger. Calls each health route in targets.json and posts to Google Chat
// when one goes down, every 6 hours while it stays down, and when it comes back.
// State (who is down since when) lives in state.json, carried between runs by actions/cache.
// Logs are public (this repo is public): they carry ids, HTTP codes and check names only.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 25_000;
const RECHECK_AFTER_MS = 30_000;
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;

/** Names of the checks a health body reports as failing: false, or a state other than "ok". */
export function failingChecks(checks, prefix = '') {
  if (!checks || typeof checks !== 'object') return [];
  const failing = [];
  for (const [key, value] of Object.entries(checks)) {
    const name = prefix + key;
    if (key === 'paused') continue; // mp-social reports its kill switch here; it is not a fault
    if (value === false) failing.push(name);
    else if (typeof value === 'string' && value !== 'ok') failing.push(name);
    else if (value && typeof value === 'object') {
      if (typeof value.state === 'string') {
        if (value.state !== 'ok') failing.push(name);
      } else failing.push(...failingChecks(value, `${name}.`));
    }
  }
  return failing;
}

/** One call to a health route: up only on HTTP 200 with a body that does not say ok:false. */
export async function probe(url, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': 'magicpulpo-uptime (AUT-014)', 'cache-control': 'no-cache' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { up: false, detail: error?.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : 'unreachable' };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON: judged on the status alone
  }
  const up = response.status === 200 && body?.ok !== false;
  if (up) return { up, detail: 'HTTP 200' };
  const failing = failingChecks(body?.checks);
  return { up, detail: `HTTP ${response.status}${failing.length ? `, failing: ${failing.join(', ')}` : ''}` };
}

function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/**
 * What to remember and what to say, given the last state and this check.
 * State per target: { up, since, alertedAt }.
 */
export function decide(previous, result, now, target) {
  const at = now.toISOString();
  const label = `${target.id} · uptime: ${target.name}`;
  if (result.up) {
    if (previous && !previous.up) {
      return { next: { up: true, since: at }, message: `${label} is back up after ${duration(now - new Date(previous.since))}.` };
    }
    return { next: previous?.up ? previous : { up: true, since: at }, message: null };
  }
  if (!previous || previous.up) {
    return { next: { up: false, since: at, alertedAt: at }, message: `${label} is DOWN (${result.detail}). ${target.url}` };
  }
  if (now - new Date(previous.alertedAt ?? previous.since) >= REMIND_EVERY_MS) {
    return {
      next: { ...previous, alertedAt: at },
      message: `${label} is still down after ${duration(now - new Date(previous.since))} (${result.detail}). ${target.url}`,
    };
  }
  return { next: previous, message: null };
}

/** Posts into the target's own thread. Never logs the webhook URL. */
export async function postChat(webhook, text, thread, fetchImpl = fetch) {
  if (!webhook) return false;
  try {
    const url = new URL(webhook);
    url.searchParams.set('threadKey', thread);
    url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function run({ targets, state, now, webhook, fetchImpl = fetch, wait = sleep }) {
  let undelivered = 0;
  for (const target of targets) {
    let result = await probe(target.url, fetchImpl);
    if (!result.up) {
      // A second look before alerting: cold starts and one-off network errors are not outages.
      await wait(RECHECK_AFTER_MS);
      result = await probe(target.url, fetchImpl);
    }
    const { next, message } = decide(state[target.id], result, now, target);
    if (message && !(await postChat(webhook, message, target.id, fetchImpl))) {
      undelivered += 1;
      console.log(`${target.id}: ${result.up ? 'up' : 'DOWN'} (${result.detail}), alert NOT delivered, retrying next run`);
      continue; // state unchanged, so the next run tries the alert again
    }
    state[target.id] = next;
    console.log(`${target.id}: ${result.up ? 'up' : 'DOWN'} (${result.detail})${message ? ', alert sent' : ''}`);
  }
  return { state, undelivered };
}

async function main() {
  const targets = JSON.parse(await readFile(new URL('./targets.json', import.meta.url), 'utf8'));
  let state = {};
  try {
    state = JSON.parse(await readFile('state.json', 'utf8'));
  } catch {
    console.log('No saved state: starting fresh.');
  }
  const result = await run({ targets, state, now: new Date(), webhook: process.env.CHAT_WEBHOOK });
  await writeFile('state.json', `${JSON.stringify(result.state, null, 2)}\n`);
  if (process.env.TEST_ALERT === 'true') {
    // Manual run with "test alert" ticked: proves the webhook and thread without breaking an app.
    const summary = targets.map((t) => `${t.id} ${result.state[t.id]?.up ? 'up' : 'down'}`).join(', ');
    const sent = await postChat(process.env.CHAT_WEBHOOK, `AUT-014 · uptime: test alert from a manual run (${summary}).`, 'AUT-014');
    console.log(sent ? 'Test alert sent.' : 'Test alert NOT delivered.');
    if (!sent) result.undelivered += 1;
  }
  if (result.undelivered) {
    console.log(process.env.CHAT_WEBHOOK ? 'Chat did not accept an alert.' : 'CHAT_WEBHOOK is not set.');
    process.exit(1); // a failed run emails the repo admins
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
