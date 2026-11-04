# Qhint

Desktop app (Windows + macOS) that overlays live, step-by-step guidance on top of any
application, generated from a company's existing SOPs, videos and screen recordings.

## Prerequisites

- Node 26 (pinned in `.nvmrc`; we use [fnm](https://github.com/Schniz/fnm))
- pnpm 12 (pinned via `packageManager`; pnpm switches versions automatically)
- Docker Desktop (for Postgres, the Firebase Auth emulator and the storage stub)

No Java or gcloud is needed for local development.

## Quick start

```sh
pnpm i          # install; also downloads the Electron binary
pnpm test       # unit tests (no Docker needed)
pnpm dev        # start Docker services, migrate + seed, then both APIs and the desktop app
```

## Windows test machines

Only the desktop app is needed (no Docker). In PowerShell:

```powershell
winget install Git.Git GitHub.cli Schniz.fnm pnpm.pnpm
# new PowerShell window, then:
Add-Content $PROFILE 'fnm env --use-on-cd --version-file-strategy=recursive --shell powershell | Out-String | Invoke-Expression'
# new PowerShell window again, then:
gh auth login
gh repo clone abdelaziz-ragab/Qhint qhint
cd qhint
fnm install
pnpm i
pnpm dev:desktop
```

Pull and rerun `pnpm dev:desktop` to test new changes. Manual test steps: `apps/desktop/TESTING.md`.

## Commands

| Command               | What it does                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`            | Everything: infra up, migrate, seed, APIs + desktop app with reload     |
| `pnpm dev:desktop`    | Desktop app only (no Docker; use this on the Windows test VMs)          |
| `pnpm test`           | All unit tests (Vitest; no Docker needed)                               |
| `pnpm test:db`        | Database + API isolation tests (needs `pnpm infra:up && pnpm db:setup`) |
| `pnpm test:watch`     | Tests in watch mode                                                     |
| `pnpm typecheck`      | TypeScript across all packages                                          |
| `pnpm lint`           | ESLint                                                                  |
| `pnpm format`         | Prettier (write)                                                        |
| `pnpm infra:up`       | Start Docker services and wait until healthy                            |
| `pnpm infra:down`     | Stop Docker services (data kept)                                        |
| `pnpm infra:reset`    | Stop Docker services and delete their data                              |
| `pnpm db:migrate`     | Apply SQL migrations (`db/migrations/<track>/`)                         |
| `pnpm db:seed`        | Seed the dev tenant and users (idempotent)                              |
| `pnpm db:setup`       | Migrate + seed                                                          |
| `pnpm build:services` | Bundle control-api and data-api into `services/*/dist`                  |

Dev-only: `QHINT_DEBUG_PORT=9222 pnpm dev:desktop` exposes Chrome DevTools Protocol on
`127.0.0.1:9222` for inspecting the app's windows.

## Local services

| Service             | Address               | Notes                                    |
| ------------------- | --------------------- | ---------------------------------------- |
| control-api         | http://127.0.0.1:8081 | sign-in page at `/login`, `GET /healthz` |
| data-api            | http://127.0.0.1:8082 | `GET /healthz`                           |
| Postgres + pgvector | 127.0.0.1:5432        | db `qhint`, user `qhint`, pw `qhint_dev` |
| Firebase Auth emu.  | 127.0.0.1:9099        | project `demo-qhint` (never hits Google) |
| Storage stub (GCS)  | http://127.0.0.1:4443 | bucket `qhint-dev-content`               |

All ports bind to loopback only.

Service settings for local development live in `.env.development` (committed; local emulator
values only). Put anything real in `.env` (gitignored).

### Dev accounts (emulator only)

Two tenants, each its own Identity Platform tenant. Password for all: `qhint-dev-only`.

| Tenant       | Admin               | Employee               |
| ------------ | ------------------- | ---------------------- |
| Acme (dev)   | `admin@acme.test`   | `employee@acme.test`   |
| Globex (dev) | `admin@globex.test` | `employee@globex.test` |

Signing in from the desktop app opens the sign-in page in your browser. Enter one of the emails
above and the password. **Continue with Google** needs no email typed first: in the emulator's fake
Google window, pick or add an account with email `google.user@acme.test` (or
`google.user@globex.test`). Those are invited but have never signed in, so control-api links the
account on first sign-in. **SSO** shows "not set up" (no dev tenant has one) and **Microsoft** is
"coming soon". Emails that aren't invited are refused: they never get access.

Tokens carry custom claims `tenantId`, `userId` and `role`, set by control-api. Seed scripts
refuse to run against anything that isn't localhost.

## Repository layout

```
apps/desktop/          Electron app (main process + React renderer)
services/control-api/  Control plane: tenants, users, plans, data-plane lookup, app updates
services/data-api/     Data plane: procedures, docs, search, runs, gaps, model gateway
services/ingest-job/   Video/doc -> procedure (Cloud Run Job)
packages/schema/       Shared zod types
packages/prompts/      Versioned prompts
packages/eval/         Eval fixtures + scoring CLI
db/migrations/         Plain SQL migrations, one track per plane (control, content)
docker/                Local-dev container images
infra/                 Terraform (GCP)
scripts/               Dev scripts (migrate, seed, service bundler) and end-to-end tests
packages/server-kit/   Shared server code: auth, logging, errors, config, db
```

Internal packages are consumed as TypeScript source (no build step in development).

## Security ground rules

- Every content row carries `tenant_id`, enforced with Postgres row-level security. The
  tenant comes only from the verified auth token, never from a request body.
- Screenshots are never stored server-side.
- Logs and error reports never contain content (questions, step text, doc text, images).
  Service loggers record method, route pattern, status and timing only.
- Provider API keys live only in the backend.
- Operator analytics are a strict whitelist of counts, durations and codes, with hashed ids.
- Never commit secrets; copy `.env.example` to `.env` only to override local defaults.
