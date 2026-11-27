/**
 * DEV / DEMO ONLY: stands in for Razorpay's hosted checkout when the payment adapter is fake.
 * "Pay" posts a correctly signed payment_link.paid webhook to our own endpoint, exercising the
 * exact production path (verify → WebhookEvent → payment.apply job). 404 in production unless the
 * deployment is an explicit DEMO_FAKES demo. Signed-in users only: in a demo the staff (playing
 * the customer in the Sandbox) open the link; nobody on the internet can "pay" a demo booking.
 */
import { notFound, redirect } from "next/navigation";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { inr } from "@/server/money";
import { buildPaymentLinkPaid, postSignedWebhook } from "@/server/payments/simulate";
import { requireUser } from "@/server/rbac";

export const dynamic = "force-dynamic";

function devOnly() {
  if ((env.isProd && !env.demoFakes) || env.providers.razorpay !== "fake") notFound();
}

async function pay(formData: FormData) {
  "use server";
  devOnly();
  await requireUser();
  const id = String(formData.get("id"));
  const link = await db.paymentLink.findUnique({ where: { providerLinkId: id }, include: { booking: { select: { code: true } } } });
  if (!link || link.status !== "CREATED") redirect(`/dev/pay/${id}`);
  const built = buildPaymentLinkPaid({
    providerLinkId: link.providerLinkId,
    bookingCode: link.booking.code,
    amount: link.amount,
    purpose: link.purpose,
    shortUrl: link.shortUrl,
  });
  // Post to ourselves from inside the container (APP_URL's port is the container's own port).
  const res = await postSignedWebhook(`http://127.0.0.1:${process.env.PORT ?? 3000}`, built);
  redirect(`/dev/pay/${id}?sent=${res.status}`);
}

export default async function DevPayPage(props: PageProps<"/dev/pay/[id]">) {
  devOnly();
  await requireUser();
  const { id } = await props.params;
  const { sent } = await props.searchParams;
  const link = await db.paymentLink.findUnique({
    where: { providerLinkId: id },
    include: { booking: { select: { code: true, status: true, paidAmount: true, totalAmount: true, customer: { select: { name: true } } } } },
  });
  if (!link) notFound();

  return (
    <main className="min-h-screen grid place-items-center p-6" style={{ background: "var(--bg)" }}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm border" style={{ borderColor: "var(--line)" }}>
        <p className="text-xs uppercase tracking-wider" style={{ color: "var(--warn)" }}>
          Dev payment simulator · not Razorpay
        </p>
        <h1 className="mt-2 text-xl">Lavigo Travel Co.</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {link.purpose.toLowerCase()} for {link.booking.code} · {link.booking.customer.name}
        </p>
        <p className="mt-4 text-3xl font-bold" style={{ color: "var(--ink)" }}>
          {inr(link.amount)}
        </p>
        <dl className="mt-4 text-sm grid grid-cols-2 gap-1" style={{ color: "var(--muted)" }}>
          <dt>Link</dt>
          <dd className="text-right">{link.status}</dd>
          <dt>Booking</dt>
          <dd className="text-right">{link.booking.status}</dd>
          <dt>Paid / total</dt>
          <dd className="text-right">
            {inr(link.booking.paidAmount)} / {inr(link.booking.totalAmount)}
          </dd>
        </dl>
        {sent ? (
          <p className="mt-4 text-sm" style={{ color: sent === "200" ? "var(--ok)" : "var(--bad)" }}>
            Webhook sent (HTTP {sent}). The worker applies it in a moment: refresh to see the booking update.
          </p>
        ) : null}
        {link.status === "CREATED" ? (
          <form action={pay} className="mt-5">
            <input type="hidden" name="id" value={link.providerLinkId} />
            <button type="submit" className="w-full rounded-xl py-3 font-semibold text-white" style={{ background: "var(--ink)" }}>
              Pay {inr(link.amount)}
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
