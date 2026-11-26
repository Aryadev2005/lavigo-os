/** Minimal fixtures for integration tests. Each call creates fresh, uniquely named rows. */
import { randomBytes } from "node:crypto";
import { db } from "@/server/db";
import { rupees } from "@/server/money";
import { addDays, todayIST } from "@/server/time";

const uid = () => randomBytes(4).toString("hex");

/** Default settings + the standing group offer (₹500 off from 6 pax), as in the SRS example. */
export async function ensureSettings() {
  const settings = await db.agentSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  // Fixed id: test files run in parallel and must not create it twice.
  await db.offer.upsert({
    where: { id: "test-group-offer" },
    update: {},
    create: { id: "test-group-offer", kind: "GROUP", name: "Group offer", description: "₹500 off per person for 6 or more", amountPerPax: rupees(500), minPax: 6 },
  });
  return settings;
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
