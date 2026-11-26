# Lavigo OS — Data Flow Diagrams

The diagrams use Mermaid, which GitHub renders natively. The notation follows Yourdon/DeMarco DFDs:

| Shape | Meaning |
|---|---|
| Rectangle | External entity (source or sink outside the system) |
| Rounded box `( )` with number | Process (transforms data) |
| Cylinder | Data store (`D#`) |
| Labelled arrow | Data flow (what moves, not control) |

Store numbering is shared across levels, so `D4 Bookings` is the same store everywhere.

**Release scope:** these diagrams show **v1** (no AI/LLM, per SRS §1.1). Process 2.0 is the staff-operated **Deal Desk**. The v2 AI agent and LLM flows are in the appendix at the end; in v2 the AI agent joins 2.0 as a second actor that calls the same functions.

---

## Level 0 — Context diagram

The whole system is one process. Everything else is outside it.

```mermaid
flowchart LR
  OWN[Owner / Staff]
  CUS[Customer]
  SUP[Supplier<br/>hotels · agents · DMCs]
  META[Meta Platform<br/>WhatsApp Cloud API · Instagram]
  RZP[Razorpay]
  MAIL[Email provider SMTP]
  OBJ[Object storage S3]
  IRCTC[IRCTC / B2B portal<br/>manual, human-operated]

  SYS((0<br/>Lavigo OS))

  CUS -- enquiries, replies, ID photos --> META
  META -- signed message webhooks, delivery statuses --> SYS
  SYS -- replies, quotes, payment links, templates --> META
  META -- chat messages --> CUS
  SUP -- rate replies via WhatsApp --> META
  SYS -- rate requests via email --> MAIL
  MAIL -- rate requests --> SUP

  SYS -- payment link requests --> RZP
  RZP -- signed payment webhooks --> SYS
  CUS -- UPI / card payment --> RZP


  SYS -- PDFs, media, backups --> OBJ
  OBJ -- signed file URLs --> SYS

  OWN -- replies, quotes, approvals, rules, bookings, RFQs, fares, PNRs --> SYS
  SYS -- dashboard, alerts, approvals, reports --> OWN
  OWN -- books tickets by hand --> IRCTC
  IRCTC -- PNRs, ticket PDFs --> OWN
```

---

## Level 1 — Major processes

