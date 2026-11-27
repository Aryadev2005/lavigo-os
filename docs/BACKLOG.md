# Backlog: week 1 after delivery

The order is a suggestion. Each item says what's missing and where it lives today.

## Inbox and messaging

1. **Withdrawn quotes shown struck through.** When the owner declines, or a newer quote replaces one, the old quote card stays as it was in the thread. Render cards of quotes whose status is `SUPERSEDED` (or withdrawn by the decline) struck through, with a "replaced" label.
2. **Invoice outside the 24 h window.** Today the invoice PDF is generated but only noted in the thread ("not sent: the 24-hour window is closed"). Add a `invoice_ready` utility template with a **document header**, submit it to Meta, and send it when the window is closed.
3. **INB-12: attach chat media to a traveller.** A photo or PDF the customer sends (passport, Aadhaar) can't yet be filed against a traveller from the thread. Add "Save to traveller…" on media messages, reusing the traveller documents upload path.
4. **After-hours auto-ack.** A rule-based reply outside business hours (settings: hours + text), sent once per conversation per night. v1 stays rule-based; v2's agent can replace it.
5. **Instagram App Review.** The code path is built and stays behind `FEATURE_INSTAGRAM=false`. Submit for App Review (`instagram_manage_messages`) with a screencast of the inbox.
6. **STOP / opt-out keyword.** Inbound "STOP" isn't handled yet. Clear `Customer.marketingOptIn` on STOP/UNSUBSCRIBE and confirm once. Campaigns already respect `marketingOptIn`.
7. **Template status sync.** Template approval is set by hand (`pnpm seed:prod --approve-templates`). Subscribe to Meta's `message_template_status_update` webhook and update `MessageTemplate.metaStatus` automatically.

## Money and data

8. **Flag column instead of the "(budgeted)" text marker.** Expenses created from a travel budget carry a "(budgeted)" marker in their text. Replace it with a boolean column (an additive migration) and backfill it from the marker.
9. **Seller details and GST on PDFs.** Invoices and vouchers lack the legal name, address, GSTIN and HSN/SAC lines. *Waiting on the client and their CA* for the exact details and the GST treatment (tour-operator rate vs. agent commission).
10. **CSV phone apostrophe.** Exported phone numbers open in Excel as numbers (losing the leading `+`). Prefix with `'` or export them as text, and check the bookings, dues and customers exports.

## Operations

11. **Daily cleanup of orphaned ticket PDFs.** Ticket PDFs uploaded then replaced, or left behind on a deleted option, stay in storage. Add the cleanup to the `maintenance.prune` job: delete ticket objects in storage that no `Document` row references, older than 7 days.
12. **Alert when webhook sweeper attempts are exhausted.** A `WebhookEvent` that fails every retry is only logged. Alert the owner (email + a Today item) and show it on a small admin list with a "Retry" button.
13. **CSP without `'unsafe-inline'` scripts.** Next's inline bootstrap scripts currently need `script-src 'unsafe-inline'`. Move to nonce-based CSP via the proxy once the pages that must stay static are confirmed.

## Larger items

14. **B2B fare portal adapter.** The tickets desk reads fares entered by staff. Add an adapter for the agency's B2B portal (behind `src/server/fares/`, with a fake), plus automated fare snapshots.
15. **Automatic supplier email parsing.** Supplier replies are pasted in today. Add an inbound email route (a forwarding address → webhook) feeding `parseSupplierReply(text, rfqContext)`, which keeps the same signature for v2's LLM parser.

---

**v2 (not week 1):** the AI sales agent on top of the same deal desk (design Appendix A), LLM supplier parsing, AI follow-ups.
