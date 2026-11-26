# Lavigo OS — Build Prompts for Claude Code

**How to use this file:**

- Paste one prompt per Claude Code session, in order. Every prompt assumes the repo already contains `CLAUDE.md` and `docs/`.
- Prompts marked **∥** can run as **parallel sessions in separate git worktrees** once their dependency has merged.
- After each session, run that phase's **review gate** below, or paste the session's summary back to me to review.

## Schedule (Thu 26 → Sat 28 Nov morning)

| Slot | Session(s) | Depends on |
|---|---|---|
| Thu AM | **P0** Foundation: Docker, CI, schema, seed, auth, shell | — |
| Thu midday | **P1** Domain core: pricing, inventory, bookings, payments | P0 |
| Thu PM | **P2** ∥ Today + Bookings + Dues + reminders · **P3** ∥ Channels + Inbox UI + realtime | P1 |
| Fri AM | **P4** AI agent + approvals | P3 (and P1) |
| Fri midday | **P5** ∥ Supplier desk · **P6** ∥ Tickets desk · **P7** ∥ Departures + campaigns + Profit + AI rules | P1 (P5 also needs P3 channels) |
| Fri PM | **P8** Hardening, e2e smoke, prod compose, demo rehearsal | all |
| Sat AM | Deploy, run the SRS §8 acceptance script with the client | P8 |

**Thursday, outside the code (owner/PM, start now; these have lead times):**

1. Meta Business verification, the WhatsApp number, and submission of the 8 templates in `03-system-design.md` §7.
2. Razorpay test keys and webhook secret.
3. VPS and domain.
4. Anthropic API key.

---

## P0 — Foundation

```text
You are building Lavigo OS from an empty repo. Read CLAUDE.md, docs/01-SRS.md, docs/03-system-design.md (§3, §4, §11, §12, §13), docs/04-database-schema.md, and skim docs/reference/lavigo-os-demo.html (the visual reference).

Goal: a running skeleton where `make up && make migrate && make seed` gives a logged-in app shell that looks like the demo, and CI is green.

Do:
1. Scaffold Next.js (latest stable, App Router, TypeScript strict, src/ dir, ESLint) with pnpm. Pin exact versions in package.json. Add Tailwind v4 + shadcn/ui. Port the demo's :root tokens (--ink, --lav, --ok, --warn, --bad, etc.) to CSS variables and Tailwind theme; Outfit via next/font/google; extract the embedded Italiana font and the 4 departure images + logo from the demo HTML into public/ (write a small one-off script in scripts/extract-demo-assets.ts, don't hand-copy base64).
2. Docker (no host Node needed):
   - docker/Dockerfile.dev, docker-compose.yml with web, worker, postgres:16, redis:7, minio (+ one-shot bucket creation), mailpit. node_modules and pnpm store in named volumes. Healthchecks. TZ=Asia/Kolkata on web/worker.
   - docker/Dockerfile multi-stage prod image (standalone Next + bundled worker via tsup, non-root, node:22-bookworm-slim).
   - Makefile with: up, down, logs, sh, migrate, seed, test, lint, typecheck, job.
3. src/server/env.ts (zod; dev falls back to fakes when provider keys are empty; prod requires them), db.ts, redis.ts, queue.ts (BullMQ helpers), pubsub.ts, logger.ts (pino, redaction), money.ts (paise/bps helpers + inr()), time.ts (IST helpers), audit.ts.
4. Copy docs/design/schema.prisma → prisma/schema.prisma. Create the initial migration and append the raw SQL from docs/04-database-schema.md (booking_code_seq starting 24901, pg_trgm + trigram indexes).
5. prisma/seed.ts exactly per docs/04-database-schema.md "Seed data": dates relative to run date; demo bookings, departures, conversations, offers, add-ons, suppliers, travel plans + fare snapshots, expenses for 3 custom trips, activity events, 6 months of payments, AgentSettings singleton, 5 ReminderRules, 8 MessageTemplates. Owner + staff users with argon2id hashes (passwords from SEED_* env or printed random).
6. Auth.js v5 credentials (email+password, argon2id), JWT session with role, login page styled like the demo, login rate limit in Redis (AUTH-2), requireUser(role?) helper in src/server/rbac.ts.
7. App shell at src/app/(app)/layout.tsx: sidebar (brand, nav with badge slots, "AI agent is online" box, footer "Lavigo Travel Co. · Ranchi / Owner view"), sticky top bar (title + subtitle per page, search input, bell, avatar), mobile horizontal nav < 900px, toast system. Create placeholder pages for today, inbox, bookings, dues, supplier, tickets, departures, profit, rules, sandbox — each with the correct title/subtitle from the demo's meta() strings. Profit and rules are OWNER-only (staff see 403 page).
8. /api/health (DB + Redis check). src/worker/index.ts boots, registers no-op queues, shuts down gracefully.
9. .github/workflows/ci.yml exactly per docs/03-system-design.md §13 (quality → test with postgres+redis services and migration drift check → docker build; push to GHCR only on main; e2e job stubbed and only on main/workflow_dispatch). Add .github/dependabot.yml (npm + github-actions, weekly).
10. .env.example (from §11), .gitignore, .dockerignore, README.md with quick start (Docker only) and the disk-usage note from §12.

Tests in this phase: only a trivial vitest sanity test so the pipeline runs; real tests come with real logic.

Done when: `make up && make migrate && make seed` works on a clean machine; login works for both roles; all nav pages render with demo styling; `pnpm lint && pnpm typecheck && pnpm test` pass in the container; CI YAML is valid. Commit in logical chunks (conventional commits). Print the summary required by CLAUDE.md.
```

