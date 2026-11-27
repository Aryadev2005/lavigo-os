# Every target runs inside containers; the host needs only Docker.
COMPOSE ?= docker compose
RUN     := $(COMPOSE) run --rm --no-deps web
RUNDB   := $(COMPOSE) run --rm web

.PHONY: up down logs sh migrate seed test lint typecheck job inbound build ps reset demo-reset prod-local-env prod-local-up prod-local-seed prod-local-down prod-local-logs check-actions templates-doc

up:            ## start the dev stack (web on :3000, mailpit on :8025, minio console on :9001)
	$(COMPOSE) up -d --build

down:          ## stop the stack (volumes are kept)
	$(COMPOSE) down

logs:          ## follow logs (make logs s=worker for one service)
	$(COMPOSE) logs -f --tail=200 $(s)

ps:
	$(COMPOSE) ps

sh:            ## shell in the web container
	$(COMPOSE) exec web sh || $(RUNDB) sh

migrate:       ## apply/create migrations (prisma migrate dev)
	$(RUNDB) pnpm prisma migrate dev $(args)

seed:          ## load demo data
	$(RUNDB) pnpm seed

test:          ## unit + integration tests
	$(RUNDB) pnpm test

lint:
	$(RUN) pnpm lint

typecheck:
	$(RUN) pnpm typecheck

job:           ## run a scheduled job once: make job name=reminders
	$(RUNDB) pnpm job $(name)

inbound:       ## post a signed fake WhatsApp message: make inbound args='--text "Hi" --from 9835011223'
	$(COMPOSE) exec -T web pnpm -s tsx scripts/simulate-inbound.ts $(args)

build:         ## build the production image locally
	docker build -f docker/Dockerfile -t lavigo-os:local .

reset:         ## DANGER: drop all dev volumes (database, redis, minio, node_modules)
	$(COMPOSE) down -v

check-actions: ## list every server action / route handler and fail on a missing auth or role check
	$(RUN) pnpm check:actions

templates-doc: ## regenerate docs/META-TEMPLATES.md from prisma/seed.ts
	$(RUN) pnpm templates:doc

# ── demo reset ────────────────────────────────────────────────────────
# Wipes EVERY table and loads the full demo seed. Dev stack by default.
# Against a production-mode stack (PROD=1) the seed refuses unless SEED_DEMO=true FORCE=1:
#   make demo-reset PROD=1 ENV_FILE=.env.prod SEED_DEMO=true FORCE=1
PROD_COMPOSE = ENV_FILE=$(or $(ENV_FILE),.env.prod) $(COMPOSE) -f docker-compose.prod.yml $(if $(LOCAL),-f docker-compose.prod.local.yml) --env-file $(or $(ENV_FILE),.env.prod)
demo-reset:    ## DANGER: wipe + full demo seed (see comment above for production)
ifeq ($(PROD),1)
	$(PROD_COMPOSE) run --rm -e SEED_DEMO=$(SEED_DEMO) web pnpm seed $(if $(FORCE),--force)
else
	$(RUNDB) pnpm seed $(if $(FORCE),--force)
endif

# ── local production-mode run (prod image + prod compose, plain HTTP :8080, DEMO_FAKES) ──
LOCAL_PROD = ENV_FILE=.env.prod.local $(COMPOSE) -f docker-compose.prod.yml -f docker-compose.prod.local.yml --env-file .env.prod.local
prod-local-env:  ## write .env.prod.local with random secrets
	sh scripts/prod-local-env.sh

prod-local-up: prod-local-env  ## start the prod stack locally on http://localhost:8080 (run `make build` first)
	$(LOCAL_PROD) up -d --wait

prod-local-seed: ## demo data into the local prod stack (empty DB only) + templates approved
	$(LOCAL_PROD) run --rm -e SEED_DEMO=true web pnpm seed:prod

prod-local-logs:
	$(LOCAL_PROD) logs -f --tail=200 $(s)

prod-local-down: ## stop the local prod stack and DROP its volumes
	$(LOCAL_PROD) down -v
