/**
 * Simulate a customer paying a payment link: builds a realistic `payment_link.paid` payload,
 * signs it with RAZORPAY_WEBHOOK_SECRET (dev default when unset) and POSTs it to the webhook.
 *
 *   pnpm tsx scripts/simulate-payment.ts LVG-24912            # the booking's open link
 *   pnpm tsx scripts/simulate-payment.ts plink_fake_ab12…     # a specific link
 *   … --twice      send the same event twice (idempotency check)
 *   … --url http://localhost:3000   target (default APP_URL)
 */
import { db } from "@/server/db";
import { env } from "@/server/env";
import { inr } from "@/server/money";
import { buildPaymentLinkPaid, postSignedWebhook } from "@/server/payments/simulate";

async function main() {
  if (env.isProd) throw new Error("simulate-payment is dev/test only");
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const urlIdx = args.indexOf("--url");
  const baseUrl = urlIdx >= 0 ? args[urlIdx + 1]! : env.APP_URL;
  if (!target) throw new Error("usage: simulate-payment <LVG-code | plink_id> [--twice] [--url URL]");

  const link = await db.paymentLink.findFirst({
    where: target.startsWith("LVG-") ? { booking: { code: target }, status: "CREATED" } : { providerLinkId: target },
    orderBy: { createdAt: "desc" },
    include: { booking: { select: { code: true } } },
  });
  if (!link) throw new Error(`No open payment link for ${target}`);

  const built = buildPaymentLinkPaid({
    providerLinkId: link.providerLinkId,
    bookingCode: link.booking.code,
    amount: link.amount,
    purpose: link.purpose,
    shortUrl: link.shortUrl,
  });
  const times = args.includes("--twice") ? 2 : 1;
  for (let i = 0; i < times; i++) {
    const res = await postSignedWebhook(baseUrl, built);
    console.log(`POST ${baseUrl}/api/webhooks/razorpay → ${res.status} ${res.body}`);
  }
  console.log(`Simulated ${inr(link.amount)} ${link.purpose} for ${link.booking.code} (payment ${built.paymentId})`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