**Review gate P0**

- [ ] `docker compose config` is valid. There are no bind mounts of `node_modules` to the host.
- [ ] `prisma migrate diff` shows no drift. The sequence and trigram SQL is present in the migration.
- [ ] The seed counts match: Nepal 21/30, Netarhat 12/18, Darjeeling 10/24, Sikkim 3/20, plus 8 named bookings.
- [ ] Staff hitting `/profit` gets 403 from the server, not just a hidden link.
- [ ] `env.ts` fails in `NODE_ENV=production` with empty keys.
- [ ] The CI file has `concurrency`, service healthchecks, and pushes only on `main`.

---

## P1 — Domain core: pricing, inventory, bookings, payments

```text
Read CLAUDE.md, SRS §4.3, §4.5, §4.6 and system design §5.2, §5.3, §8.

Goal: the money/seat core, fully tested, with no UI except what's needed to exercise it.

Do:
1. src/server/domain/pricing (PURE, no DB): evaluatePrice({departure:{pricePerPax,costPerPax,startDate}, pax, isRepeatCustomer, today, settings, offers, requestedPricePerPax?}) → {listPrice, appliedOffers, autoOffer, floor, autonomyLimit, suggestedCounter, counterPlus100, marginBpsAt(price), decision}. Rules: floor = ceil to ₹10 of cost/(1−m); A = list − best single eligible offer (no stacking — make stacking a settings flag defaulting false); L = max(F, A − solo); suggestedCounter = smallest price ≥ F ending in settings.charmEnding; decision per SRS PRC-2; LARGE_GROUP when pax ≥ escalateGroupSizeAtLeast. Also export toModelView(result) that strips floor/cost/margin (AGT-5).
2. src/server/domain/inventory: seatsTaken(departureId), holdSeats(tx, {departureId, pax}) using SELECT … FOR UPDATE (raw SQL) — throws SeatsUnavailable; releaseHold.
3. src/server/domain/bookings: nextBookingCode() from booking_code_seq; createBooking (FIXED or CUSTOM; validates price via pricing; staff can't go below L, owner below F only with confirmBelowFloor=true + audit); confirm; cancel (releases seats); addTravellers. Hold expiry: enqueue hold.expire delayed job at holdExpiresAt; job re-checks inside txn.
4. src/server/payments/razorpay.ts adapter (createPaymentLink, verifyWebhookSignature) + fake adapter (returns `${APP_URL}/dev/pay/{id}`; the dev page has a "Pay" button that calls scripts' simulate logic). Use the official `razorpay` npm package or plain fetch — your call, but signature verification is our own HMAC code with timingSafeEqual.
5. src/server/domain/payments: createLink(bookingId, purpose) (ADVANCE = round-half-up to the rupee of total × advancePct; reuse an open link for the same purpose); applyPaymentEvent(event) — the single transaction from system design §5.2 incl. the expired-hold edge case; recordManualPayment (audit).
6. /api/webhooks/razorpay route: raw body, verify, WebhookEvent insert ON CONFLICT DO NOTHING, enqueue payment.apply, 200. Worker job payment.apply. After commit: enqueue invoice.render + activity event + publish SSE "booking.updated".
7. src/server/pdf: invoice.tsx (GST-inclusive breakup from settings.gstRateBps: taxable = total / (1+r); CGST/SGST split; Lavigo details placeholders), receipt, itinerary (from Trip.itinerary). Worker job invoice.render stores to S3 (src/server/storage/s3.ts with presigned GET) and creates Document + Invoice. /api/files/[id] route: auth + RBAC → 302 to 5-min presigned URL.
8. scripts/simulate-payment.ts: signs a realistic payment_link.paid payload with RAZORPAY_WEBHOOK_SECRET (or dev default) and POSTs it.

Tests (these are the important ones — write them well):
- tests/unit/pricing.test.ts: the SRS §4.3 worked example verbatim (F=13,140; A=13,499; L=13,499; BELOW_FLOOR; suggested 13,199; counter 13,299; margin 17.4%), plus: each decision band boundary (r = A, A−1, L, L−1, F, F−1), early-bird eligibility at exactly 45 days, repeat traveller, solo discount moving L, floor change 20% shifting F, large group, toModelView has no cost/floor/margin keys.
- tests/unit/razorpay-verify.test.ts: valid sig, tampered body, wrong secret, missing header.
- tests/integration/payment-webhook.test.ts (real Postgres): same event twice → one Payment; two different events for same payment id → one Payment; paidAmount and CONFIRMED correct; payment for expired hold re-holds or flags.
- tests/integration/seat-hold.test.ts: 10 concurrent holdSeats for the last 6 seats → exactly one succeeds.

Done when: all tests pass in the container and CI; `make up`, create a HELD booking via a temporary dev-only server action or script, run simulate-payment → booking CONFIRMED, invoice PDF downloadable via /api/files. Summary per CLAUDE.md.
```

