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

`.github/workflows/ci.yml` runs three stages:

1. **quality:** lint, typecheck, `prisma validate`.
2. **test:** Postgres + Redis services, migrations, a migration drift check, vitest.
3. **docker build:** pushes to GHCR, on `main` only.

An e2e job, currently a stub, runs on `main` or on manual dispatch. CI needs no secrets.
