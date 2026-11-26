# Lavigo OS — Software Requirements Specification (SRS)

| | |
|---|---|
| Version | 1.1 (build baseline for 28 Nov 2026 delivery; AI moved to v2) |
| Client | Lavigo Travel Co., Ranchi |
| Built by | Codzo |
| Reference | `lavigo-os-demo.html` (owner demo). Every screen in the demo is in scope unless listed in §9. |
| Status | Baseline. Changes after delivery go through the change log at the bottom. |

---

## 1. Purpose and scope

Lavigo is a small travel company. It runs **fixed-date group departures** (Nepal, Netarhat, Darjeeling, Sikkim) and **custom trips**. Today, enquiries come in on WhatsApp and Instagram at all hours. Payments are chased by hand, supplier rates are collected one phone call at a time, and nobody knows the real profit per trip until it's over.

Lavigo OS is a single web app for the owner and staff that:

1. Puts every WhatsApp and Instagram enquiry in **one shared inbox**, where staff send priced quotes **inside owner-defined price rules** and ask the owner with one tap when a request falls outside them. *(An AI agent that answers on its own comes in v2; see §1.2.)*
2. Turns an accepted quote into a **booking with a payment link**, and confirms it automatically when the money arrives.
3. **Chases balances** on a schedule.
4. Sends one **rate request to many suppliers** and compares their replies.
5. Ranks **travel options by real landed cost** and says when to book.
6. **Fills empty seats** on departures with targeted campaigns.
7. Shows **profit per trip** and a daily "what needs you" view.

### 1.1 Release scope: v1 now, AI in v2

Decided 26 Nov 2026 with Codzo: **v1 (delivered 28 Nov) contains no AI or LLM features.**

| Area | v1 (build now) | v2 (later) |
|---|---|---|
| Inbox | Human-run shared inbox for WhatsApp, Instagram and Sandbox. Staff reply, send quote cards and payment links from the composer (§4.4, `DESK-*`). | AI sales agent answers and negotiates on its own (`AGT-*`, kept below for reference). |
| Pricing | The deterministic pricing engine guards **staff** quotes and bookings (§4.3). | The same engine guards the AI. Nothing changes in the engine. |
| Owner approvals | Staff ask the owner for prices between floor and staff limit; the owner approves in one tap. | The AI raises the same approvals. |
| Supplier replies | Rule-based rate extraction (regex) plus manual confirm (§4.7). | LLM parsing for messy replies. |
| Follow-ups | Needs-you reminder plus a one-tap `follow_up` template for staff. | AI-written follow-ups. |
| Fill seats | Rule-based audience (past travellers, unconverted enquiries, waitlist). It never needed an LLM. | Optional AI-personalised copy. |
| Rules screen | **Pricing rules**: floor, staff discount, offers, escalation size. | Adds AI-only toggles (24/7 replies, freebie-first, persona). |

To keep v2 cheap, the schema keeps its AI tables (`AgentRun`, `AgentStep`, `AgentSettings` AI fields, `Conversation.aiMode`). v1 doesn't write to them, and v2 needs no migration on core tables.

**v1 rule:** no `@anthropic-ai/sdk` dependency, no `ANTHROPIC_*` env, no LLM calls anywhere.

### 1.2 Definitions