**Review gate P1**

- [ ] No `number * 0.x` on money without `Math.round` in paise. Grep for `parseFloat` and `toFixed` in `src/server`.
- [ ] `FOR UPDATE` is actually inside the same `$transaction` callback as the insert.
- [ ] The signature is computed on the raw body, not on re-serialised JSON. `timingSafeEqual` is used with a length check.
- [ ] The webhook returns 200 for duplicates and 401 for bad signatures, and never 500 on duplicates.
- [ ] `toModelView` is the only thing the agent will ever import from pricing results.

---

## P2 ∥ — Today, Bookings, Payments & dues, reminder scheduler

```text
Read CLAUDE.md, SRS §4.2, §4.5, §4.6, design §8 (reminders.daily), and the demo's today(), bookings(), openBk(), dues() functions for exact layout and copy.

Goal: three screens on real data, matching the demo pixel-for-pixel where reasonable.

Do:
1. src/server/domain/dashboard: getKpis(today), getNeedsYou(today) (compose from: pending approvals, RFQs ready to compare, bookings ≥7 days late, fare alerts, low-seat departures with matching past-customer count — leave RFQ/fare/approval sources returning [] behind clear TODO-free interfaces if their tables are empty; they'll fill once other phases land), getActivity(limit), getCollectedByMonth(6), getUpcomingDepartures().
2. Today page: 4 KPI tiles, Needs you list with per-item action, Live activity (SSE-driven; subscribe via a useEvents() hook + /api/stream route — if P3 hasn't landed /api/stream yet, implement it here per design §9 and P3 will reuse it), 6-month bars (Recharts or plain CSS like the demo), upcoming departures with fill bars. Greeting by IST time of day ("Good evening, Lavigo").
3. Bookings page: table + filter chips + row click → drawer (summary, profit on booking, journey timeline derived from real data, actions: Send balance link [uses payments.createLink + channels outbound if available, else toast "link created" with copy button], Invoice PDF, Itinerary PDF, Send vouchers [disabled with tooltip until P5]). "+ New booking" sheet: customer search/create, departure or custom, pax, price (live pricing validation message), travellers, optional advance (manual payment or create link). Record manual payment, cancel booking (owner-only confirm).
4. Dues page: 4 aging cards (Not due yet, 1–7 days late, 8+ days late, Collected this week), "Who owes you" table sorted by lateness with reminder counts from ReminderLog and per-row "Send link", "Remind everyone late", reminder rule toggles (persisted, audit), preview bubble rendered from the payment_reminder template with the most-late customer's real data.
5. src/server/domain/dues: planReminders(bookings, rules, today) PURE → list of {bookingId, ruleKey, action}; runReminders() executes via outbound (template when window closed) and writes ReminderLog idempotently; FLAG_OWNER creates a Needs-you entry (via the query, no table); RELEASE_SEATS cancels HELD/unpaid-advance bookings N days before travel only when enabled. Register reminders.daily repeatable at 10:00 IST. `make job name=reminders` runs it once.
6. Sidebar badges wired: dues = late count, inbox = pending approvals (0 until P4).
7. Global search (top bar): customers by name/phone, bookings by code (pg_trgm), results dropdown.

Tests: tests/unit/dues-planner.test.ts — each rule fires on the right day, not the day before/after; paid-in-full bookings never get reminders; running twice yields no duplicates (integration-level check on ReminderLog unique). Nothing else.

Done when: Today/Bookings/Dues show seed data matching the demo numbers; send-link works end-to-end with the fake Razorpay; reminders job is idempotent. Summary per CLAUDE.md.
```

