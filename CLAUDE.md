# Lavigo OS: notes for the coding agent

Lavigo OS is an owner and staff operating system for Lavigo Travel Co. (Ranchi). It covers a shared WhatsApp and Instagram inbox with a deal desk (quotes, owner approvals, payment links), bookings, payments and dues, a supplier rate desk, a tickets desk, departures and campaigns, profit, and pricing rules.

**v1 has NO AI/LLM features.** The AI sales agent and every LLM use are v2 (SRS §1.1). Where the demo says "AI", v1 is staff-operated or rule-based.

## Read first

1. `docs/01-SRS.md`: requirements. IDs like `PRC-2` and `DESK-3` are referenced (`AGT-*` are v2, do not build) in commits and tests.
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
  - Every server action that writes a price (quotes, bookings, approvals) re-runs `evaluatePrice` + `canQuote` on the server. A client-sent price is only an input, never trusted.
  - Floor, cost and margin never reach a STAFF session (RSC props or action responses); use `forRole()`.
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
  - All of them (Meta, Razorpay, SMTP, S3) sit behind an adapter in `src/server/<area>/`.
  - Each adapter has a fake for dev and tests.
  - With empty keys in dev, fall back to the fake. In prod, refuse to boot.
- **Slow work** (provider sends, payment-link creation, PDFs) happens in the **worker**, never inside a request.
- **Secrets** live in env only, validated by `src/server/env.ts`. Never log tokens, OTPs or full payloads with PII.
- **Schema changes** are additive migrations only. Never edit an applied migration. If you are one of several parallel sessions, don't change existing models without saying so in your summary.
- **Tests:** write only the ones that protect money, seats, security or pricing rules (see `docs/03-system-design.md` §13). Don't write snapshot tests or trivial UI tests.

## AI / LLM: v2 only (do not build in v1)

- Do **not** add `@anthropic-ai/sdk` or any LLM dependency. Add no `ANTHROPIC_*` or `AI_*` env vars, and create no `src/server/agent` or `src/server/llm` directories.
- AI-only schema fields and tables (`AgentRun`, `AgentStep`, `Conversation.aiMode`, `AgentSettings` AI toggles) stay in the schema, **unused**. Don't remove them and don't write to them.
- Build v1 so v2 can plug in. Quote, approval and payment-link logic lives in `src/server/domain/deals` as plain functions that a future agent tool can call. The supplier parser keeps the signature `parseSupplierReply(text, rfqContext)`.
- The v2 design is in `docs/03-system-design.md` Appendix A. It's for reference only.

## Style

- Domain code in `src/server/domain/<area>` holds pure functions plus query and mutation functions. UI is RSC by default; client components only for interactivity.
- Commits follow conventional commits and reference SRS IDs, e.g. `feat(pricing): evaluatePrice decisions (PRC-1, PRC-2)`.
- At the end of each task, print a short summary: what works, what is stubbed or faked, and any deviation from the docs and why.
