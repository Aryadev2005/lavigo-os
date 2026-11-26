# Every target runs inside containers; the host needs only Docker.
COMPOSE ?= docker compose
RUN     := $(COMPOSE) run --rm --no-deps web
RUNDB   := $(COMPOSE) run --rm web

.PHONY: up down logs sh migrate seed test lint typecheck job build ps reset

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

build:         ## build the production image locally
	docker build -f docker/Dockerfile -t lavigo-os:local .

reset:         ## DANGER: drop all dev volumes (database, redis, minio, node_modules)
	$(COMPOSE) down -v
