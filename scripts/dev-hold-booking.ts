/**
 * TEMPORARY dev helper (until the deal desk UI lands in P2): create a HELD booking on the first
 * open departure with free seats, at the engine's auto price, plus its advance payment link.
 *
 *   pnpm tsx scripts/dev-hold-booking.ts [pax]
 */
import { createBooking, evaluateForDeparture } from "@/server/domain/bookings";
import { seatsTaken } from "@/server/domain/inventory";
import { createLink } from "@/server/domain/payments";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { inr } from "@/server/money";
import { closeQueues } from "@/server/queue";

async function main() {
  if (env.isProd) throw new Error("dev only");
  const pax = Number(process.argv[2] ?? 2);
  const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const customer = await db.customer.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  for (const dep of await db.departure.findMany({ where: { status: "OPEN" }, orderBy: { startDate: "asc" } })) {
    if (dep.seatsTotal - (await seatsTaken(dep.id)) < pax) continue;
    const { result } = await evaluateForDeparture(db, { departureId: dep.id, customerId: customer.id, pax });
    const { booking } = await createBooking(
      { customerId: customer.id, departureId: dep.id, pax, pricePerPax: result.autoOffer, source: "PHONE", notes: "dev-hold-booking" },
      { id: owner.id, role: owner.role },
    );
    const link = await createLink(booking.id, "ADVANCE");
    console.log(`${booking.code} HELD · ${customer.name} · ${pax} × ${inr(booking.pricePerPax)} on ${dep.code} = ${inr(booking.totalAmount)}`);
    console.log(`Advance ${inr(link.amount)} → ${link.shortUrl}`);
    console.log(`Simulate: docker compose exec web pnpm tsx scripts/simulate-payment.ts ${booking.code}`);
    return;
  }
  throw new Error(`No open departure has ${pax} free seats`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await db.$disconnect();
  });
