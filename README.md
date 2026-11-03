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

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `pnpm dev`         | Everything: infra up, migrate, seed, APIs + desktop app with reload |
| `pnpm dev:desktop` | Desktop app only (no Docker; use this on the Windows test VMs)      |
| `pnpm test`        | All unit tests (Vitest)                                             |
| `pnpm test:watch`  | Tests in watch mode                                                 |
| `pnpm typecheck`   | TypeScript across all packages                                      |
| `pnpm lint`        | ESLint                                                              |
| `pnpm format`      | Prettier (write)                                                    |
| `pnpm infra:up`    | Start Docker services and wait until healthy                        |
| `pnpm infra:down`  | Stop Docker services (data kept)                                    |
| `pnpm infra:reset` | Stop Docker services and delete their data                          |
| `pnpm db:migrate`  | Apply SQL migrations (`db/migrations/<track>/`)                     |
| `pnpm db:seed`     | Seed the dev tenant and users (idempotent)                          |
| `pnpm db:setup`    | Migrate + seed                                                      |

Dev-only: `QHINT_DEBUG_PORT=9222 pnpm dev:desktop` exposes Chrome DevTools Protocol on
`127.0.0.1:9222` for inspecting the app's windows.

## Local services

| Service             | Address               | Notes                                    |
| ------------------- | --------------------- | ---------------------------------------- |
| control-api         | http://127.0.0.1:8081 | `GET /healthz`                           |
| data-api            | http://127.0.0.1:8082 | `GET /healthz`                           |
| Postgres + pgvector | 127.0.0.1:5432        | db `qhint`, user `qhint`, pw `qhint_dev` |
| Firebase Auth emu.  | 127.0.0.1:9099        | project `demo-qhint` (never hits Google) |
| Storage stub (GCS)  | http://127.0.0.1:4443 | bucket `qhint-dev-content`               |

All ports bind to loopback only.

### Dev accounts (emulator only)

Tenant **Acme (dev)** (`00000000-0000-4000-8000-000000000001`), one Identity Platform tenant:

| Email                | Role     | Password         |
| -------------------- | -------- | ---------------- |
| `admin@acme.test`    | admin    | `qhint-dev-only` |
| `employee@acme.test` | employee | `qhint-dev-only` |

Tokens carry custom claims `tenantId` and `role`. Seed scripts refuse to run against
anything that isn't localhost.

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
scripts/               Dev scripts (migrate, seed)
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
