# Keymaster — credential custodian

The Keymaster (`agent-keymaster`) is the credential custodian for the
whole Teamz system. It holds the credential **inventory** and the
**authority** to use credentials through approved mechanisms — never
the raw values.

## The hard rule

**NEVER write a credential VALUE** (password, API key, token, secret)
into an agent's system prompt, into a file, into the runner state,
into a log, or into a chat message. The Keymaster holds, for each
credential: which credential the system needs, where it lives, what it
is for, and which system needs it. Presence only.

The Keymaster never asks for a raw secret in chat, never extracts a
live secret from a connector to write it into a file, and never
proceeds as if it had a credential it does not have. If a credential
is missing, it reports it as missing and says how Jesse can place it
through the secure flow.

## The inventory

`docs/credential-inventory.json` in the repo (and the same record on
jnet1). First audit, Nov 26, 2026 — presence checked by file
existence / service-environment presence / CLI login status only; no
file contents were read and no values were printed:

| Credential | Status | Where it lives |
|---|---|---|
| Stripe secret key (live) | **missing** | `/opt/mem20/secrets/.env` on jnet1 — file does not exist. Known blocker for the live shop deploy. |
| Stripe publishable key (live) | **missing** | Same file as above. |
| GitHub token | present | gh CLI auth on jnet1 (logged in as `bythewayz66-glitch`); root-held, not in the runner's reach. |
| Cloudflare API token | present | Token files on jnet1 (`/root/.cloudflare-ddns.token`, `/root/.cloudflare.env`); scope unverified, root-held. Also the Muse Cloudflare connector on the VM. |
| Pollinations API key | **missing** | Not set in `teamz-agent.service` — the endpoint runs on the anonymous tier. |
| IONOS credentials | missing on jnet1 | Held by Jesse (IONOS account `zimzimtimq@gmail.com`). |
| Teamily server key | **missing** | Not provided; no Teamily connection exists. |
| Agensi OAuth | present | Muse connector store on the VM. |

## The secrets store

`/var/lib/teamz-secrets` on jnet1 — directory `0700`, owned by
`teamz:teamz` (the runner service user only). It exists and is empty:
no credential values have been placed there, and none are invented.
Values arrive only via the secure flow, placed by Jesse.

## The audit automation

`cron-keymaster-daily-audit` (`0 8 * * *`, `conv-build-room`): a daily
audit run — review the inventory, report exactly what is present and
what is missing, and how Jesse can place each missing one through the
secure flow. Never a value, presence only.

## Tests

`src/lib/keymaster.test.ts` — the inventory lists all eight
credentials with location/purpose/status, contains no credential
value anywhere (no forbidden key, no key-shaped string), the missing
summary matches the entries marked missing, and the secrets store is
recorded as restricted and unpopulated.
