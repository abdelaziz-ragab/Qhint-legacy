# infra

Terraform for the GCP demo environment, built to stay inside Google's always-free tier.
Nothing here has been applied yet.

| Piece     | What                                                                                                        | Free tier                                            |
| --------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Database  | Postgres 17 + pgvector on an `e2-micro` VM (Container-Optimized OS, no public IP), nightly `pg_dump` to GCS | 1 e2-micro + 30 GB standard disk per billing account |
| APIs      | `qhint-control-api`, `qhint-data-api` on Cloud Run, scale to zero, Direct VPC egress to the DB              | 2M requests/month                                    |
| Storage   | `<project>-content` (uploads, `t/<tenant>/…`), `<project>-db-backups` (14-day lifecycle)                    | 5 GB (US regional)                                   |
| Secrets   | DB passwords, DB URLs, analytics hash key, content master key                                               | 6 active versions free; ~$0.06/month per extra       |
| Sign-in   | Identity Platform, multi-tenant: email + password and Google per tenant, invite-only (SSO, Microsoft later) | 50k MAU                                              |
| Images    | Artifact Registry `qhint` + Docker Hub pull-through cache                                                   | 0.5 GB                                               |
| Analytics | Postgres by default; BigQuery optional (`enable_bigquery`)                                                  | 10 GB / 1 TB queries                                 |

Only one e2-micro is free per billing account. Leelo's `leelo-gateway` VM shares the billing
account: if both run at once, one of them is billed (~$7/month).

## First-time setup

1. **State bucket** (holds generated secrets; keep it private):
   ```sh
   gcloud storage buckets create gs://qhint-dev-1ff9-tfstate --location=us-central1 \
     --uniform-bucket-level-access --public-access-prevention --project=qhint-dev-1ff9
   cp backend.hcl.example backend.hcl
   terraform init -backend-config=backend.hcl
   ```
2. **Google sign-in OAuth client** (one-time, console only): APIs & Services → OAuth consent
   screen (External, app name "Qhint"), then Credentials → Create OAuth client ID → Web
   application, authorized redirect URI `https://<project-id>.firebaseapp.com/__/auth/handler`.
   Put the client id/secret in `terraform.tfvars` (copy from `terraform.tfvars.example`). The
   same client is used for the project-level Google provider and every tenant's: the sign-in page
   gets the Google credential at the project level and reuses it in the company's tenant.
3. `terraform apply` creates everything with placeholder container images.
4. Build and push the service images, then set `control_api_image` / `data_api_image` and apply
   again:
   ```sh
   REPO=us-central1-docker.pkg.dev/qhint-dev-1ff9/qhint; TAG=$(git rev-parse --short HEAD)
   gcloud auth configure-docker us-central1-docker.pkg.dev
   docker build --platform linux/amd64 -f services/control-api/Dockerfile -t $REPO/control-api:$TAG .
   docker build --platform linux/amd64 -f services/data-api/Dockerfile -t $REPO/data-api:$TAG .
   docker push $REPO/control-api:$TAG && docker push $REPO/data-api:$TAG
   ```

## Not done yet (needed before the first real deploy)

- A migration job that applies `db/migrations/*` to the VM database and sets the application role
  passwords from Secret Manager (the local `pnpm db:migrate` refuses non-local databases).
- A tenant/user provisioning command for production (the local seed is emulator-only).
- Building the desktop app against the deployed control-api URL.

## Later

- A blocking function (`beforeCreate`) that rejects sign-ups from emails that aren't invited, so
  stray accounts are never created in the first place.
- Periodic cleanup of stray project-level accounts (the sign-in page deletes its temporary one,
  but a closed tab or failed request can leave it behind).

## Security notes

- The DB VM has no public IP; Postgres is reachable only from the private subnet (Cloud Run) and
  SSH only through IAP. Traffic inside the VPC is not TLS-encrypted at the Postgres level (Google
  encrypts VM-to-VM traffic at the network layer); TLS for Postgres is on the later list.
- Both Cloud Run services are publicly reachable; every route except `/healthz` and the sign-in
  page requires an Identity Platform token, and `/internal/*` requires a Google ID token from the
  data-api service account.
- The browser API key is public by design and restricted to the two auth APIs.
- Access is invite-only. Sign-up stays enabled in Identity Platform (an invited user's first Google
  sign-in creates their account, and the page's project-level Google step needs it), but every API
  refuses tokens without our custom claims and tokens from outside a tenant, and control-api sets
  claims only for invited users with a verified email, inside their company's tenant. Sign-in with
  Google: a project-level popup reads the email, the page deletes that temporary account, finds
  the company (`/auth/discover`) and signs the same credential into its tenant without a second
  prompt. A company's SSO (SAML/OIDC) is a provider on its tenant; see the commented example in
  `identity.tf`.
