# Slice 1: admin account

Owner: Farzaan. The Platform and AI dashboards (`/dashboards/platform`) and a few admin-only
endpoints need someone who can log in as an admin. The seed data has no admin, and public sign-up
can never create one, so each database gets its admin from one setup command.

## Setup (once per database)

**Run this once on the demo database before the dashboards are used.** Any teammate who wants the
dashboards locally runs it once on their own database too.

```bash
npm run infra:up
```
```bash
npm run admin:create
```

1. The command asks for the admin password twice. Nothing is shown while you type. It must be at
   least 12 characters (and at most 72 bytes, bcrypt's limit).
2. Open the client, go to **Log in**, select **Host**, and log in with `admin@staybook.test` (or
   your `ADMIN_EMAIL`). Admins land on `/dashboards/platform`, which shows the platform and AI
   dashboards.

It works the same on a fresh database and on an existing volume: no reset, no migration and no
schema change. It needs MySQL on `localhost:3307` (`npm run infra:up`) and Node 22 on your
machine; it is not run inside a container.

### Settings

All optional. They are read from the environment or from your own `.env` (git-ignored).

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_EMAIL` | `admin@staybook.test` | The login email |
| `ADMIN_NAME` | `Staybook Admin` | Shown as the host name |
| `ADMIN_PASSWORD` | not set | Only for unattended runs. When it is empty you are prompted. Never put it in `.env.example`, a commit, a PR or chat |

Without a terminal (for example in CI) and without `ADMIN_PASSWORD`, the command stops with an
error instead of waiting for input.

### Changing the password

```bash
npm run admin:create -- --reset-password
```

This changes only the admin's password hash (and bumps its `version`).
**Tokens already issued to the admin stay valid until they expire** (8 hours by default,
`JWT_EXPIRES_IN_SECONDS`). Changing the password does not sign out existing sessions.

## What running it again does

| What already uses the email | Result | Exit code |
| --- | --- | --- |
| Nothing | Creates the admin | 0 `Created admin …` |
| An active admin | **Nothing changes**, and no password is asked for | 0 `Admin already exists …` |
| An active admin, with `--reset-password` | New password hash, `version` + 1 | 0 `Password changed …` |
| An ordinary host (standard or superhost) | **Refused.** It is never promoted, and its password is never touched | 2 `HOST_NOT_ADMIN` |
| A deleted host | Refused. A deleted account is never revived | 2 `HOST_DELETED` |
| An active guest | Refused: a guest and an admin with one email would make login ambiguous | 2 `EMAIL_USED_BY_GUEST` |
| Two runs at the same time | The unique email key lets one insert win; the other reports that the admin exists | 0 |

Exit code 1 means bad input or a setup problem: a short or mismatched password, no terminal and no
`ADMIN_PASSWORD`, MySQL not reachable, or an unknown option. Nothing is changed in those cases.
To use another email instead of a refused one, set `ADMIN_EMAIL`.

## Design

- **Existing mechanism, no schema change.** An admin is a host row with
  `access_level = 'admin'`. `POST /auth/login` already issues `role: "admin"` for such a host, so the
  JWT (`sub`, `role`), the gateway and every service's role checks are unchanged.
- **One place can write an admin:** `services/user-service/src/adminSetup.js`. Sign-up
  (`/hosts/create`) still rejects `access_level`, and `hosts.insert` still cannot set it.
- **No seeded credentials.** Nothing is added to `infra/mysql/init/002_seed.sql`: a seeded admin
  would mean a known password and a committed hash. Each database's admin password is chosen by the
  person who runs the command, and only its bcrypt hash is stored.
- **Nothing secret is printed.** The command prints the outcome, `host_id` and email only. Errors are
  reduced to a code and one sentence, never the error object, which can carry query details.
- **No `user.created` event.** The admin is not a marketplace sign-up, so it is not counted in
  analytics.
- The created admin has `verification_status = 'verified'`.

## What the admin can reach

| Where | Endpoint or page |
| --- | --- |
| Platform dashboard | `GET /analytics/platform`, `GET /traces/{trace_id}`, `GET /analytics/geo` |
| AI dashboard | `GET /analytics/ai` |
| User service | `POST /guests/search`, and any guest or host profile |
| AI service | `GET /ai/versions`, `POST /ai/versions/{id}/promote` |
| Client | `/dashboards/platform`, plus the host pages in the admin menu |

Ordinary guests and hosts get `403` on the admin-only endpoints, and requests without a token get `401`.

## Limitations

- **The admin is also a host row,** so it can open the host pages and could create listings. That is
  how the existing access model represents admins.
- **Existing admin tokens survive a password reset** until they expire (see above).
- **Removing admin rights** (changing `access_level` in MySQL) also only takes effect when the
  admin's current token expires, as noted in [slice1-account-deletion.md](slice1-account-deletion.md).
- Messaging stays participant-only: admins cannot read conversations ([slice1-messaging.md](slice1-messaging.md)).

## Tests

- **Unit** (`services/user-service/test/adminSetup.test.js`, 20 tests):
  - Every outcome in the table, with no writes on any refusal.
  - Password rules, email normalisation, and both concurrent-run cases.
  - The hidden prompt: raw mode on while typing, restored after, nothing echoed.
  - The command never prints the password or hash, and its exit codes.
  - With no terminal it exits instead of hanging.
- **MySQL** (`services/user-service/test/integration/admin.int.js`, 7 tests):
  - The real create, then a repeat run with a different password, which is not applied.
  - Login as Host gives `role: admin` with unchanged JWT claims, and the gateway's account check accepts it.
  - A reset makes the old password fail, while a token issued before it is still accepted.
  - An ordinary host is left byte-for-byte unchanged; sign-up with `access_level` is still 400.
  - Deleted host and guest emails are refused; two concurrent runs create one row.
  - The real command in a child process: create, repeat, no terminal, refusal.
- **`npm run smoke:auth`**, section "Admin account and dashboards". It creates a throwaway admin with a
  random password, so it needs no secret. It deletes that admin by its unique email in a `finally`
  block, so a failed check still cleans up, and first removes any throwaway admin an interrupted
  earlier run left behind (only rows named "Smoke Admin" with a `smoke-admin-…@example.com` email).
  Through the real gateway:
  - Admin login gives `role: admin`.
  - Platform and AI dashboard data answer 200 for the admin, 403 for an ordinary host and guest, and 401 without a token.
  - Admin guest search is 200, and 403 for a host.
