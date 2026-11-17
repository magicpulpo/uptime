# uptime

AUT-014, the uptime pinger. Read `README.md` first.

## Rules

- This repo is **public**. Never add a secret, a private URL, a client name or anything from a health body other than check names and HTTP codes to code, logs or messages.
- No dependencies: `check.mjs` runs on the Node that ships with the Actions runner.
- Pin every action to a full commit SHA with the version in a comment.
- Branch and PR for every change, never straight to `main` (mp-os `docs/engineering.md`). `node --test` must pass.
- Alerts go to the thread named by the target's automation id, in the Magic Pulpo space, until an `ops` space exists.
