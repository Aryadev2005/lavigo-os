/** Minimal fixtures for integration tests. Each call creates fresh, uniquely named rows. */
import { randomBytes } from "node:crypto";
import { db } from "@/server/db";
import { rupees } from "@/server/money";
import { addDays, todayIST } from "@/server/time";

const uid = () => randomBytes(4).toString("hex");

/** Default settings + the standing group offer (₹500 off from 6 pax), as in the SRS example. */
export async function ensureSettings() {
  // Test files run in parallel and all call this. Prisma's upsert is find-then-create, so two
  // files can both try the insert (P2002); INSERT … ON CONFLICT DO NOTHING is atomic.
  await db.agentSettings.createMany({ data: [{ id: 1 }], skipDuplicates: true });
  await db.offer.createMany({
    data: [{ id: "test-group-offer", kind: "GROUP", name: "Group offer", description: "₹500 off per person for 6 or more", amountPerPax: rupees(500), minPax: 6 }],
    skipDuplicates: true,
  });
  return db.agentSettings.findUniqueOrThrow({ where: { id: 1 } });
}

export async function makeOwner() {
  const u = uid();
  return db.user.create({ data: { email: `owner-${u}@test.local`, name: "Owner", role: "OWNER", passwordHash: "x" } });
}

export async function makeCustomer() {
  const u = uid();
  return db.customer.create({ data: { name: `Customer ${u}`, phone: `+91${parseInt(u, 16)}` } });
}

export async function makeDeparture(opts: { seatsTotal?: number; daysOut?: number } = {}) {
  const u = uid();
  const trip = await db.trip.create({
    data: {
      slug: `trip-${u}`,
      name: "Nepal",
      title: "Nepal · Pokhara & Kathmandu",
      destination: "Nepal",
      nights: 6,
      days: 7,
      summary: "",
      itinerary: [{ day: 1, title: "Arrive Kathmandu" }],
    },
  });
  const start = addDays(todayIST(), opts.daysOut ?? 25);
  return db.departure.create({
    data: {
      code: `NP-${u}`,
      tripId: trip.id,
      startDate: start,
      endDate: addDays(start, 6),
      seatsTotal: opts.seatsTotal ?? 20,
      pricePerPax: rupees(13_999),
      costPerPax: rupees(10_900),
    },
  });
}