**Review gate P2**

- [ ] The KPI math matches SRS TOD-1. Late days are computed in IST dates.
- [ ] The reminder job run twice produces zero new `ReminderLog` rows.
- [ ] The drawer's profit equals `(pricePerPax − costPerPax) × pax`, or uses actual costs where they exist.
- [ ] No client component imports `src/server/*`.

---

## P3 ∥ — Channels, inbox UI, realtime, sandbox

```text
Read CLAUDE.md, SRS §4.4 (INB-*), design §7, §9, §10 and the demo's inbox(), renderMsgs(), renderPanel().

Goal: messages flow in and out through WhatsApp (Cloud API), Instagram (flagged), and the in-app Sandbox, and the inbox UI shows them live. No AI yet — the composer lets the owner reply manually.

Do:
1. src/server/channels/types.ts (ChannelAdapter interface from design §7), verify.ts (Meta X-Hub-Signature-256, timingSafeEqual), whatsapp.ts (text, CTA URL interactive, template, document, media download with host allowlist), instagram.ts (text + media download; behind FEATURE_INSTAGRAM), sandbox.ts, fake WhatsApp adapter for dev (logs + marks SENT).
2. Webhooks: /api/webhooks/whatsapp (GET verify challenge with WA_VERIFY_TOKEN; POST verify → WebhookEvent per message/status id → enqueue inbound.process → 200), /api/webhooks/instagram likewise.
3. src/server/domain/conversations: ingestInbound(normalized) — dedupe by externalId; if the sender phone matches a Supplier → supplier conversation + enqueue rfq.parseReply (job can be a no-op until P5); else upsert Customer + Conversation (store WA referral → sourceNote), save Message, bump lastInboundAt/unread, publish SSE, emit hook `onCustomerMessage(conversationId)` (P4 will enqueue agent.reply there; for now no-op). Status webhooks update Message.status.
4. src/server/channels/outbound.ts: send(conversationId, payload) → creates Message (QUEUED) → outbound.send job → adapter → SENT/FAILED; 24h window policy (BLOCKED WINDOW_CLOSED for free text); global limiter. sendTemplate path for callers.
5. /api/stream SSE (if not already created by P2): auth, Redis pub/sub, heartbeat; useEvents() client hook.
6. Inbox UI per demo: 3-column layout (list with tabs All/Needs you/Paid/Follow-up and status pills; WhatsApp-style thread with AI/You tags, system notes, quote card + payment-link card renderers driven by Message.kind/payload, ✓/✓✓ from status; right panel with Lead section and placeholder Deal guardrail + What the AI did sections that P4 fills). Composer sends as OWNER and auto-takes-over (aiMode PAUSED); "Take over"/"Hand back to AI" toggle (audit). Window-closed state shows a template picker instead of free text. Responsive per demo breakpoints.
7. /sandbox page: pick or create a sandbox customer (name, phone), chat as the customer on the left, see the real inbox thread on the right. Uses ingestInbound with channel SANDBOX. This is our demo fallback — make it solid.
8. scripts/simulate-inbound.ts: signs and posts a realistic WhatsApp inbound payload.

Tests: tests/unit/meta-verify.test.ts (valid/invalid/missing signature); tests/integration/inbound-dedupe.test.ts (same wamid twice → one Message; supplier phone routes to supplier conversation; window policy blocks free text after 24h). Nothing else.

Done when: simulate-inbound shows a new conversation live in the inbox without refresh; owner reply goes out via fake adapter; sandbox round-trip works; with real WA credentials (if available) a message to the test number appears. Summary per CLAUDE.md.
```

**Review gate P3**

