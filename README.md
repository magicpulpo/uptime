# uptime

Automation **AUT-014** in the Magic Pulpo automation register. Every 10 minutes a GitHub Actions workflow calls each health route in [`targets.json`](targets.json) and posts to the Magic Pulpo Google Chat space, in the thread of the automation that is affected:

- **Down:** a route answers something other than HTTP 200, says `"ok": false`, or does not answer within 25 seconds, on two checks 30 seconds apart. The alert names the failing checks.
- **Still down:** a reminder every 6 hours.
- **Back up:** one message with how long it was down.

This repo is public so the schedule runs on free Actions minutes. Nothing in it is secret: the health routes are public, and the logs carry ids, HTTP codes and check names only. The Chat webhook is the repo secret `CHAT_WEBHOOK_UPTIME` (vault: `AUT-014 · Chat webhook ops`).

## Add an app

Add an entry to `targets.json` with the automation id whose thread should get the alerts, a short name and the health route. The route should answer 200 with `{"ok": true, "checks": {...}}` when healthy and 503 when not, and carry counts only, never ids, emails or error text, because it is public.

## How it works

- `check.mjs` does the checks; `check.test.mjs` covers it (`node --test`, no dependencies).
- Who is down since when is kept in `state.json`, carried between runs by the Actions cache. A lost cache only means one missed "back up" message.
- If Chat refuses an alert, the run fails (GitHub emails the repo admins) and the next run sends it again.
- GitHub can start scheduled runs late when it is busy, so an outage is noticed in roughly 10 to 30 minutes.
- GitHub turns off schedules in public repos after 60 days without activity; each run re-enables the workflow to prevent that.

## Kill switch

Actions tab, `uptime` workflow, **Disable workflow**. Run it by hand with **Run workflow**; tick **test alert** to post a test message to the AUT-014 thread and prove the webhook works.