```mermaid
flowchart TB
  CUS[Customer]
  SUP[Supplier]
  OWN[Owner / Staff]
  META[Meta Platform]
  RZP[Razorpay]
  MAIL[Email]

  P1(1.0<br/>Channel Gateway)
  P2(2.0<br/>Deal Desk<br/>staff quotes & approvals)
  P3(3.0<br/>Pricing & Guardrail Engine)
  P4(4.0<br/>Booking & Inventory)
  P5(5.0<br/>Payments & Dues)
  P6(6.0<br/>Supplier Procurement)
  P7(7.0<br/>Tickets Planning)
  P8(8.0<br/>Departures & Campaigns)
  P9(9.0<br/>Dashboard & Reporting)
  P10(10.0<br/>Admin, Rules & Auth)

  D1[(D1 Customers)]
  D2[(D2 Conversations & Messages)]
  D3[(D3 Trips & Departures)]
  D4[(D4 Bookings & Travellers)]
  D5[(D5 Payments, Links & Invoices)]
  D6[(D6 Agent Settings & Offers)]
  D7[(D7 Suppliers, RFQs & Quotes)]
  D8[(D8 Travel Plans & Fares)]
  D9[(D9 Activity & Audit Log)]
  D10[(D10 Object Storage)]
  D11[(D11 Job Queue)]
  D12[(D12 Approvals & Quotes)]
  D13[(D13 Campaigns & Waitlist)]
  D14[(D14 Expenses)]

  META -- inbound webhooks --> P1
  P1 -- outbound messages --> META
  P1 -- customer upsert --> D1
  P1 -- messages, statuses --> D2
  P1 -- media files --> D10
  P1 -- customer message event --> D11
  P1 -- supplier reply --> P6

  D2 -- conversation, lead --> P2
  OWN -- replies, quote requests, ask owner --> P2
  P2 -- price question --> P3
  P3 -- decision, allowed price --> P2
  D6 -- rules, offers --> P3
  D3 -- price, cost, seats --> P3
  P2 -- quotes, approvals --> D12
  P2 -- hold seats --> P4
  P2 -- payment link request --> P5
  P2 -- reply text --> P1

  D12 -- pending approvals --> OWN
  OWN -- approve / counter / decline --> D12
  D12 -- approved price --> P2

  P4 -- bookings, travellers --> D4
  D3 -- seat counts --> P4
  OWN -- manual bookings --> P4

  P5 -- create link --> RZP
  RZP -- paid webhook --> P5
  P5 -- payments, invoices --> D5
  P5 -- confirm booking --> D4
  P5 -- reminder messages --> P1
  P5 -- PDFs --> D10

  OWN -- RFQ --> P6
  P6 -- rate requests --> P1
  P6 -- emails --> MAIL
  MAIL --> SUP
  P6 -- RFQs, quotes --> D7
  P6 -- booked hotel cost --> D14

  OWN -- options, fares, PNRs --> P7
  D4 -- travellers --> P7
  P7 -- plans, fares, ticket groups --> D8
  P7 -- ticket PDFs to travellers --> P1
  P7 -- ticket cost --> D14

  OWN -- trips, departures, campaigns --> P8
  P8 -- departures --> D3
  D1 -- audience --> P8
  P8 -- campaigns, recipients --> D13
  P8 -- campaign templates --> P1

  D4 & D5 & D3 & D12 & D7 & D8 & D14 --> P9
  D9 -- live feed --> P9
  P9 -- dashboard, profit, alerts --> OWN

  OWN -- login, rules --> P10
  P10 -- settings, offers --> D6
  P10 -- audit entries --> D9
  P1 & P2 & P4 & P5 & P6 -- activity events --> D9
```

### Level 1 process dictionary

| # | Process | Inputs | Outputs | Stores |
|---|---|---|---|---|
| 1.0 | **Channel Gateway**: verifies, normalises and routes inbound messages; sends outbound with 24h-window and template policy | Meta webhooks, outbound requests from 2/5/6/7/8 | Normalised messages, SSE events, provider sends | D1, D2, D10, D11 |
| 2.0 | **Deal Desk**: staff replies, quote builder, ask-owner approvals, payment link from chat *(v2: the AI agent also drives it)* | Staff/owner actions, approval decisions, conversation state | Replies, quotes, approvals, held bookings, payment-link requests | D2, D12 |
| 3.0 | **Pricing & Guardrail Engine**: a pure function, the single source of price truth | Departure, pax, customer, rules, requested price | Decision, allowed price, suggested counter | reads D3, D6, D4 |
| 4.0 | **Booking & Inventory**: seat holds, booking lifecycle, travellers | Agent or staff booking requests, payment confirmations, hold expiry | Bookings, seat counts | D3, D4 |
| 5.0 | **Payments & Dues**: links, webhooks, invoices, reminders | Link requests, Razorpay webhooks, daily scheduler | Payments, invoices, reminders, confirmations | D4, D5, D10 |
| 6.0 | **Supplier Procurement**: RFQ fan-out, rule-based reply parsing, compare, book | Owner RFQ, supplier replies | Quotes, bookings, expenses | D7, D14 |
| 7.0 | **Tickets Planning**: landed-cost ranking, fare trend, booking window, PNR split | Options and fares entered by staff, travellers | Rankings, alerts, ticket groups | D8, D4, D14 |
| 8.0 | **Departures & Campaigns**: catalog, fill-seats audiences, sends, attribution | Owner input, customers, bookings | Departures, campaigns | D3, D13 |
| 9.0 | **Dashboard & Reporting**: KPIs, Needs-you, live feed, profit | All stores (read-only) | Views, SSE events | reads all |
| 10.0 | **Admin, Rules & Auth**: sessions, RBAC, settings, audit | Credentials, rule edits | Sessions, settings | D6, D9 |