- [ ] The webhook route reads `await req.text()` before any JSON parse. The GET verify handler compares the token in constant time.
- [ ] Media download refuses non-allowlisted hosts and redirects to other hosts.
- [ ] A supplier phone never reaches `onCustomerMessage`.
- [ ] SSE requires a session, and the `events` payloads contain no PII beyond what the UI shows.

---

## P4 — AI sales agent and approvals

```text
Read CLAUDE.md (Claude API section), SRS §4.3 and §4.4 (AGT-*), design §5.1 and §6 fully. Use the official @anthropic-ai/sdk. Model from env.AI_MODEL (default claude-opus-5-5), effort from env.AI_EFFORT (default "low"). Do NOT send thinking:disabled or budget_tokens; do NOT force tool_choice; tools use strict:true with additionalProperties:false; enable server-side fallbacks (betas ["server-side-fallback-2026-07-01"], fallbacks "default"); cache_control on the system prompt; handle stop_reason tool_use / end_turn / max_tokens / refusal; return all tool_results in one user message.

Goal: the demo's Riya flow works for real on the Sandbox (and WhatsApp when credentials exist), with the owner approving in one tap.

Do:
1. src/server/llm/anthropic.ts (client factory) and src/server/llm/fake.ts (scripted fake that returns queued responses — used by tests; supports tool_use blocks).
2. src/server/agent/prompt.ts — the frozen system prompt per design §6.3 (persona from settings is injected via the first user-turn context block, not the system prompt, to keep the cache prefix stable). Write it carefully in plain English; include 3 short Hinglish style examples.
3. src/server/agent/tools.ts — the 10 tools in design §6.2 with zod schemas → JSON schema (strict), handlers bound to {conversationId, customerId} from job context. send_quote and create_payment_link re-validate via pricing + approvals. evaluate_price returns pricing.toModelView only. Each handler returns {label} for AgentStep ("Applied your 6+ group offer", "Checked floor, escalated to you", …).
4. src/server/agent/policy.ts — outbound filter per design §6.4 (money extraction incl. "12,500", "Rs 12500", "12.5k", "₹12,500/-"; issued-price set from Quote/AgentStep outputs/PaymentLink/Approval for this conversation; URL allowlist).
5. src/server/agent/context.ts — DB history → messages (customer=user, AI/owner outbound=assistant text; system notes excluded; merge consecutive same-role turns); operator events appended as {role:"system"} after the last user turn.
6. src/server/agent/run.ts — loop per design §6.1: Redis lock, gates (aiMode, hours, daily cap 30, hourly token guard, AI_ENABLED, party is customer, window open), max 6 iterations, persist AgentRun/AgentStep, typing indicator via SSE ("ai.typing"), on refusal/max_tokens/errors → approval OTHER + owner alert + no customer message. Wire onCustomerMessage → agent.reply job with 4s debounce (jobId per conversation, replace on new inbound).
7. src/server/domain/approvals: create (from tool), decide(approvalId, {action: approve|counter|decline, price?}, user) — OWNER only; below-floor approve requires confirmBelowFloor + audit; enqueue agent.reply trigger approval_decided with operator system message; expire job (quote validity). Owner alert: SSE toast + sidebar badge + WhatsApp `owner_approval` template to User.phone (best-effort).
8. Inbox right panel (finish P3 placeholders): Deal guardrail meter exactly like the demo (offer marker, asked marker, floor label, margin at current offer colored vs floor, "AI can give alone"), approval card with Approve ₹suggested / Counter ₹suggested+100 / Decline, Result block after booking, "What the AI did" from AgentStep labels. Show floor/margin here (owner UI) — never to the model.
9. /approvals/[id] mobile-first page (deep link target): the same card, big buttons.
10. Follow-ups: followups.scan hourly — QUOTED conversations with no inbound for 20h (window still open) → one gentle free-text nudge via the agent (trigger follow_up); at 72h use the follow_up template only if marketingOptIn.
11. On payment_received (from P1's payment.apply) → enqueue agent.reply trigger payment_received so the AI sends the thank-you message from the demo.
12. scripts/agent-eval.ts — manual, real-API eval of the 10 scenarios in design §6.6 against the Sandbox; asserts on tool calls/decisions; prints token cost. NOT run in CI.

Tests (fake LLM, real DB):
- tests/unit/policy.test.ts: every money format; issued vs non-issued; URL allow/deny.
- tests/integration/agent-guardrail.test.ts: (a) fake model calls send_quote at 12,500 with no approval → PRICE_NOT_ALLOWED, no Quote; (b) after owner approves 13,199, send_quote 13,199 succeeds, 13,000 still fails; (c) evaluate_price tool_result JSON contains no cost/floor/margin keys or values (search for 10900, 13140); (d) final text containing an unissued "₹9,000" is BLOCKED and not sent; (e) aiMode PAUSED → run SKIPPED; (f) two inbound messages within 4s → one run.

Done when: on /sandbox the SRS §8 steps 2–6 and 12 work end-to-end with a real ANTHROPIC_API_KEY (and with AI_ENABLED=false the app still works, showing "AI paused" in the sidebar). Run scripts/agent-eval.ts once and paste the summary. Summary per CLAUDE.md.
```

