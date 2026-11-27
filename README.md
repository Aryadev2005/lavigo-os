# Lavigo OS

The owner and staff operating system for Lavigo Travel Co. (Ranchi). It covers a shared WhatsApp and Instagram inbox with a deal desk, bookings, payments and dues, a supplier rate desk, a tickets desk, departures, profit, and pricing rules.

v1 has **no AI/LLM features**. See `docs/01-SRS.md` §1.1.

| Doc | What's in it |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Conventions: money in paise, IST dates, auth in the data layer, adapters + fakes |
| [`docs/01-SRS.md`](docs/01-SRS.md) | Requirements (IDs such as `PRC-2` and `DESK-3`) |
| [`docs/03-system-design.md`](docs/03-system-design.md) | Architecture, jobs, security, Docker, CI |
| [`docs/04-database-schema.md`](docs/04-database-schema.md) | Data model and seed data |
| [`docs/reference/lavigo-os-demo.html`](docs/reference/lavigo-os-demo.html) | Visual reference |

## Quick start (Docker only)

You need only Docker with Compose v2. Node, pnpm and Postgres all run in containers.

```sh
make up        # build the dev image and start web, worker, postgres, redis, minio, mailpit
make migrate   # apply Prisma migrations
make seed      # load the demo data; prints the login passwords
```

The first `make up` installs dependencies into a Docker volume, which takes a few minutes. Then open:

| URL | What |
|---|---|
| http://localhost:3000 | Lavigo OS. Sign in as `owner@lavigo.local` or `staff@lavigo.local` |
| http://localhost:3000/api/health | DB + Redis health |
| http://localhost:8025 | Mailpit (every email sent in dev) |
| http://localhost:9001 | MinIO console (`minio` / `minio12345`) |

To choose passwords yourself, set `SEED_OWNER_PASSWORD` and `SEED_STAFF_PASSWORD` in `.env` (copy it from `.env.example`) before running `make seed`. Otherwise the seed generates random passwords and prints them. **The seed wipes the database each time it runs.** Seed dates are relative to today (IST); `SEED_TODAY=2026-11-03 make seed` pins the date.

### Everyday commands

| Command | What it does |
|---|---|
| `make up` / `make down` | Start / stop the stack. Volumes are kept |
| `make logs` (`s=worker` for one service) | Follow logs |
| `make sh` | Shell in the web container |
| `make migrate` | `prisma migrate dev`. Pass `args="--name add_x"` to name a new migration |
| `make seed` | Reload the demo data |
| `make test` / `make lint` / `make typecheck` | Run checks inside the container |
| `make job name=reminders` | Run a scheduled job once |
| `make build` | Build the production image locally |
| `make reset` | **Deletes all dev volumes** (database, redis, minio, node_modules) |

With empty provider keys, development uses fakes: WhatsApp and Instagram sends are logged, Razorpay is simulated, and email goes to Mailpit. In production, `src/server/env.ts` refuses to boot without the real keys.

### Disk usage on your machine

Containers keep Node and Postgres off your host *toolchain*, but Docker's own images and volumes still live in Docker's data directory. By default that's on your main drive.

- **Docker Desktop (macOS/Windows):** Settings → Resources → Advanced → *Disk image location*. Point it at an external or secondary drive.
- **Linux:** set `"data-root"` in `/etc/docker/daemon.json`.
- **Cleanup:** `docker system df` shows usage. `docker builder prune` and `docker volume prune` reclaim space.
- **Expected footprint:** about 2–3 GB of images, plus the database volume.
- **Zero local disk:** develop in a cloud environment instead, such as a Claude Code cloud session or Codespaces.

## Layout

```
src/app/(auth)/login        sign-in page
src/app/(app)/…             app shell (sidebar, top bar, toasts) and pages
src/app/api/health          DB + Redis check
src/server/                 env, db, redis, queue, pubsub, logger, money, time, audit, auth, rbac
src/server/domain/<area>    domain logic (pure functions + queries/mutations)
src/worker/index.ts         BullMQ worker (graceful shutdown)
prisma/                     schema, migrations, seed
docker/                     Dockerfile (prod), Dockerfile.dev
```

## CI

`.github/workflows/ci.yml` runs on every push and pull request. CI needs no secrets.

