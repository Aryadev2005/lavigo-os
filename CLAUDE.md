# Lavigo OS: notes for the coding agent

Lavigo OS is an owner and staff operating system for Lavigo Travel Co. (Ranchi). It covers an AI sales inbox on WhatsApp and Instagram, bookings, payments and dues, a supplier rate desk, a tickets desk, departures and campaigns, profit, and AI rules.

## Read first

1. `docs/01-SRS.md`: requirements. IDs like `PRC-2` and `AGT-6` are referenced in commits and tests.
2. `docs/03-system-design.md`: architecture, flows, jobs, security, Docker, CI.
3. `docs/04-database-schema.md` and `prisma/schema.prisma` (copied from `docs/design/schema.prisma`).
4. `docs/reference/lavigo-os-demo.html`: the visual and behavioural reference. Match its look (tokens in its `:root`, Outfit font, layout) and its copy.

## Stack

- Next.js App Router with TypeScript in strict mode.
- Prisma and PostgreSQL 16; BullMQ and Redis 7.
- Auth.js credentials auth.
- Tailwind v4 with shadcn/ui.
- Vitest for tests, plus one Playwright smoke test.
- pnpm on Node 22.

Everything runs in Docker. Do not assume Node exists on the host.

## Commands

All of these run inside containers.

| Command | What it does |
|---|---|
| `make up` | `docker compose up -d` |
| `make migrate` | `docker compose run --rm web pnpm prisma migrate dev` |
| `make seed` | demo data |
| `make test` | `docker compose run --rm web pnpm test` |
| `make lint` / `make typecheck` | |
| `make sh` | shell in the web container |
| `make job name=reminders` | run a scheduled job once |

## Non-negotiable rules

- **Money:**
  - Store and compute money as integer **paise**, and percentages as **basis points**.
  - Never use floats for money.
  - Format only at the edge with `inr()` from `src/server/money.ts`.
- **Dates:**
  - Calendar dates are `@db.Date` and always mean Asia/Kolkata.
  - Use helpers in `src/server/time.ts`; never `new Date().getDate()` on server data.
- **Prices come only from `src/server/domain/pricing`:**
  - The LLM never computes or decides a price.
  - Agent tools re-run the pricing engine and reject disallowed prices.
  - Tool results sent to the model never include cost, floor or margin.
- **Authorization:**
  - Every server action and query enforces auth and role via `requireUser(role?)` in the data layer.
  - Middleware is a convenience, not the guard.
- **Webhooks:**
  - Verify the HMAC on the **raw body** with `timingSafeEqual`.
  - Persist a `WebhookEvent`, enqueue, then return 200.
  - All processing is idempotent through unique keys.
- **Transactions:**
  - Seat holds and payment application run in one transaction.
  - Seat holds lock the departure row with `FOR UPDATE`.
- **External services:**
  - All of them (Meta, Razorpay, Anthropic, SMTP, S3) sit behind an adapter in `src/server/<area>/`.
  - Each adapter has a fake for dev and tests.
  - With empty keys in dev, fall back to the fake. In prod, refuse to boot.
- **Slow work** (LLM calls, provider sends, PDFs) happens in the **worker**, never inside a request.
- **Secrets** live in env only, validated by `src/server/env.ts`. Never log tokens, OTPs or full payloads with PII.
- **Schema changes** are additive migrations only. Never edit an applied migration. If you are one of several parallel sessions, don't change existing models without saying so in your summary.
- **Tests:** write only the ones that protect money, seats, security or the guardrail (see `docs/03-system-design.md` §13). Don't write snapshot tests or trivial UI tests.

## Claude API usage (`src/server/llm`, `src/server/agent`)

- Use the official `@anthropic-ai/sdk`. The model comes from `env.AI_MODEL` (default `claude-opus-5-5`), effort from `env.AI_EFFORT`.
- **Do not** send `thinking: {type:"disabled"}` or `budget_tokens`. Both return a 400 on this model.
- **Do not** force `tool_choice` with `any` or `tool`; that is also a 400. Use `auto`, put `strict: true` on tools, and use schemas with `additionalProperties: false`.
- Do not use assistant prefill.
- Use `cache_control` on the frozen system prompt.
- Enable server-side refusal fallbacks: `client.beta.messages.create({... betas:["server-side-fallback-2026-07-01"], fallbacks:"default"})`.
- Check `stop_reason` before reading `content`: `tool_use`, `end_turn`, `max_tokens`, `refusal`.
- Return **all** `tool_result` blocks in a single user message. Parse tool input as JSON and validate it with zod.
- For operator events (an owner decision, a payment), append a `{role:"system"}` message after the latest user turn. Never mix them into customer text.
- Use structured output (`client.messages.parse` with `zodOutputFormat`) for supplier-quote parsing.
- Tests use the fake client in `src/server/llm/fake.ts`. CI makes no live API calls.

## Style

- Domain code in `src/server/domain/<area>` holds pure functions plus query and mutation functions. UI is RSC by default; client components only for interactivity.
- Commits follow conventional commits and reference SRS IDs, e.g. `feat(pricing): evaluatePrice decisions (PRC-1, PRC-2)`.
- At the end of each task, print a short summary: what works, what is stubbed or faked, and any deviation from the docs and why.