**Review gate P4** *(the most important review: send me the diff and the eval output)*

- [ ] grep: no `costPerPax`, `floor` or `marginBps` reachable from any `tool_result` builder.
- [ ] The system prompt has no dynamic content (no dates, names or prices), so `cache_read_input_tokens` > 0 from the second run on.
- [ ] Operator messages are built only by our code paths (approval decide, payment), never from user text.
- [ ] Every failure path (refusal, max_tokens, tool exception, policy block) results in **no customer-visible message** plus an owner alert.
- [ ] Run caps and the token guard exist and are tested or at least exercised.
- [ ] Eval: the prompt-injection scenario never produces a price below F or a confirmation.

---

## P5 ∥ — Supplier desk

```text
Read CLAUDE.md, SRS §4.7, DFD Level 2 — 6.0, design §6.5, and the demo's supplier(), sendRfq(), pick().

Goal: real RFQ fan-out, real reply capture and parsing, compare, book.

Do:
1. Supplier directory (CRUD sheet from the Supplier desk page; owner/staff).
2. New rate request form per demo (destination select from supplier destinations + departures, check-in, nights, rooms, category, meal plan, "Send to" chips preselected by destination, baseline "Your usual rate here" prefilled from departure.usualRoomRate or last BOOKED quote for destination+category, editable).
3. Send: rfq.send job per recipient — WhatsApp via `rfq_request` template (outbound.sendTemplate) or email via SMTP (src/server/email/smtp.ts, nodemailer; dev → Mailpit). Recipient row status "Sent on WhatsApp · waiting" with animated dots.
4. Replies: rfq.parseReply job (hooked from P3's supplier routing) — match the latest SENT RFQ for that supplier; parse with client.messages.parse + zodOutputFormat(SupplierQuoteSchema) per design §6.5; create SupplierQuote (AI_PARSED, confidenceBps); decline detection; SSE update. "Add quote" manual sheet: paste text → same parser, or type values (MANUAL).
5. Quotes table per demo: rate/room/night, total for rooms×nights, replied-in (repliedAt − sentAt), best row highlight (lowest non-declined), savings banner ((baseline − best) × rooms × nights and % cheaper), non-responders listed with "AI will nudge in Xh". rfq.nudge cron (*/15) — one nudge after 2h, NO_REPLY after 24h.
6. Book: quote BOOKED, others REJECTED, RFQ BOOKED, Expense HOTEL (linked departure), confirmation message to supplier, activity event. Enables "Send vouchers" in Bookings drawer: voucher PDF (src/server/pdf/voucher.tsx) per booking for that departure, sent via outbound.sendDocument.
7. Needs-you source: "N hotel quotes in for <dest>, <date> · Best ₹X/room/night, Y% below your usual rate" when all recipients replied or timed out.

Tests: tests/unit/rfq-compare.test.ts (best selection ignoring declines, savings math in paise, replied-in formatting). Parser: one test with the fake LLM verifying schema handling of a null rate → "could not read". Nothing else.

Done when: sending an RFQ to the 6 seeded suppliers, then running scripts/simulate-inbound.ts from 5 supplier phones with replies like "2150 per room, breakfast incl." fills the table, highlights Himalayan Stays, shows the savings banner, and Book creates the expense. Summary per CLAUDE.md.
```

**Review gate P5**

- [ ] The parse never runs on customer conversations.
- [ ] Low-confidence quotes are visibly flagged and are never auto-selected as best without the flag.
- [ ] Email bodies are escaped, with no HTML injection from supplier names.

---

## P6 ∥ — Tickets desk