1. **quality:** `prisma validate`, lint, typecheck, `pnpm check:actions` (every server action, route handler and page checks the session, and OWNER where it decides money; no LLM dependency), and `pnpm audit --prod --audit-level high`.
2. **test:** Postgres + Redis services, migrations, a migration drift check, vitest.
3. **build:** the production image; pushed to GHCR (`ghcr.io/aryadev2005/lavigo-os:{sha,latest}`) on `main` only.
4. **e2e:** the production image in `docker-compose.prod.yml` behind Caddy, fakes via `DEMO_FAKES=true`, seeded with `pnpm seed:prod`, then `tests/e2e/smoke.spec.ts` (Playwright, `--trace off`). It finishes by proving that web and worker refuse to boot without keys when `DEMO_FAKES` is unset.

Run the same thing locally:

```sh
make build              # lavigo-os:local
make prod-local-up      # writes .env.prod.local (random secrets), starts http://localhost:8080
make prod-local-seed    # demo data (empty DB only) + templates approved
set -a; . ./.env.prod.local; set +a
E2E_STAFF_PASSWORD=$SEED_STAFF_PASSWORD E2E_OWNER_PASSWORD=$SEED_OWNER_PASSWORD pnpm e2e   # needs Node + Playwright on the host
make prod-local-down    # stops it and drops its volumes
```

## Production deployment runbook

### Layout (`docker-compose.prod.yml`)

```
internet ─▶ caddy :80/:443  (TLS, 22 MB body limit, sets X-Forwarded-For itself)
              └─▶ web :3000      node server.js        ─┐ same image
                  worker         node dist/worker.js   ─┘ ghcr.io/aryadev2005/lavigo-os
                  migrate        prisma migrate deploy (one-shot; web + worker wait for it)
                  postgres 16    volume pgdata
                  redis 7        volume redisdata (AOF)
                  backup         daily pg_dump → S3 bucket, 14 days kept
```

- **Only Caddy publishes ports.** `web` is never exposed: the login rate limit trusts the last `X-Forwarded-For` hop, which is the one Caddy writes. Caddy does not trust a client's `X-Forwarded-For`.
- **Files** (PDFs, uploads, backups) go to managed S3-compatible storage via `S3_*`: AWS S3 `ap-south-1` (Mumbai), Cloudflare R2, or DigitalOcean Spaces (`blr1`). There is no MinIO in production.
- Everything has `restart: unless-stopped`.

### Fresh Ubuntu VPS, step by step

A 2 vCPU / 4 GB VPS is enough for v1. Pick the Mumbai or Bangalore region.

1. **DNS:** create an A record (for example `os.lavigo.in`) pointing at the VPS IP. Wait until `dig +short os.lavigo.in` returns it.
2. **Docker:**
   ```sh
   sudo apt-get update && sudo apt-get install -y ca-certificates curl git
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
3. **Firewall:** allow only SSH, 80 and 443.
   ```sh
   sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
   ```
4. **Code and env:**
   ```sh
   git clone https://github.com/Aryadev2005/lavigo-os.git && cd lavigo-os
   cp .env.prod.example .env.prod && chmod 600 .env.prod
   nano .env.prod      # every key; secrets from: openssl rand -base64 48
   ```
   The storage bucket must be **private**. Use Razorpay **test** keys first (see below).
5. **Image:** if the GHCR package is private, run `echo <token> | docker login ghcr.io -u <github-user> --password-stdin` with a PAT that has `read:packages`.
6. **Start:**
   ```sh
   export ENV_FILE=.env.prod
   docker compose -f docker-compose.prod.yml --env-file .env.prod pull
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --wait
   ```
   `migrate` runs first. Caddy gets the Let's Encrypt certificate on the first request.
7. **First owner, settings, reminder rules, templates (non-destructive; safe to re-run):**
   ```sh
   docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm web pnpm seed:prod
   ```
   It never wipes anything. Demo data is added only with `-e SEED_DEMO=true`, and only into an empty database.
8. **Smoke:** `curl https://os.lavigo.in/api/health` returns `{"status":"ok",…}`. Log in as the owner and change the password.
9. **Webhooks:** see below. Then send the WhatsApp number a message and watch it land in the Inbox.
10. **Backups:** `docker compose … logs backup` shows the first dump. Take one on demand with `docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm backup now`.

**Upgrade:** `docker compose … pull && docker compose … up -d --wait`. Migrations are forward-only and additive.
**Rollback:** set `LAVIGO_IMAGE=ghcr.io/aryadev2005/lavigo-os:<previous-sha>` in `.env.prod` and run `up -d` again.
**Restore a backup:** `aws s3 cp s3://<bucket>/backups/postgres/<file>.sql.gz - | gunzip | docker compose … exec -T postgres psql -U lavigo lavigo`, into an empty database.

