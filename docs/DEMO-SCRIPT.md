# Demo script: SRS §8, click by click

**About 25 minutes.** Two browser windows side by side:

- **Window A, staff:** a normal desktop window, logged in as `staff@lavigo.local`.
- **Window B, owner:** a phone-sized window, logged in as `owner@lavigo.local`. In Chrome, open DevTools → device toolbar → iPhone 14, or use a real phone on the same URL.

Use two different browser profiles (or one normal window and one private window) so the two sessions don't share a cookie.

> **For the client:** in v2, the AI sales agent works on top of this exact flow: same inbox, same pricing guardrails, same owner approvals and payment links. Nothing you see today is thrown away.

---

## 0. Before the demo (T-30 min)

1. **Reset to clean demo data.** All seed dates are relative to today (IST), so the dues buckets and departures line up.
   - Dev laptop: `make demo-reset`
   - Demo server (production mode, fakes): `make demo-reset PROD=1 ENV_FILE=.env.prod SEED_DEMO=true FORCE=1`. It is refused without both flags.
   - The reset prints the logins. Passwords come from `SEED_OWNER_PASSWORD` / `SEED_STAFF_PASSWORD`.
2. Open `/api/health`. It should show `"status":"ok"`.
3. **Is WhatsApp approved yet?**
   - **Yes (real number):** use a real phone as "the customer" and message the business number. Skip the Sandbox parts below.
   - **No (Sandbox fallback):** the server needs `FEATURE_SANDBOX=true` (and `DEMO_FAKES=true` if there are no provider keys yet). In window A, open **Sandbox** in the sidebar. The left pane is the customer's phone, the right is the real staff thread. Nothing is sent to WhatsApp, and payments use the fake checkout at `/dev/pay/…`.
4. In window B (owner), open **Today** and leave it there. Toasts arrive live.

---

## 1. Login: Today shows real KPIs

- **B (owner):** log in. Today shows collected this month, dues, seats and the Needs-you list, all computed from the data.
- **A (staff):** log in. Point out that staff never see cost, floor or margin: compare the Today cards in the two windows.

## 2. An enquiry lands

- **A:** go to **Sandbox** → *New customer name* `Riya Sharma` → **+ New sandbox chat**.
- On the customer phone (left), type *"Hi, Nepal trip ka kya rate hai? 28 Nov wala"* → send.
- The message appears in the thread as *Waiting for reply*, and the Inbox badge goes up in both windows.
- **A:** in the composer, tap **Insert trip details** (the ⓘ button) → pick Nepal → the trip info is inserted → **Send**. The reply appears on the customer's phone.

## 3. Group offer → quote card

- Customer: *"We are 6 people"*.
- **A:** tap **Build a quote** → Trip: Nepal · Pokhara & Kathmandu → Travellers: `6`.
- The group offer applies by itself: **₹13,499 × 6 = ₹80,994**. Tap **Send quote**. The quote card arrives on the customer's phone.
- Note: a quote card needs the 24-hour WhatsApp window, i.e. the customer wrote in the last 24 h. That is always true in this flow.

## 4. Escalation to the owner

- Customer: *"Can you do 12,500 per person?"*
- **A:** **Build a quote** again → Nepal, 6 travellers, *Customer asked* `12500`.
- The builder shows **Below floor**, and **Send quote (needs the owner)** is disabled for staff.
- Tap **🤝 Ask owner · suggest ₹13,199**. The panel shows *Waiting for owner*.
- **B (owner):** a toast arrives, and Today → *Needs you* shows *"Riya Sharma wants a group discount"*. On the owner's side the inbox panel's meter shows **floor ₹13,140**.

## 5. Approval → payment link

- **B:** tap **Review** → the phone-sized approval page (`/approvals/…`) → **Approve ₹13,199**.
- **A:** the approved quote card goes to the customer automatically.
- **A:** tap **💳 Send payment link · ₹19,799** (a 25% advance). The link message arrives on the customer's phone.
- A HELD booking now exists, and 6 seats are held on Nepal. Show this in **Departures**.

## 6. Payment → confirmation

- On the customer's phone, tap the payment link → **Pay ₹19,799**.
  - Real Razorpay test mode: pay with a test card.
  - Fake checkout: just press Pay.
- Within a few seconds:
  - **A:** the thread shows *"Payment received… Booking LVG-… confirmed"*.
  - **B:** a 🎉 toast arrives, and Today's KPIs move.
  - **Bookings:** the new booking shows *Balance ₹59,395*, and the invoice PDF is on the booking.
  - **Departures:** the Nepal seats bar is +6.

## 7. Dues

- **B:** **Dues** → *Who owes you*. A late booking sits in the **8+ days** bucket.
- Tap **Send link** on it. A payment-link message is queued to that customer.
- Reminders: run `make job name=reminders` (on the server: `docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm web pnpm job reminders`) twice. The second run sends nothing new: no duplicates.

## 8. Supplier desk

- **A or B:** **Supplier desk** → **New rate request** (hotel, the seeded destination) → pick the seeded suppliers → send.
- In a supplier's row, under *Their reply*, paste *"2150 per room with breakfast"*. It is parsed into the quotes table.
- The best quote is highlighted, and the savings are shown. **Book** creates an expense on the departure.

## 9. Tickets desk

- **Tickets** → *Goa family (Saurav K.)* plan. Options are ranked by landed cost, and the Delhi-midnight option is correctly *not* best (the hidden extras are shown).
- The Nepal PNR split keeps families together, with ≤ 6 passengers per ticket.

## 10. Departures: fill seats

- **Departures** → a departure with empty seats → **Fill seats**. It shows the audience count (opted-in customers only) and a message preview.
- Send. Campaign recipients are created, and customers without opt-in are skipped.

## 11. Profit and pricing rules (owner)

- **B:** **Profit**. The table matches bookings and expenses.
- **Pricing rules** → change *Minimum margin* (the floor) to **20%**. The live preview updates.
- **A:** open the quote builder on Nepal again. The next decision uses **floor ₹13,630**.
- Reset it to the original value afterwards (or run `demo-reset` before the next demo).

## 12. Guardrail bypass attempt

- **A (staff):** open DevTools → Network. Send any quote, then right-click the server-action request → *Copy as fetch*. Paste it in the console, change `"pricePerPax":1349900` to `"pricePerPax":900000` and run it.
- The response is `{"ok":false,…}`, and **no quote is created**: the server re-runs the pricing engine and ignores the client's price.
- This step is also automated in `tests/e2e/smoke.spec.ts` and runs in CI on every pull request.

---

### If something goes wrong on stage

- Toast *"Couldn't reach the server"*: check the Wi-Fi, then press **Try again** on the error card.
- The payment didn't confirm: open the thread again after 5 s. The worker processes the webhook in the background.
- Anything odd: run the reset (step 0) and restart at step 2. It takes under a minute.
