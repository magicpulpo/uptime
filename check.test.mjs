import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, failingChecks, probe, run } from './check.mjs';

const target = { id: 'AUT-013', name: 'Social publisher', url: 'https://social.example/api/health' };
const at = (iso) => new Date(iso);
const json = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('failingChecks', () => {
  it('reads both health shapes we run: booleans (mp-social) and states (website)', () => {
    assert.deepEqual(failingChecks({ database: true, publisher_heartbeat: false, paused: true }), ['publisher_heartbeat']);
    assert.deepEqual(
      failingChecks({ db: 'ok', env: 'missing 2', crons: { sweep: 'stale', digest: 'ok' }, jobs: { state: 'fail', pending: 3 } }),
      ['env', 'crons.sweep', 'jobs'],
    );
  });

  it('does not count the kill switch as a fault', () => {
    assert.deepEqual(failingChecks({ paused: false }), []);
  });
});

describe('probe', () => {
  it('is up on 200 with ok:true, down on 503 with the failing checks named', async () => {
    assert.deepEqual(await probe(target.url, json(200, { ok: true, checks: {} })), { up: true, detail: 'HTTP 200' });
    assert.deepEqual(await probe(target.url, json(503, { ok: false, checks: { database: false, paused: false } })), {
      up: false,
      detail: 'HTTP 503, failing: database',
    });
  });

  it('is down when the body says ok:false even on 200, or when the host does not answer', async () => {
    assert.equal((await probe(target.url, json(200, { ok: false }))).up, false);
    const refused = await probe(target.url, async () => {
      throw new TypeError('fetch failed');
    });
    assert.deepEqual(refused, { up: false, detail: 'unreachable' });
  });
});

describe('decide', () => {
  const up = { up: true, detail: 'HTTP 200' };
  const down = { up: false, detail: 'HTTP 503' };

  it('stays quiet while things are up, including the first run', () => {
    assert.equal(decide(undefined, up, at('2026-11-16T21:00:00Z'), target).message, null);
    assert.equal(decide({ up: true, since: '2026-11-16T20:00:00Z' }, up, at('2026-11-16T21:00:00Z'), target).message, null);
  });

  it('alerts once when a target goes down, then every 6 hours, then when it recovers', () => {
    const first = decide({ up: true, since: '2026-11-16T20:00:00Z' }, down, at('2026-11-16T21:00:00Z'), target);
    assert.match(first.message, /^AUT-013 · uptime: Social publisher is DOWN \(HTTP 503\)/);

    const quiet = decide(first.next, down, at('2026-11-17T02:50:00Z'), target);
    assert.equal(quiet.message, null);

    const reminder = decide(quiet.next, down, at('2026-11-17T03:00:00Z'), target);
    assert.match(reminder.message, /still down after 6 h/);

    const back = decide(reminder.next, up, at('2026-11-17T03:40:00Z'), target);
    assert.match(back.message, /is back up after 7 h\.$/);
    assert.equal(back.next.up, true);
  });
});

describe('run', () => {
  it('checks twice before alerting, and keeps state unchanged when Chat refuses the alert', async () => {
    let healthCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).startsWith('https://chat.example')) return new Response(null, { status: 500 });
      healthCalls += 1;
      return new Response('{"ok":false}', { status: 503 });
    };
    const state = { 'AUT-013': { up: true, since: '2026-11-16T20:00:00Z' } };
    const result = await run({ targets: [target], state, now: at('2026-11-16T21:00:00Z'), webhook: 'https://chat.example/hook', fetchImpl, wait: async () => {} });
    assert.equal(healthCalls, 2);
    assert.equal(result.undelivered, 1);
    assert.equal(result.state['AUT-013'].up, true);
  });

  it('a one-off failure that passes on the second look is not an outage', async () => {
    let calls = 0;
    const fetchImpl = async () => (++calls === 1 ? new Response('', { status: 502 }) : new Response('{"ok":true}', { status: 200 }));
    const result = await run({ targets: [target], state: {}, now: at('2026-11-16T21:00:00Z'), webhook: undefined, fetchImpl, wait: async () => {} });
    assert.equal(result.undelivered, 0);
    assert.equal(result.state['AUT-013'].up, true);
  });
});