### Webhooks

**Meta (WhatsApp Cloud API):** in the Meta app, go to WhatsApp → Configuration → Webhook.
- Callback URL: `https://os.lavigo.in/api/webhooks/whatsapp`
- Verify token: the value of `WA_VERIFY_TOKEN`
- Subscribe to `messages`.
- `META_APP_SECRET` must be the **app secret** (App settings → Basic). Every POST is checked with HMAC-SHA256 on the raw body.
- Use a **permanent system-user token** for `WA_ACCESS_TOKEN`, not the 24-hour test token.
- Templates: submit the list in [`docs/META-TEMPLATES.md`](docs/META-TEMPLATES.md) (generated from `prisma/seed.ts`). When Meta approves them, run `pnpm seed:prod --approve-templates`.
- Instagram (`/api/webhooks/instagram`) stays off (`FEATURE_INSTAGRAM=false`) until App Review passes.

**Razorpay:** Dashboard → Accounts & Settings → Webhooks → Add.
- URL: `https://os.lavigo.in/api/webhooks/razorpay`
- Secret: the value of `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment_link.paid`, `payment.captured`

Processing is idempotent, so Razorpay retries are harmless.

### Razorpay: test → live

1. Run the whole flow on `rzp_test_…` keys: a quote, a payment link, paying with a test card, the booking confirmed.
2. Complete Razorpay KYC and activation. Then, in **Live mode**, generate live keys and create the webhook again: live and test webhooks are separate, with separate secrets.
3. In `.env.prod`, set `RAZORPAY_KEY_ID=rzp_live_…`, `RAZORPAY_KEY_SECRET` and the **live** `RAZORPAY_WEBHOOK_SECRET`.
4. Run `docker compose … up -d` to recreate web and worker.
5. Make a ₹1 payment link to yourself, pay it, see the payment land, and refund it from the dashboard.

Links created with test keys stay test links. Send new ones after the switch.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Message blocked with **window closed** | WhatsApp allows free text and quote cards only within 24 h of the customer's last message. Outside it, send an approved template (composer → Template), or wait for the customer to write. |
| **Template not approved** | The template's status isn't APPROVED in Lavigo. Check Meta Business Manager → WhatsApp Manager → Message templates. Once Meta approves, run `pnpm seed:prod --approve-templates`. A rejected template must be fixed in `prisma/seed.ts`, then `pnpm templates:doc`, then resubmitted. |
| Webhook **401** in the logs | Signature mismatch. Meta: `META_APP_SECRET` is not the app secret of the app that owns the number. Razorpay: `RAZORPAY_WEBHOOK_SECRET` is from the other mode (test vs live) or another webhook. A proxy that rewrites the body also breaks it. Fix the env, then `up -d`. Meta and Razorpay retry, and the sweeper re-processes stored events. |
| Meta verify fails | `WA_VERIFY_TOKEN` differs from the token typed into Meta, or DNS/TLS isn't up yet (`curl -I https://os.lavigo.in/api/health`). |
| Container restart-loops with **Refusing to boot in production** | A provider key is missing or weak. The log lists which ones. Fill them in `.env.prod`. |
| **Disk full** | `df -h` and `docker system df`. Run `docker image prune -a` (old images) and `docker builder prune`. Cap container logs in `/etc/docker/daemon.json` (`"log-opts": {"max-size": "20m", "max-file": "3"}`). Backups are in S3, not on disk. Postgres needs free space for WAL: never delete `pgdata`. |
| Login says "Too many attempts" for everyone | Something in front of Caddy (a CDN or load balancer) is making every request come from one IP. Keep Caddy as the only proxy, or configure that hop explicitly. |

## Demo

`FEATURE_SANDBOX=true` turns on `/sandbox`, a customer simulator that drives the same inbox, deal desk and payment flow without WhatsApp. It is off by default in production. For a demo server with no real keys yet, also set `DEMO_FAKES=true`: WhatsApp, Razorpay (a fake checkout at `/dev/pay/…`), SMTP and storage are faked. Never set it on the real deployment.

- `make demo-reset` wipes the dev database and loads the demo seed.
- Against a production-mode stack: `make demo-reset PROD=1 ENV_FILE=.env.prod SEED_DEMO=true FORCE=1`. It is refused without both flags.
- The click-by-click script is [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md). The week-1 list is [`docs/BACKLOG.md`](docs/BACKLOG.md).