```text
Read CLAUDE.md, SRS §4.8, DFD Level 2 — 7.0, and the demo's tickets(), tkBody(), tkBook().

Goal: the Tickets desk on real data with manual fares (FareProvider interface for later portal integration).

Do:
1. src/server/domain/tickets (PURE where possible): landed(option), rankOptions(options, budget, pax) → sorted + best (cheapest non-disqualified) + extraProfit; windowOpensAt(travelDate, arpDays) at 08:00 IST; fareAlert(snapshots) (≥5% rise over 14 days); pnrSplit(bookingsWithTravellers, max=6) — first-fit decreasing, families kept together, oversize bookings split into consecutive tickets, stable ordering; irctcPassengerText(group).
2. FareProvider interface + ManualFareProvider; editing a fare writes a FareSnapshot.
3. UI per demo: 3 alert cards (train window, fare rising, new travellers need tickets — all computed), plan chips, options table ("Ranked by real cost, not ticket price", hidden extras, real cost/person, vs budget ±, Book), fare trend SVG with budget line (no prediction line — SRS TKT-4), right preview panel (budget × pax, best option, extra profit), booking plan card with "Copy passenger list & open IRCTC" (copies text, opens irctc.co.in in new tab), "How booking works" card. CRUD for plans/options (sheet). Plans auto-derive pax from bookings on the departure.
4. Confirm booking modal per demo → enter PNR(s) per ticket group, upload ticket PDF(s) (S3, mime/size checks), mark BOOKED, TICKETS Expense = ticket × pax, send PDFs to the lead traveller of each booking via outbound.sendDocument, activity event.
5. tickets.windowReminders cron: notify owner (in-app + WA template if configured) at T−1 21:00 and T 07:45 IST; Needs-you items for fare alerts and windows within 7 days.

Tests: tests/unit/tickets.test.ts — rank: Goa seed → IndiGo via Mumbai best, Delhi-midnight not best despite cheapest ticket, train disqualified; extraProfit = (9,500 − 7,850) × 4 = 6,600; pnrSplit: [4,3,6,2,7,1] → no group > 6, each booking ≤ 6 kept whole, 7 split 6+1; windowOpensAt for a 9 Jan travel date with ARP 60 = 10 Nov 08:00 IST; fareAlert threshold.

Done when: all three seeded plans render like the demo; booking a plan updates the profit expense; PNR split matches tests. Summary per CLAUDE.md.
```

**Review gate P6**

- [ ] The extra-profit numbers match the demo (Goa +₹6,600).
- [ ] Uploads are validated by magic bytes, not just the extension.
- [ ] There's no IRCTC scraping or automation anywhere.

---

## P7 ∥ — Departures, campaigns, Profit, AI rules

```text
Read CLAUDE.md, SRS §4.9, §4.10, §4.11 and the demo's departures(), fill(), profit(), rules(), prev().

Do:
1. Departures page per demo: cards with hero image + Italiana title, status pill rules (DEP-1), fill bar, revenue, buttons. Trip/Departure CRUD (sheet) incl. itinerary editor (list of days), inclusions, travel budget, usual room rate.
2. Fill seats with AI: src/server/domain/departures/audience.ts — past travellers (COMPLETED/CONFIRMED bookings on other departures, tag overlap with trip tags if any), unconverted enquiries (conversations mentioning this trip/destination or with interestedDepartureId, no booking, last 180 days), waitlist; dedupe; split into opted-in vs skipped. Panel shows "AI found N people likely to book" with reasons, message preview rendered from the `seat_offer` template with real values (seats left, date, optional discount + validity), "Send to N people" → Campaign + recipients → campaign.send rate-limited job via outbound.sendTemplate. Attribution: on booking confirmed, if customer is a recipient of a campaign for that departure sent within 7 days → set convertedBookingId; card shows "+N from this campaign". No fake simulated bookings.
3. Traveller list CSV export (server route with auth); Send document checklist (doc_checklist template to lead travellers).
4. Profit page (OWNER only) per demo: KPI row, table per departure + custom bookings — revenue, cost (actual if Expense rows exist else planned, with a small "planned"/"actual" badge), profit, margin bar (amber < 20%), lowest-margin callout.
5. AI rules page (OWNER only) per demo: sliders and toggles bound to AgentSettings and Offer rows, editable offer amounts, "Always send to you" chips (group size editable), live preview computed by calling the SAME pricing.evaluatePrice (server action or a shared pure import) on the Nepal departure for 6 pax — must read "can go down to ₹13,499 … between ₹13,499 and ₹13,140 it asks you … below ₹13,140 never" with seed defaults. Save → audit log → SSE so open inboxes re-render the guardrail meter.

Tests: tests/unit/audience.test.ts (opt-in exclusion, dedupe across reasons). Profit math is covered by reusing tested helpers — add one test only if you introduce new math.

Done when: all three screens match the demo with seed data; floor slider to 20% changes the preview to floor ₹13,630 (10,900/0.8 = 13,625 → ceil ₹10 = 13,630) and the next agent decision. Summary per CLAUDE.md.
```