| Term | Meaning |
|---|---|
| **Departure** | A dated instance of a trip with a seat count, e.g. `NP-28N` = Nepal, 28 Nov, 30 seats. |
| **List price (P)** | Per-person selling price of a departure, GST inclusive. |
| **Cost (C)** | Planned per-person cost of a departure (hotels, transport, trip leader). |
| **Floor margin (m)** | Minimum margin the owner accepts, as a fraction of price. Default 17%. |
| **Floor price (F)** | Lowest per-person price that still meets the floor margin: `F = ceil10( C / (1 − m) )`. With the demo's C = ₹10,900 and m = 17%, F = ₹13,140. |
| **Auto offer (A)** | List price minus the best eligible standing offer (group, early-bird, repeat). |
| **Staff discount (s)** | Extra ₹/person staff may give **without asking the owner** (in v2, the AI's solo discount). Stored as `AgentSettings.soloDiscountPerPax`. Default ₹0. |
| **Staff limit (L)** | Lowest price staff may quote without asking the owner: `L = max(F, A − s)`. In v2 this is also the AI's autonomy limit. |
| **Suggested counter** | Smallest price ≥ F that ends in the "charm" digits (default `99`). With F = ₹13,140 that is ₹13,199. |
| **Approval** | A one-tap decision the owner makes when staff ask (v1: price between F and L, below floor, large group). In v2 the AI raises them too. |
| **Landed cost** | Ticket fare + hidden extras (cab, extra hotel night, lost days) per person. |
| **24h window** | Meta's customer-service window. Free-form replies are allowed for 24h after the customer's last message. Outside it, only pre-approved **templates** can be sent. |
| **ARP** | IRCTC Advance Reservation Period: how many days before travel train booking opens. It's configurable and defaults to 60. |
| **Paise** | ₹1 = 100 paise. Every money value is stored as an integer number of paise. |

### 1.3 Users

| Role | Who | Can |
|---|---|---|
| **Owner** | Lavigo's owner | Everything: approvals, pricing rules, profit, users, settings. Can quote down to F (below F with a second confirmation). |
| **Staff** | Office team | Inbox, bookings, dues, suppliers, tickets, departures. **Cannot** change pricing rules, quote below L without owner approval, see the profit screen, or manage users. |
| **Customer** *(external)* | Travellers | Chat on WhatsApp/Instagram, pay via a payment link. Never logs in. |
| **Supplier** *(external)* | Hotels, agents, DMCs | Receive rate requests on WhatsApp/email and reply in plain text. |

---

## 2. Assumptions and constraints

- **A1. Single tenant.** One agency, one WhatsApp business number, one Instagram professional account.
- **A2. Time zone** is Asia/Kolkata for every date shown or computed. Currency is INR only.
- **A3. Messaging needs Meta approval.**
  - WhatsApp Cloud API needs a verified Meta Business, a registered phone number, and **approved templates** for anything sent outside the 24h window (reminders, rate requests, campaigns, follow-ups).
  - Instagram messaging needs a professional account linked to the Meta app. Messaging the general public generally needs **Meta App Review**.
  - These approvals can take longer than our 2-day build. *(See R1, R2.)*
- **A4. Payments** use Razorpay Payment Links. Test mode works without KYC; live mode needs Lavigo's Razorpay KYC.
- **A5. No IRCTC automation.** There is no public IRCTC booking API we can use. The app plans train bookings and reminds; a human books on IRCTC.
- **A6. Flight fares:** the demo mentions "your B2B travel portal". The portal and its API are **unknown**. v1 uses **manual fare entry** behind a `FareProvider` interface.
- **A7. No LLM in v1.** A deterministic pricing engine (§4.3) decides every allowed price. In v2, the AI agent (Anthropic Claude) will call the same engine.
- **A8.** Build window: Thu 26 – Fri 27 Nov 2026, delivery Sat 28 Nov morning. Post-delivery work happens in the bug-fix/improvement phase.
- **A9.** Local development runs **entirely in Docker** (no Node or Postgres installed on the host). CI runs on GitHub Actions.

---

## 3. System context

See `02-DFD.md`, Level 0. External systems:

- Meta WhatsApp Cloud API
- Meta Instagram Messaging API
- Razorpay
- An SMTP or email API provider
- An S3-compatible object store
- *(manual)* IRCTC
- *(manual, v1)* a B2B flight portal

---

## 4. Functional requirements

Priorities:

- **M** = must ship Saturday
- **S** = should ship Saturday; can slip to week 1
- **C** = could; post-delivery

### 4.1 Authentication and users

| ID | Requirement | Pri |
|---|---|---|
| AUTH-1 | Email + password login. Passwords hashed with argon2id. Session cookie is httpOnly, Secure, SameSite=Lax. | M |
| AUTH-2 | Login rate limit: 5 failures per 15 minutes per email+IP, then a 15-minute lockout. | M |
| AUTH-3 | Roles OWNER/STAFF. Authorization is enforced **in server code for every action and query**, not only in middleware. | M |
| AUTH-4 | The owner can invite or deactivate staff. | S |
| AUTH-5 | Every sensitive action writes an `AuditLog` row: rule changes, approvals, manual payments, cancellations, below-limit quotes. | M |

### 4.2 Today (dashboard)

| ID | Requirement | Pri |
|---|---|---|
| TOD-1 | KPI tiles: **Collected this month** (captured payments, with % change vs last month); **Balance to collect** (open balances on HELD/CONFIRMED bookings, plus count of late ones); **Enquiries today** (conversations whose first inbound message is today, "X replied · Y waiting for a reply"); **Profit booked this month** (Σ total − planned cost on bookings created this month, with average margin). | M |
| TOD-2 | **Needs you** list, computed live, not stored. Sources: pending approvals; conversations waiting > 30 min for a first reply; quotes with no customer reply for 20h; RFQs where every recipient replied or is past its nudge deadline; bookings ≥ 7 days late; fare alerts (fare up ≥ 5% in 14 days, or travel within the booking threshold); departures < 40% sold with < 90 days to go (shows the count of matching past customers). Each item has a primary action that deep-links to the right screen. | M |
| TOD-3 | **Live activity** feed: the latest 20 `ActivityEvent`s, pushed in real time over SSE. | M |
| TOD-4 | Bar chart of money collected over the last 6 months, current month highlighted. | M |
| TOD-5 | Upcoming departures with a seats-sold bar and days to go. | M |
| TOD-6 | Global search in the top bar: customer name, phone, booking code. | S |
| TOD-7 | Sidebar badges: Inbox = unanswered conversations + pending approvals; Payments & dues = late count; Tickets desk = open ticket alerts. The demo's "AI agent is online" box is **not shown in v1**; it returns in v2. | M |

### 4.3 Pricing engine and guardrails (core; no UI of its own)

| ID | Requirement | Pri |
|---|---|---|
| PRC-1 | A pure, deterministic function `evaluatePrice(departure, pax, customer, today, settings, offers, requestedPricePerPax?)`. It returns: `listPrice`, `appliedOffers[]`, `autoOffer A`, `floor F`, `autonomyLimit L`, `suggestedCounter`, `marginBps(at any price)` and a `decision`. | M |
| PRC-2 | `decision` for a requested price `r`: **`ACCEPT_AUTO`** if r ≥ A (quote A; never charge more than the customer asked); **`ACCEPT_WITHIN_AUTONOMY`** if L ≤ r < A; **`NEEDS_APPROVAL`** if F ≤ r < L; **`BELOW_FLOOR`** if r < F. For `BELOW_FLOOR`, staff can't agree; the UI offers "Ask owner" with `suggestedCounter`. | M |
| PRC-3 | Offer eligibility: GROUP if pax ≥ minPax; EARLY_BIRD if days to departure ≥ minDaysBeforeTravel; REPEAT_TRAVELLER if the customer has a COMPLETED or CONFIRMED booking with an earlier departure. **Stacking default:** apply only the single largest eligible offer *(assumption, confirm with client, Q6)*. | M |
| PRC-4 | All arithmetic is integer paise. Floor is rounded **up** to ₹10; the suggested counter is the smallest value ≥ F ending in `charmEnding`. | M |
| PRC-5 | The owner may approve a price below F only with an explicit second confirmation, and it is audit-logged. Staff (and the v2 AI) can never do this. | M |
| PRC-6 | Large group (pax ≥ `escalateGroupSizeAtLeast`) always escalates, whatever the price. | M |

**Worked example.** This is a unit-test fixture and must reproduce the demo.

Inputs: C = 10,900, P = 13,999, m = 17%, group offer 500 for 6+, s = 0, pax = 6, customer asks 12,500.

| Value | Result |
|---|---|
| F | 13,140 |
| A | 13,499 |
| L | 13,499 |
| decision | `BELOW_FLOOR` |
| suggestedCounter | 13,199 (margin 17.4%) |
| Owner "Counter" button | 13,299 |

### 4.4 Inbox (channels and deal desk)

| ID | Requirement | Pri |
|---|---|---|
| INB-1 | Receive WhatsApp Cloud API webhooks: verify the GET challenge; verify `X-Hub-Signature-256` on the **raw body**; store a `WebhookEvent`; return 200 fast; process asynchronously. | M |
| INB-2 | Receive Instagram messaging webhooks the same way. | S *(needs App Review for public users, R2)* |
| INB-3 | **Sandbox channel**: an in-app "customer simulator" page where staff type as a customer. It goes through exactly the same pipeline as WhatsApp (ingest, inbox, quotes, payment link, confirmations). Used for demos and testing while Meta approvals are pending. | M |
| INB-4 | Upsert the customer by phone (WhatsApp) or IGSID (Instagram). Inbound from a known **supplier** phone routes to the supplier pipeline (§4.7), never to the customer inbox. | M |
| INB-5 | Conversation list with tabs **All · Needs you · Paid · Follow-up**. Each row shows a channel badge, last message, time and status pill (Waiting for reply / Negotiating / Quote sent / Payment pending / Paid / Follow-up due). | M |
| INB-6 | Thread view styled like WhatsApp. Outbound messages are tagged with the sender ("🙋 You", or the staff member's name; "⚙️ Lavigo" for automatic system messages like confirmations and reminders). System notes are centred. Quote cards render line items, and payment-link cards render a pay button. | M |
| INB-7 | Composer: free text (Enter to send), quick-insert of departure info (itinerary, inclusions, list price, from the DB), attachments, and the deal actions in `DESK-*`. *(v2: take over / hand back to AI.)* | M |
| INB-8 | Right panel: lead (trip, travellers, source, temperature, editable by staff); **deal guardrail meter** (offer marker, asked marker, staff-limit marker; floor and margin are shown **to the owner only**); "Staff can give alone"; **pending approval card** (owner: Approve / Counter / Decline; staff: status); result block after booking; activity timeline for the conversation (quote sent, approval, link, payment). | M |
| INB-9 | Real-time updates over SSE: new messages, status changes, approvals. | M |
| INB-10 | Outbound delivery statuses (sent/delivered/read/failed) from webhooks are reflected as ✓/✓✓. | S |
| INB-11 | Outside the 24h window, free-text sends are blocked, and the UI offers the matching approved template. | M |
| INB-12 | Media (customer ID photos, PDFs) is downloaded from Meta, stored privately, and attachable to a traveller. | S |

**Deal desk (v1, staff-operated)**

| ID | Requirement | Pri |
|---|---|---|
| DESK-1 | **Quote builder** in the composer: departure, pax, optional customer-asked price. It calls `evaluatePrice` live and shows applied offers, offer price, decision and the meter. Staff can send at any price ≥ L; the owner at ≥ F (below F with a second confirmation). Anything else disables "Send" and offers **Ask owner**. | M |
| DESK-2 | Sending creates a `Quote` (validity from settings) and sends a quote-card message with line items (list × pax, offer, total, seats left). It supersedes older quotes in the conversation. | M |
| DESK-3 | **Ask owner** creates an `Approval` (kind PRICE / BELOW_FLOOR / LARGE_GROUP, with `suggestedPricePerPax` **from the engine**). The owner is alerted by toast, sidebar badge and the Today Needs-you list, plus an optional WhatsApp `owner_approval` template to `User.phone`, with a deep link to a mobile-first `/approvals/[id]` page. | M (in-app) / S (WhatsApp) |
| DESK-4 | Owner decision (Approve suggested / Counter suggested + ₹100 / custom / Decline) is audit-logged. On approve or counter, the approved quote card is **sent automatically** to the customer. On decline, staff see the reason. | M |
| DESK-5 | **Send payment link** on a valid quote: hold seats (transaction) → booking HELD → Razorpay ADVANCE link → payment-link card. Shows "seats unavailable" if the departure filled up. | M |
| DESK-6 | On payment captured, an automatic confirmation goes out (free text if the 24h window is open, otherwise the `booking_confirmed` template) with the invoice PDF. A system note appears in the thread. | M |
| DESK-7 | Follow-ups: a quote with no customer reply for 20h appears in Needs-you and as an inbox "Follow-up due" pill. One tap sends a polite free-text nudge (window open) or the `follow_up` template (opted-in customers only). | S |
| DESK-8 | Large groups (pax ≥ `escalateGroupSizeAtLeast`) always need owner approval, whatever the price. | M |

**AI agent behaviour: v2, deferred, not built in v1.** Kept as the v2 spec. These map onto the v1 deal desk, since the AI will call the same quote, approval and link functions.

| ID | Requirement | Pri |
|---|---|---|
| AGT-1 | The agent replies only when `aiMode = AUTO` and (`reply24x7` or inside business hours). It debounces bursts: it waits about 4s after the last inbound message, then answers everything at once. One run at a time per conversation. | v2 |
| AGT-2 | It mirrors the customer's language (Hindi, English, Hinglish) and introduces itself as Lavigo's assistant. It never claims to be human. | v2 |
| AGT-3 | It **only states prices, availability and inclusions returned by tools**. It never computes a discount itself. | v2 |
| AGT-4 | Tools: `list_departures`, `get_departure`, `evaluate_price`, `send_quote`, `request_owner_approval`, `create_payment_link`, `update_lead`, `list_addons`, `handoff_to_owner`, `request_custom_trip`. Every tool validates its input server-side and re-runs the pricing engine. A `send_quote` price below L without an approved Approval is **rejected**. | v2 |
| AGT-5 | Tool results **never** contain cost, floor or margin. The model only sees list price, allowed price, offers and the decision. | v2 |
| AGT-6 | Outbound policy filter: every rupee amount in AI text must match a price the server issued for this conversation; every URL must be one of our payment-link or site domains. Otherwise the message is **BLOCKED**, the conversation escalates, and the owner is alerted. | v2 |
| AGT-7 | It always escalates complaints, refund requests, groups ≥ 15 and below-floor asks (per settings). | v2 |
| AGT-8 | When the owner approves or counters, the agent resumes automatically with that decision and sends the quote plus a payment link. Decline → the agent politely holds at L. | v2 |
| AGT-9 | Freebie-first: when enabled and a customer pushes on price, the agent offers an add-on from `list_addons` before any discount. | v2 |
| AGT-10 | Follow-up: a quote with no reply after about 20h (inside the window) gets one free-text nudge; a template follow-up at 72h if the customer opted in. | v2 |
| AGT-11 | Cost and abuse limits: max 30 agent runs per conversation per day; max_tokens bounded; on repeated failures the agent pauses and alerts the owner. | v2 |
| AGT-12 | Every run is recorded (`AgentRun`, `AgentStep`) with tokens, latency, stop reason and errors. | v2 |
| AGT-13 | Owner alert for an approval: in-app toast plus a sidebar badge, and a WhatsApp utility template to the owner's phone with a deep link to a **mobile-friendly** approval page. | v2 |

### 4.5 Bookings

| ID | Requirement | Pri |
|---|---|---|
| BKG-1 | Table: code, date, customer (initials avatar, phone), trip and date, travellers, total, paid, status pill (Paid in full / Balance ₹X / Nd late), source. Filter chips: All / Paid in full / Balance due. | M |
| BKG-2 | **New booking** form (walk-in, phone, website): customer (search or create), departure or custom trip, pax, price per pax (validated by the pricing engine; staff can't go below L, the owner can with a warning), travellers, optional advance payment. | M |
| BKG-3 | Booking codes `LVG-#####` come from a Postgres sequence (no collisions under concurrency). | M |
| BKG-4 | **Seat inventory**: seats taken = Σ pax of HELD + CONFIRMED + COMPLETED bookings. Holding seats runs in a transaction with a row lock on the departure; overbooking is impossible. A HELD booking expires at `holdExpiresAt` if unpaid and its seats are released. | M |
| BKG-5 | Drawer: summary card (trip, travellers, total, paid, balance, profit on this booking); journey timeline (enquiry → advance paid → balance → hotels confirmed → documents x/y → travel); actions: Send balance link, Invoice PDF, Send vouchers, Itinerary PDF. | M |
| BKG-6 | Record a manual payment (cash or bank transfer), owner/staff, audit-logged. | M |
| BKG-7 | Cancel a booking (releases seats). Refunds are recorded manually in v1. | S |
| BKG-8 | Travellers: add/edit names, age, gender, ID type, document status. | M |

### 4.6 Payments and dues

| ID | Requirement | Pri |
|---|---|---|
| PAY-1 | Create a Razorpay Payment Link for ADVANCE (default 25% of total), BALANCE or FULL, with an expiry, `reference_id = booking code` and customer contact. | M |
| PAY-2 | Webhook `payment_link.paid` (and payment captured): verify `X-Razorpay-Signature` (HMAC-SHA256 of the raw body), dedupe by event id, and in **one transaction**: insert Payment (unique `providerPaymentId`), update `paidAmount`, HELD → CONFIRMED, set `balanceDueDate = start − balanceDueDaysBeforeTravel`. Then, async: generate invoice/receipt PDF, send the WhatsApp confirmation, write an activity event, and send the automatic confirmation (DESK-6). | M |
| PAY-3 | The same webhook delivered twice, or out of order, never double-counts. | M |
| PAY-4 | Aging cards: Not due yet · 1–7 days late · 8+ days late · Collected this week. | M |
| PAY-5 | "Who owes you" table sorted by lateness, with reminder count and a per-row "Send link" (creates or reuses an open BALANCE link and sends it on WhatsApp). "Remind everyone late" does the bulk version. | M |
| PAY-6 | Automatic reminder rules (toggleable): 7 days before due (friendly + link); on due date; 3 days late (firm); 7 days late (flag owner to call); seat release N days before travel (off by default). A daily job at 10:00 IST evaluates the rules idempotently (`ReminderLog` unique key). | M |
| PAY-7 | Reminder message preview, shown with real customer data. | S |
| PAY-8 | Invoice PDF with GST breakup (rate from settings, *pending CA confirmation, Q4*). | M |

### 4.7 Supplier desk

| ID | Requirement | Pri |
|---|---|---|
| SUP-1 | Supplier directory: CRUD for name, type, destinations, phone, email, preferred channel. | M |
| SUP-2 | New rate request (RFQ): destination, check-in, nights, rooms, category, meal plan, optional departure link, recipients (default: active suppliers serving that destination), baseline "usual rate" (prefilled from the departure or from the last booked rate for the destination). | M |
| SUP-3 | Send: one message per supplier through their preferred channel. WhatsApp uses the approved `rfq` utility template; email uses SMTP. Each recipient shows "Sent on WhatsApp · waiting". | M |
| SUP-4 | Inbound supplier replies (WhatsApp from a known supplier phone) are matched to their open RFQ (most recent SENT RFQ for that supplier). The rate is extracted by a **rule-based parser** (amounts near "per room", "/night", "rate", "₹", "Rs"; meal-plan keywords CP/MAP/breakfast/dinner; decline words). It produces `{ratePerRoomNight, inclusions, totalIfStated, confidence}`. Anything ambiguous (several amounts, no amount, low confidence) is saved as **"needs check"** with the raw text, and staff confirm the value in one click. *(v2: LLM parsing.)* | M |
| SUP-5 | Manual "Add quote" (paste reply text → same parser, or type values) for email and phone replies. *(Automatic inbound email parsing is C.)* | M |
| SUP-6 | Quotes table: rate/room/night, total for rooms × nights, replied-in time. The best (lowest) row is highlighted. A savings banner shows (baseline − best) × room-nights and the % cheaper. | M |
| SUP-7 | Book: marks the quote BOOKED and the others REJECTED, creates an `Expense` (HOTEL) for the linked departure, sends a confirmation to the supplier, writes an activity event. | M |
| SUP-8 | A nudge job re-pings non-responders after 2h (once, `rfq_request` template reminder), then marks them NO_REPLY after 24h. | S |

### 4.8 Tickets desk

| ID | Requirement | Pri |
|---|---|---|
| TKT-1 | Travel plans per departure or custom booking: origin, destination, travel date, budget per person (defaults to `departure.travelBudgetPerPax`), pax (live from bookings). | M |
| TKT-2 | Options (manual entry in v1): mode, title, details, ticket fare, hidden extras and note, tags, disqualified flag and reason. | M |
| TKT-3 | Ranking by **landed cost** = ticket + extras, ascending. "Best" = the cheapest **non-disqualified** option. Show "vs budget" (+/−) and extra profit = (budget − best landed) × pax. | M |
| TKT-4 | Fare snapshots: each fare edit stores a `FareSnapshot`. A 14-day trend chart with a budget line. A fare alert goes to Needs-you when the fare has risen ≥ 5% over 14 days. *(No predictive "where fares go" line in v1: we don't have data to support it.)* | M |
| TKT-5 | Train booking window: `windowOpensAt = travelDate − ARP days, 08:00 IST`. Reminder notifications at T−1 21:00 and T 07:45. Shown as a card "Train window opens soon". | M |
| TKT-6 | **Booking plan (PNR split)**: max 6 passengers per ticket. Bookings (families) are kept together where possible, using first-fit decreasing by booking size; bookings larger than 6 are split into consecutive tickets. "Copy passenger list" gives IRCTC-ready text (name, age, gender, berth preference). | M |
| TKT-7 | Confirm booking: enter PNR(s), upload ticket PDF(s), mark BOOKED, send tickets to travellers on WhatsApp, create a TICKETS `Expense`. | M |
| TKT-8 | `FareProvider` interface with a `ManualFareProvider`. The B2B portal adapter is C, pending portal details (Q3). | M |

### 4.9 Departures

| ID | Requirement | Pri |
|---|---|---|
| DEP-1 | Cards with hero image, name, status pill (Needs seats < 40% sold and < 90 days; Filling well > 65%; else On track), seats sold bar, revenue. | M |
| DEP-2 | CRUD for trips and departures (owner/staff): price, cost, seats, dates, itinerary, inclusions, travel budget. | M |
| DEP-3 | **Fill seats** (button label "✨ Fill seats"; no LLM, rule-based): compute the audience (past travellers with matching tags, enquiries about this trip or destination that didn't book in the last 180 days, waitlist), show count and reasons, a message preview using the approved MARKETING template, and an optional limited-time discount. Customers without marketing opt-in are excluded and counted as "skipped (no opt-in)". | M |
| DEP-4 | Send the campaign through the outbound queue, rate-limited. A booking on the same departure within 7 days by a recipient is attributed to the campaign; the card shows "+N from this campaign". | M |
| DEP-5 | Traveller list export as CSV (name, age, gender, phone, ID status, booking code). | M |
| DEP-6 | Send document checklist (template) to all travellers on the departure. | S |

### 4.10 Profit

| ID | Requirement | Pri |
|---|---|---|
| PRF-1 | KPIs: revenue booked, cost, profit, average margin (with the lowest-margin trip). | M |
| PRF-2 | Table per departure and custom trip: revenue = Σ booking totals (excluding cancelled); cost = Σ actual `Expense` if any exist, else Σ `costTotalPlanned` (badge "planned" vs "actual"); profit; margin bar (amber < 20%). | M |
| PRF-3 | Owner-only. | M |

### 4.11 Pricing rules (demo's "AI rules" screen)

| ID | Requirement | Pri |
|---|---|---|
| RUL-1 | Minimum margin slider (8–30%), staff discount slider (₹0–1,500, step 100), toggles for group, early-bird and repeat traveller; offer amounts are editable. *(v2 adds freebie-first, 24/7 replies and persona.)* | M |
| RUL-2 | "Always needs your OK": groups of N+ (editable), below floor (fixed). | M |
| RUL-3 | Live preview computed by the **same pricing engine** on a sample departure: "for a group of 6 your staff can go down to ₹L on their own; between ₹L and ₹F they ask you; below ₹F only you can approve, with a warning". | M |
| RUL-4 | Owner-only; every change is audit-logged. Changes affect the next quote immediately (open inboxes re-render via SSE). | M |

---

## 5. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Performance | Dashboard p95 server time < 500 ms with 10k bookings. Webhook endpoints ack < 300 ms. |
| NFR-2 | Availability | Single VPS for v1. Restart policies on all containers. Nightly `pg_dump` to object storage, keeping 14 days. |
| NFR-3 | Correctness | Money is integer paise everywhere. Every payment and seat mutation runs in a DB transaction. Webhooks are idempotent. |
| NFR-4 | Security | OWASP ASVS L1 baseline: webhook signature checks with constant-time compare; secrets only in env; CSP and security headers; private object storage with short-lived signed URLs; upload type/size limits; login rate limiting; RBAC in the data layer; audit log; dependency scanning in CI. Pricing enforced server-side for every quote and booking (staff cannot bypass by editing requests). |
| NFR-5 | Privacy | Traveller IDs are personal data. Store only what's needed, restrict to authenticated users, and log access. Marketing only to opted-in customers. *(Align with India's DPDP Act; not legal advice; client to confirm, Q8.)* |
| NFR-6 | Usability | Responsive down to 360 px. The approval page and inbox are usable one-handed on a phone. Visual design matches the demo tokens (Outfit font, ink/lavender palette). |
| NFR-7 | Observability | Structured JSON logs (pino) with request id and conversation id. A `/api/health` endpoint (DB + Redis). Optional Sentry DSN. |
| NFR-8 | Portability | Everything runs via `docker compose`. Zero host dependencies besides Docker. |
| NFR-9 | Maintainability | TypeScript strict mode; ESLint; one domain module per feature; external services behind adapters with fakes for tests. |

---

## 6. External interface requirements

| Interface | Direction | Contract |
|---|---|---|
| WhatsApp Cloud API | in/out | Webhook GET verify + POST (signed). Graph `/{phone-number-id}/messages` for text, interactive (CTA URL button) and template messages. Graph API version comes from env. |
| Instagram Messaging | in/out | Webhook (signed), Graph send API. Same 24h rule. |
| Razorpay | out + webhook | Payment Links API; webhook events `payment_link.paid`, `payment.captured`; signature header `X-Razorpay-Signature`. |
| Email | out | SMTP (Mailpit in dev; any provider in prod). |
| Object storage | out | S3 API (MinIO in dev). Private bucket, presigned GET with a 5-minute TTL. |

---

## 7. Data requirements

The schema is in `docs/design/schema.prisma`, explained in `04-database-schema.md`.

- Retention: messages are kept indefinitely in v1; webhook payloads are pruned after 30 days.
- Backups: nightly.

---

## 8. Acceptance tests (the Saturday demo script)

The release is accepted when all of these pass on the deployed instance with seed data:

1. **Login.** Owner logs in; Today shows real KPIs from seed data.
2. **Enquiry lands.** In the Sandbox, a "customer" sends *"Hi, Nepal trip ka kya rate hai? 28 Nov wala"*. It appears live in the inbox as "Waiting for reply", with the badge incremented. **Staff** (logged in as staff) reply, using quick-insert of the Nepal trip info.
3. **Group offer.** The customer says 6 people. Staff open the quote builder: the group offer applies automatically (₹13,499 × 6 = ₹80,994), and a quote card is sent.
4. **Escalation.** The customer asks for 12,500. The builder shows `BELOW_FLOOR`, and Send is disabled for staff. Staff tap **Ask owner**. An approval appears on Today, as a toast, and in the owner's inbox panel; the owner's meter shows floor ₹13,140.
5. **Approval to payment link.** The owner taps **Approve ₹13,199** (on the phone-sized `/approvals/[id]` page). The approved quote card goes to the customer automatically. Staff tap **Send payment link** for 25% (₹19,799, Razorpay **test**). A HELD booking exists and seats are held.
6. **Payment to confirmation.** Paying in Razorpay test mode (or `scripts/simulate-payment.ts` in dev) makes the booking CONFIRMED, invoice PDF generated, automatic confirmation message in the thread, activity in the feed, KPIs updated, and the Nepal seats bar +6.
7. **Dues.** A late booking shows in the 8+ days bucket. "Send link" produces a link message. The reminder job, run manually, logs reminders without duplicates on a second run.
8. **Supplier desk.** An RFQ to the seeded suppliers; a simulated supplier reply ("2150 per room with breakfast") is parsed into the quotes table; best is highlighted; savings shown; Book creates an expense.
9. **Tickets desk.** The Goa plan ranks by landed cost, with the Delhi-midnight option correctly not best. The Nepal PNR split keeps families together, ≤ 6 per ticket.
10. **Departures.** Fill seats shows an audience count and preview; sending creates campaign recipients (opt-in respected).
11. **Profit and rules.** The Profit table matches bookings and expenses. Changing the floor to 20% on Pricing rules changes the preview and the next quote-builder decision (floor ₹13,630).
12. **Guardrail bypass attempt.** Logged in as staff, a forged server-action request (edited in devtools) to send a quote at ₹9,000 is rejected by the server, and no Quote is created.

---

## 9. Out of scope for 28 Nov (planned later)

| Item | Why it's later |
|---|---|
| Instagram messaging for the public | Depends on Meta App Review (R2). Works for app-role accounts in dev mode. |
| B2B flight portal integration and automatic fare tracking | Portal unknown (Q3). |
| IRCTC automation | Not permitted / no API. |
| **All AI/LLM features** (AI sales agent, AI follow-ups, LLM quote parsing) | Moved to v2 by decision on 26 Nov (§1.1). |
| Automatic inbound email parsing for supplier replies | Manual paste + rule-based parse covers it. |
| Customer-facing website and booking page | — |
| EMI, refunds through Razorpay | Recorded manually. |
| Multi-tenant (other agencies) | — |
| Native mobile app | The responsive web app covers phones. |
| Predictive fare modelling | — |

---

## 10. Risks

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | WhatsApp number/business verification or template approval not done by Saturday | Live WhatsApp demo impossible | **Start Meta setup Thursday.** The Sandbox channel runs the identical pipeline, so the demo runs on Sandbox if needed. Meta's test number works for up to 5 recipient numbers *(verify current Meta limits)*. |
| R2 | Instagram App Review pending | No IG for the public | Ship the adapter. Dev-mode accounts work; enable for the public after review. |
| R3 | Razorpay KYC pending | No live money | Test mode for the demo; switch keys after KYC. |
| R4 | Staff quote below the owner's rules | Margin loss | Pricing engine enforced server-side, approvals, audit log. |
| R5 | 2-day timeline | Scope slip | Ship the priority M items first; the S items are explicitly allowed to slip to week 1. |
| R6 | Enquiries pile up at night with no AI | Lost leads | "Waiting for reply" Needs-you items, an inbox badge, and an optional after-hours auto-acknowledgement message (S; it's inside the 24h window, so no template is needed). The v2 AI agent removes this. |

---

## 11. Open questions for the client

Defaults are in brackets; we build with the default unless told otherwise.

| ID | Question |
|---|---|
| Q1 | WhatsApp: is there a verified Meta Business and a dedicated number? Is a BSP or direct Cloud API preferred? [direct Cloud API] |
| Q2 | Instagram: business account linked to a Facebook Page? OK to submit for App Review? [yes] |
| Q3 | Which B2B flight portal (name, API docs, credentials)? [manual entry v1] |
| Q4 | GST: rate and invoice format for packages; invoice numbering series. [5%, `INV-{bookingNo}`; **must be confirmed by Lavigo's CA**] |
| Q5 | Advance % and balance due days. [25%, 15 days before travel] |
| Q6 | Do standing offers stack (group + early-bird + repeat)? [no; best single offer] |
| Q7 | Hosting: VPS provider and region, domain name. [Mumbai-region VPS, `app.<domain>` via Caddy] |
| Q8 | Consent text for marketing opt-in; data retention for traveller IDs. [opt-in captured in chat; IDs deleted 90 days after travel — **C**] |
| Q9 | (v2) Assistant name and persona (the demo uses a female Hinglish voice). ["Lavigo Assistant"] |
| Q10 | Staff accounts needed on day 1? [owner + 1 staff seeded] |

---

## Change log

| Date | Change | By |
|---|---|---|
| 2026-11-26 | Baseline | Codzo |
| 2026-11-26 | v1.1: all AI/LLM features moved to v2; added the deal desk (`DESK-*`), rule-based supplier parsing and the Pricing rules screen | Codzo |