---

## Level 2 — 1.0 Channel Gateway

```mermaid
flowchart LR
  META[Meta Platform]
  P11(1.1<br/>Verify signature<br/>& persist event)
  P12(1.2<br/>Normalise &<br/>dedupe message)
  P13(1.3<br/>Identify party<br/>customer vs supplier)
  P14(1.4<br/>Download media)
  P15(1.5<br/>Outbound policy:<br/>24h window / template)
  P16(1.6<br/>Send via provider<br/>& track status)
  D2[(D2 Conversations & Messages)]
  D1[(D1 Customers)]
  D7[(D7 Suppliers)]
  D10[(D10 Object Storage)]
  D11[(D11 Job Queue)]
  WH[(WebhookEvent)]
  P2(2.0 Deal Desk)
  STF[Staff / Owner]
  P6(6.0 Supplier Procurement)
  SRC[Processes 2,5,6,7,8]

  META -- raw POST + X-Hub-Signature-256 --> P11
  P11 -- invalid → 401 --> META
  P11 -- event row --> WH
  P11 -- process job --> D11
  D11 --> P12
  P12 -- message (unique externalId) --> D2
  P12 -- status update --> D2
  P12 --> P13
  D7 -- supplier phones --> P13
  P13 -- upsert customer --> D1
  P13 -- supplier message --> P6
  P13 -- customer message, SSE --> STF
  STF --> P2
  P12 -- media id --> P14
  P14 -- file --> D10
  SRC -- send request --> P15
  D2 -- lastInboundAt --> P15
  P15 -- BLOCKED / needs template --> D2
  P15 -- allowed --> P16
  P16 -- Graph API send --> META
  P16 -- wamid, SENT/FAILED --> D2
```

## Level 2 — 2.0 Deal Desk (v1)

```mermaid
flowchart TB
  STF[Staff]
  OWN[Owner]
  P21(2.1<br/>Reply & quick-insert<br/>trip info)
  P22(2.2<br/>Quote builder<br/>live price preview)
  P23(2.3<br/>Send quote<br/>server re-evaluates)
  P24(2.4<br/>Ask owner<br/>create approval)
  P25(2.5<br/>Owner decides<br/>approve / counter / decline)
  P26(2.6<br/>Send payment link<br/>hold seats)
  P27(2.7<br/>Follow-up due scan)
  P3(3.0 Pricing Engine)
  P4(4.0 Booking & Inventory)
  P5(5.0 Payments)
  P1(1.0 Channel Gateway)
  D2[(D2 Conversations)]
  D3[(D3 Departures)]
  D6[(D6 Settings & Offers)]
  D12[(D12 Approvals & Quotes)]
  D9[(D9 Activity & Audit)]

  STF -- text --> P21
  D3 -- itinerary, inclusions, list price --> P21
  P21 -- message --> P1
  STF -- departure, pax, asked price --> P22
  P22 --> P3
  D3 & D6 --> P3
  P3 -- decision, offers, L, suggested; floor/margin owner-only --> P22
  P22 -- preview --> STF
  STF -- send at price --> P23
  P23 -- re-evaluate --> P3
  P23 -- Quote --> D12
  P23 -- quote card --> P1
  P23 -- below-L audit --> D9
  STF -- ask owner --> P24
  P24 -- Approval with engine suggestion --> D12
  D12 -- pending approvals, alert --> OWN
  OWN -- decision --> P25
  P25 -- decided price --> D12
  P25 -- approved quote --> P23
  P25 -- audit --> D9
  STF -- send link on quote --> P26
  D12 -- valid quote --> P26
  P26 -- hold seats --> P4
  P26 -- ADVANCE link request --> P5
  D2 & D12 -- quotes without reply 20h --> P27
  P27 -- Follow-up due --> STF
```