**Review gate P7**

- [ ] Staff can't reach the profit or rules server actions (check the actions, not just the pages).
- [ ] Campaign send excludes customers without `marketingOptIn`.
- [ ] The rules preview and the agent share one pricing function. No duplicated formula in the UI.

---

## P8 — Hardening, e2e smoke, production deploy, demo rehearsal

```text
Read CLAUDE.md, SRS §5, §8, design §10, §12, §14.

Do:
1. Security pass (fix, don't just report): run through design §10 table and verify each control exists in code; add CSP + security headers in next.config; check every server action has requireUser with the right role (write a small script that lists actions and flags missing guards); ensure no secrets/PII in logs (redaction paths); file route IDOR check; upload validation; rate limits on login and sandbox. Run `pnpm audit --prod` and fix high/critical where a patch exists.
2. Error UX: global error boundary, toasts on action failures, empty states for every table, loading skeletons on Today and Inbox.
3. tests/e2e/smoke.spec.ts (Playwright, --trace off): login as owner → Today KPIs visible → /sandbox send "Nepal 28 Nov rate?" with the FAKE LLM scripted to the Riya flow (env AI_FAKE_SCRIPT=riya) → approval appears → approve → payment link message → run simulate-payment → booking CONFIRMED in Bookings, Nepal seats +6. Wire the CI e2e job to run it against the built image with fakes.
4. docker-compose.prod.yml + docker/Caddyfile per design §12/§14 (migrate one-shot, backup sidecar with daily pg_dump to MinIO, restart policies, only Caddy exposed). `pnpm seed:prod` (owner, settings, rules, templates; demo data only if SEED_DEMO=true).
5. README: deploy runbook (design §14), webhook setup steps for Meta and Razorpay, "switching from test to live", troubleshooting (window closed, template not approved, webhook 401s).
6. docs/DEMO-SCRIPT.md: the SRS §8 acceptance steps as a click-by-click script for Saturday, including the Sandbox fallback if WhatsApp isn't approved yet and how to reset demo data (`make demo-reset`: truncate + seed).

Done when: CI fully green including e2e on main; `docker compose -f docker-compose.prod.yml up -d` on a fresh VPS serves HTTPS; SRS §8 steps 1–12 pass on the deployed instance. Summary per CLAUDE.md with a list of known issues for the post-delivery backlog.
```

**Review gate P8**

- [ ] I run SRS §8 myself on the deployed URL.
- [ ] The prod `.env` has no dev fallbacks active (fakes disabled); the boot log shows real adapters.
- [ ] A backup file appears in object storage, and a restore was tried once.

---

## Post-delivery templates (bug fixes and client improvements)

**Bug fix**

```text
Bug: <what the client saw, exact screen, steps, expected vs actual, screenshot/log>.
Read CLAUDE.md first. Reproduce it with a failing test only if the bug touches money, seats, security, webhooks, or the AI guardrail; otherwise reproduce manually and describe how. Find the root cause (explain it in 2–3 sentences before changing code), fix it minimally, keep migrations additive, run lint/typecheck/tests in the container, and commit as `fix(<area>): <summary> (<SRS id if any>)`. Summary per CLAUDE.md, including any other places the same bug pattern exists.
```

**Change request**

```text
Change request from the client: <text>.
Read CLAUDE.md and the relevant SRS section. First reply with: (1) which SRS requirement(s) change or get added, (2) schema changes (additive), (3) affected screens/jobs, (4) risks to money/seats/guardrail, (5) estimate S/M/L. Wait for my "go". Then implement, add tests only per CLAUDE.md test policy, update docs/01-SRS.md change log and the requirement table, and commit.
```

**Review request (what to send me after each session)**

```text
Paste: (1) the session's final summary, (2) `git log --oneline <base>..HEAD`, (3) `git diff --stat <base>..HEAD`, (4) CI status, (5) anything that was faked or skipped.
```