## Level 2 — 5.0 Payments & Dues

```mermaid
flowchart TB
  RZP[Razorpay]
  OWN[Owner / Staff]
  P51(5.1<br/>Create payment link)
  P52(5.2<br/>Verify webhook<br/>& dedupe)
  P53(5.3<br/>Record payment &<br/>confirm booking<br/>single txn)
  P54(5.4<br/>Generate invoice / receipt PDF)
  P55(5.5<br/>Daily reminder scheduler)
  P56(5.6<br/>Hold expiry sweeper)
  P57(5.7<br/>Dues aging & who owes)
  D4[(D4 Bookings)]
  D5[(D5 Payments, Links, Invoices)]
  D10[(D10 Object Storage)]
  RR[(ReminderRule / ReminderLog)]
  P1(1.0 Channel Gateway)
  P2(2.0 Deal Desk)

  P2 -- ADVANCE link for approved quote --> P51
  OWN -- send balance link --> P51
  P51 -- create link API --> RZP
  RZP -- plink id, short_url --> P51
  P51 -- PaymentLink --> D5
  P51 -- link message --> P1
  RZP -- payment_link.paid + signature --> P52
  P52 -- WebhookEvent unique --> D5
  P52 --> P53
  P53 -- Payment unique providerPaymentId --> D5
  P53 -- paidAmount, CONFIRMED, balanceDueDate --> D4
  P53 -- invoice job --> P54
  P54 -- PDF --> D10
  P54 -- Invoice --> D5
  P53 -- confirmation + invoice --> P1
  RR -- enabled rules --> P55
  D4 -- open balances, due dates --> P55
  P55 -- reminder (template if window closed) --> P1
  P55 -- log unique booking+rule+date --> RR
  P55 -- 7d late → Needs-you flag --> OWN
  D4 -- HELD past holdExpiresAt --> P56
  P56 -- CANCELLED, seats released --> D4
  D4 & D5 --> P57
  P57 -- aging buckets, table --> OWN
```

## Level 2 — 6.0 Supplier Procurement

```mermaid
flowchart LR
  OWN[Owner / Staff]
  SUP[Supplier]
  P61(6.1<br/>Compose RFQ<br/>prefill baseline)
  P62(6.2<br/>Fan-out per recipient<br/>WA template / email)
  P63(6.3<br/>Match reply<br/>to open RFQ)
  P64(6.4<br/>Parse quote<br/>rule-based, confidence)
  P65(6.5<br/>Compare & rank<br/>savings vs baseline)
  P66(6.6<br/>Book supplier<br/>create expense)
  P67(6.7<br/>Nudge / timeout job)
  D7[(D7 Suppliers, RFQs, Quotes)]
  D14[(D14 Expenses)]
  D3[(D3 Departures)]
  P1(1.0 Channel Gateway)

  OWN -- destination, dates, rooms, recipients --> P61
  D3 -- usualRoomRate --> P61
  D7 -- last booked rate --> P61
  P61 -- Rfq + RfqRecipients --> D7
  P61 --> P62
  P62 -- WA template --> P1
  P62 -- email --> SUP
  P1 -- supplier inbound --> P63
  OWN -- pasted email / phone reply --> P64
  D7 -- latest SENT RFQ for supplier --> P63
  P63 -- reply text + RFQ context --> P64
  P64 -- needs check, low confidence --> OWN
  P64 -- SupplierQuote, confidence --> D7
  D7 --> P65
  P65 -- ranked quotes, best, savings --> OWN
  OWN -- book --> P66
  P66 -- BOOKED / REJECTED --> D7
  P66 -- HOTEL expense --> D14
  P66 -- confirmation --> P1
  D7 -- SENT > 2h, no reply --> P67
  P67 -- nudge --> P1
  P67 -- NO_REPLY after 24h --> D7
```

## Level 2 — 7.0 Tickets Planning

```mermaid
flowchart LR
  OWN[Owner / Staff]
  P71(7.1<br/>Manage plan & options)
  P72(7.2<br/>Record fare snapshot)
  P73(7.3<br/>Rank by landed cost)
  P74(7.4<br/>Fare-rise alert)
  P75(7.5<br/>Train window scheduler)
  P76(7.6<br/>PNR split<br/>≤6, families together)
  P77(7.7<br/>Confirm booking<br/>PNR + PDFs)
  D8[(D8 Travel Plans & Fares)]
  D4[(D4 Bookings & Travellers)]
  D14[(D14 Expenses)]
  D10[(D10 Object Storage)]
  P1(1.0 Channel Gateway)

  OWN -- options, fares, extras --> P71
  P71 --> D8
  P71 -- fare change --> P72
  P72 -- FareSnapshot --> D8
  D8 --> P73
  P73 -- ranked options, best, extra profit --> OWN
  D8 -- 14-day snapshots --> P74
  P74 -- Needs-you item --> OWN
  D8 -- windowOpensAt --> P75
  P75 -- reminders T−1 21:00, T 07:45 --> OWN
  D4 -- bookings + travellers --> P76
  P76 -- TicketGroups --> D8
  P76 -- IRCTC passenger text --> OWN
  OWN -- PNRs, ticket PDFs --> P77
  P77 -- files --> D10
  P77 -- BOOKED --> D8
  P77 -- TICKETS expense --> D14
  P77 -- tickets to travellers --> P1
```

---

## Appendix — v2 (deferred): Level 2 for the 2.0 AI Sales Agent

In v2, the Anthropic Claude API joins Level 0 as an external entity ("conversation context, tool results" out; "replies, tool calls" in). Process 2.0 gains this AI path. Its tools call the v1 Deal Desk functions (2.3, 2.4, 2.6). The `payment_received` trigger also resumes the agent.


```mermaid
flowchart TB
  D11[(D11 Job Queue)]
  P21(2.1<br/>Acquire conversation lock<br/>& gate: aiMode, hours, caps)
  P22(2.2<br/>Build context:<br/>system prompt, history,<br/>lead state, operator events)
  P23(2.3<br/>Claude tool-use loop)
  P24(2.4<br/>Execute tool<br/>server-side validation)
  P25(2.5<br/>Outbound text filter<br/>prices & URLs)
  P26(2.6<br/>Persist run & steps)
  P3(3.0 Pricing Engine)
  P4(4.0 Booking & Inventory)
  P5(5.0 Payments)
  P1(1.0 Channel Gateway)
  LLM[Claude API]
  OWN[Owner]
  D2[(D2 Conversations)]
  D3[(D3 Departures)]
  D6[(D6 Settings & Offers)]
  D12[(D12 Approvals & Quotes)]
  D9[(D9 Activity)]

  D11 -- agent.reply / approval_decided / payment_received / follow_up --> P21
  D2 -- aiMode, run count --> P21
  P21 -- skip: SKIPPED run --> P26
  P21 --> P22
  D2 -- last N messages, summary --> P22
  D12 -- quotes & decided approvals --> P22
  P22 -- messages + tools --> P23
  P23 <--> LLM
  P23 -- tool_use --> P24
  P24 -- evaluate --> P3
  D3 & D6 --> P3
  P3 -- decision (no cost/floor) --> P24
  P24 -- quote / approval --> D12
  D12 -- approval card --> OWN
  P24 -- hold seats --> P4
  P24 -- create link --> P5
  P24 -- tool_result --> P23
  P23 -- final text --> P25
  D12 -- issued prices for this conversation --> P25
  P25 -- pass --> P1
  P25 -- violation → BLOCKED + approval OTHER --> D12
  P23 & P24 --> P26
  P26 -- AgentRun, AgentStep --> D2
  P26 -- activity --> D9
```

