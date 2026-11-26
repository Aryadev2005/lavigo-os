/**
 * Demo seed: reproduces docs/reference/lavigo-os-demo.html (docs/04-database-schema.md "Seed data").
 *
 * All dates are relative to the run date in Asia/Kolkata (the demo's "today" was 3 Nov 2026,
 * so a demo date D becomes today + (D − 3 Nov)). Override with SEED_TODAY=YYYY-MM-DD.
 *
 * The seed WIPES every table first. v1 has no AI: the demo's "AI:" lines are re-authored as
 * staff (Author.OWNER) or system messages, and no AI-only column is written.
 *
 *   make seed
 */
import { randomBytes } from "node:crypto";
import {
  type BookingSource,
  type Channel,
  type ConversationStatus,
  type ExpenseCategory,
  Prisma,
  PrismaClient,
  type TravelMode,
} from "@prisma/client";
import { hashPassword } from "../src/server/password";
import { rupees } from "../src/server/money";
import { addDays, formatDate, istDateString, istDateStringOf, istDateTime, todayIST } from "../src/server/time";

// Refuse to wipe a production database by accident.
if (process.env.NODE_ENV === "production") {
  const demoOptIn = process.env.SEED_DEMO === "true";
  const forced = process.argv.includes("--force");
  if (!demoOptIn || !forced) {
    console.error(
      [
        "Refusing to seed: NODE_ENV=production.",
        "This seed TRUNCATES EVERY TABLE and loads demo data.",
        `  SEED_DEMO=true: ${demoOptIn ? "yes" : "no"}   --force: ${forced ? "yes" : "no"}`,
        "Both are required, e.g.: SEED_DEMO=true pnpm seed --force",
      ].join("\n"),
    );
    process.exit(1);
  }
}

const db = new PrismaClient();

// ───────────────────────────── clock ─────────────────────────────

const NOW: Date = process.env.SEED_TODAY ? istDateTime(process.env.SEED_TODAY, "23:42") : new Date();
const TODAY = todayIST(NOW);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Calendar date `n` days from today. */
const d = (n: number) => addDays(TODAY, n);
/** Instant `n` days from today at an IST wall-clock time (clamped to not be in the future). */
const at = (n: number, hhmm = "11:00") => {
  const t = istDateTime(istDateStringOf(d(n)), hhmm);
  return t > NOW ? new Date(NOW.getTime() - 5 * MIN) : t;
};
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// Deterministic PRNG so every seed run produces the same people.
let rngState = 24901;
function rand(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/** "70040 55871" → "+917004055871" */
const e164 = (local: string) => `+91${local.replace(/\D/g, "")}`;
let fakePhoneCounter = 0;
const fakePhone = () => `+9198${String(10_000_000 + fakePhoneCounter++ * 7919).padStart(8, "0")}`;

const FIRST_F = ["Sunita", "Pooja", "Kavita", "Neha", "Anjali", "Ritu", "Shreya", "Priyanka", "Sapna", "Meena", "Divya", "Isha"];
const FIRST_M = ["Rohan", "Vikram", "Sanjay", "Ravi", "Nitin", "Arun", "Manoj", "Karan", "Aditya", "Suresh", "Ajay", "Kunal"];

// ───────────────────────────── reset ─────────────────────────────

async function wipe() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await db.$executeRawUnsafe(`ALTER SEQUENCE booking_code_seq RESTART WITH 24901`);
}

// ───────────────────────────── users ─────────────────────────────

async function seedUsers() {
  const generated: string[] = [];
  const password = (envKey: string, who: string) => {
    const fromEnv = process.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
    const pw = randomBytes(12).toString("base64url");
    generated.push(`  ${who.padEnd(22)} ${pw}`);
    return pw;
  };

  const owner = await db.user.create({
    data: {
      email: "owner@lavigo.local",
      name: process.env.SEED_OWNER_NAME?.trim() || "Lalit Kumar", // initials LK, as in the demo
      role: "OWNER",
      phone: process.env.SEED_OWNER_PHONE?.trim() || "+919800000001",
      passwordHash: await hashPassword(password("SEED_OWNER_PASSWORD", "owner@lavigo.local")),
    },
  });
  const staff = await db.user.create({
    data: {
      email: "staff@lavigo.local",
      name: process.env.SEED_STAFF_NAME?.trim() || "Sonal Ekka",
      role: "STAFF",
      passwordHash: await hashPassword(password("SEED_STAFF_PASSWORD", "staff@lavigo.local")),
    },
  });
  return { owner, staff, generated };
}

// ───────────────────────────── rules, offers, templates ─────────────────────────────

async function seedRules(ownerId: string) {
  // Singleton id = 1. Schema defaults are the demo's rules (17% floor, ₹0 staff discount, 25% advance…).
  await db.agentSettings.create({ data: { id: 1, updatedById: ownerId } });

  await db.offer.createMany({
    data: [
      { kind: "GROUP", name: "Group offer", description: "₹500 off per person for 6 or more", amountPerPax: rupees(500), minPax: 6 },
      { kind: "EARLY_BIRD", name: "Early-bird", description: "₹750 off when booked 45+ days before", amountPerPax: rupees(750), minDaysBeforeTravel: 45 },
      { kind: "REPEAT_TRAVELLER", name: "Repeat traveller", description: "₹500 off for anyone who travelled with Lavigo before", amountPerPax: rupees(500) },
    ],
  });

  await db.reminderRule.createMany({
    data: [
      { key: "before_7d", name: "7 days before due", description: "Friendly heads-up + UPI link", anchor: "DUE_DATE", offsetDays: -7, action: "SEND_REMINDER", templateName: "payment_reminder" },
      { key: "on_due", name: "On the due date", description: "Reminder + UPI link", anchor: "DUE_DATE", offsetDays: 0, action: "SEND_REMINDER", templateName: "payment_reminder" },
      { key: "late_3d", name: "3 days late", description: "Firm reminder", anchor: "DUE_DATE", offsetDays: 3, action: "SEND_REMINDER", templateName: "payment_overdue" },
      { key: "late_7d", name: "7 days late", description: "Ask you to call · flag on Today", anchor: "DUE_DATE", offsetDays: 7, action: "FLAG_OWNER" },
      { key: "seat_release", name: "Seat release", description: "Release unpaid seats 10 days before travel", anchor: "TRAVEL_DATE", offsetDays: -10, action: "RELEASE_SEATS", enabled: false },
    ],
  });

  // Mirrors of templates registered with Meta. Marked APPROVED so the dev fakes can send them.
  const t = (name: string, category: "UTILITY" | "MARKETING", purpose: string, bodyPreview: string, variables: string[]) => ({
    name, category, purpose, bodyPreview, variables, metaStatus: "APPROVED",
  });
  await db.messageTemplate.createMany({
    data: [
      t("payment_reminder", "UTILITY", "PAYMENT_REMINDER", "Hi {{1}}, a friendly reminder: your balance of {{2}} for {{3}} is due on {{4}}. Pay securely here: {{5}}", ["name", "amount", "trip", "due_date", "pay_link"]),
      t("payment_overdue", "UTILITY", "PAYMENT_REMINDER", "Hi {{1}}, your balance of {{2}} for {{3}} was due on {{4}}. Please pay here to keep your seats: {{5}}", ["name", "amount", "trip", "due_date", "pay_link"]),
      t("rfq_request", "UTILITY", "RFQ", "Hello {{1}}, Lavigo Travel here. Please share your best rate for {{2}} {{3}} rooms ({{4}}) in {{5}}, check-in {{6}} for {{7}} nights. Reply with your rate per room per night.", ["supplier", "rooms", "category", "meal_plan", "destination", "check_in", "nights"]),
      t("seat_fill_offer", "MARKETING", "CAMPAIGN", "Hi {{1}}! {{2}} on {{3}}: only {{4}} seats left. Since you travelled with us before, here's {{5}} off till {{6}}. Book in 2 minutes: {{7}}", ["name", "trip", "date", "seats_left", "discount", "valid_until", "link"]),
      t("follow_up", "MARKETING", "FOLLOW_UP", "Hi {{1}}, just checking in on your {{2}} plan. Seats are filling up. Shall we hold {{3}} seats for you?", ["name", "trip", "pax"]),
      t("doc_checklist", "UTILITY", "DOC_CHECKLIST", "Hi {{1}}, for {{2}} on {{3}} please send: {{4}}. Just reply here with photos.", ["name", "trip", "date", "documents"]),
      t("booking_confirmed", "UTILITY", "BOOKING_CONFIRMED", "Hi {{1}}, booking {{2}} for {{3}} ({{4}} travellers) is confirmed. We received {{5}}. Balance {{6}} is due by {{7}}.", ["name", "booking_code", "trip", "pax", "paid", "balance", "due_date"]),
      t("owner_approval", "UTILITY", "OWNER_APPROVAL", "Approval needed: {{1}} ({{2}} travellers, {{3}}) asks {{4}} per person. Suggested: {{5}}. Decide: {{6}}", ["customer", "pax", "trip", "asked", "suggested", "link"]),
    ],
  });
}

// ───────────────────────────── catalog ─────────────────────────────

type TripKey = "nepal" | "netarhat" | "darjeeling" | "sikkim";

const TRIPS: Record<TripKey, Prisma.TripCreateInput & { image: string }> = {
  nepal: {
    slug: "nepal", name: "Nepal", title: "Nepal · Pokhara & Kathmandu", destination: "Pokhara & Kathmandu, Nepal",
    nights: 5, days: 6, image: "nepal",
    summary: "Six days across Kathmandu's durbar squares and Pokhara's lakeside, by train and road from Ranchi.",
    inclusions: ["Train 3AC Ranchi ↔ Raxaul", "AC coach in Nepal", "5 nights hotels (twin share)", "Breakfast and dinner", "Trip leader"],
    exclusions: ["Lunch", "Entry tickets", "Personal expenses"],
    itinerary: [
      { day: 1, title: "Ranchi → Raxaul", description: "Overnight train." },
      { day: 2, title: "Birgunj → Kathmandu", description: "Cross the border, drive to Kathmandu." },
      { day: 3, title: "Kathmandu", description: "Pashupatinath, Boudhanath, Patan." },
      { day: 4, title: "Kathmandu → Pokhara", description: "Scenic drive, evening at Lakeside." },
      { day: 5, title: "Pokhara", description: "Sarangkot sunrise, Phewa lake, Davis Falls." },
      { day: 6, title: "Pokhara → Raxaul", description: "Drive back, overnight train to Ranchi." },
    ],
  },
  netarhat: {
    slug: "netarhat", name: "Netarhat", title: "Netarhat Weekend", destination: "Netarhat, Jharkhand",
    nights: 1, days: 2, image: "netarhat",
    summary: "The Queen of Chotanagpur: sunrise at Magnolia Point and the Lodh falls, in one weekend.",
    inclusions: ["AC coach from Ranchi", "1 night stay", "All meals", "Trip leader"],
    exclusions: ["Personal expenses"],
    itinerary: [
      { day: 1, title: "Ranchi → Netarhat", description: "Morning drive, Lodh falls, sunset at Magnolia Point." },
      { day: 2, title: "Netarhat → Ranchi", description: "Sunrise point, pine forest walk, drive back." },
    ],
  },
  darjeeling: {
    slug: "darjeeling", name: "Darjeeling", title: "Darjeeling Winter Escape", destination: "Darjeeling, West Bengal",
    nights: 4, days: 5, image: "darjeeling",
    summary: "Toy train, tea gardens and Kanchenjunga at sunrise from Tiger Hill.",
    inclusions: ["Train 3AC Ranchi ↔ NJP", "Shared cabs", "3 nights hotel", "Breakfast and dinner", "Trip leader"],
    exclusions: ["Toy train joyride", "Lunch"],
    itinerary: [
      { day: 1, title: "Ranchi → NJP", description: "Overnight train." },
      { day: 2, title: "NJP → Darjeeling", description: "Drive up, Mall Road evening." },
      { day: 3, title: "Darjeeling", description: "Tiger Hill sunrise, Batasia loop, tea estate." },
      { day: 4, title: "Darjeeling", description: "Zoo, HMI, Peace Pagoda." },
      { day: 5, title: "Darjeeling → NJP", description: "Drive down, train to Ranchi." },
    ],
  },
  sikkim: {
    slug: "sikkim", name: "Sikkim", title: "North Sikkim Snow Trip", destination: "Gangtok & Lachung, Sikkim",
    nights: 5, days: 6, image: "sikkim",
    summary: "Gangtok, Lachung and Yumthang valley in snow season.",
    inclusions: ["Train 3AC Ranchi ↔ NJP", "Shared cabs", "5 nights hotels", "Breakfast and dinner", "Permits", "Trip leader"],
    exclusions: ["Zero Point cab", "Lunch"],
    itinerary: [
      { day: 1, title: "Ranchi → NJP", description: "Overnight train." },
      { day: 2, title: "NJP → Gangtok", description: "Drive to Gangtok." },
      { day: 3, title: "Gangtok → Lachung", description: "Waterfalls on the way to Lachung." },
      { day: 4, title: "Yumthang valley", description: "Snow, hot springs, back to Lachung." },
      { day: 5, title: "Lachung → Gangtok", description: "MG Marg evening." },
      { day: 6, title: "Gangtok → NJP", description: "Drive down, train to Ranchi." },
    ],
  },
};

type DepSeed = {
  code: string; trip: TripKey; offset: number; seats: number; price: number; cost: number;
  travelBudget?: number; usualRoomRate?: number;
};

// The demo's four upcoming departures (demo dates 28 Nov, 5 Dec, 19 Dec, 9 Jan; demo today 3 Nov).
const DEPARTURES: DepSeed[] = [
  { code: "NP-28N", trip: "nepal", offset: 25, seats: 30, price: 13_999, cost: 10_900, travelBudget: 2_600 },
  { code: "NT-05D", trip: "netarhat", offset: 32, seats: 18, price: 4_999, cost: 3_700 },
  { code: "DJ-19D", trip: "darjeeling", offset: 46, seats: 24, price: 11_499, cost: 8_900 },
  { code: "SK-09J", trip: "sikkim", offset: 67, seats: 20, price: 18_999, cost: 14_600, travelBudget: 2_200, usualRoomRate: 2_500 },
];

async function seedCatalog() {
  const trips = {} as Record<TripKey, { id: string; days: number }>;
  for (const [key, { image, ...data }] of Object.entries(TRIPS) as [TripKey, (typeof TRIPS)[TripKey]][]) {
    const trip = await db.trip.create({ data: { ...data, heroImageKey: `images/departures/${image}.jpg` } });
    trips[key] = { id: trip.id, days: trip.days };
  }

  const departures = {} as Record<string, { id: string; startDate: Date; price: number; cost: number; trip: TripKey }>;
  for (const dep of DEPARTURES) {
    const startDate = d(dep.offset);
    const row = await db.departure.create({
      data: {
        code: dep.code,
        tripId: trips[dep.trip].id,
        startDate,
        endDate: addDays(startDate, trips[dep.trip].days - 1),
        seatsTotal: dep.seats,
        pricePerPax: rupees(dep.price),
        costPerPax: rupees(dep.cost),
        travelBudgetPerPax: rupees(dep.travelBudget ?? 0),
        usualRoomRate: dep.usualRoomRate ? rupees(dep.usualRoomRate) : null,
        status: "OPEN",
      },
    });
    departures[dep.code] = { id: row.id, startDate, price: dep.price, cost: dep.cost, trip: dep.trip };
  }

  await db.addOn.createMany({
    data: [
      { tripId: trips.nepal.id, name: "Phewa lake boating", description: "1-hour boat ride on Phewa lake, Pokhara", costPerPax: rupees(350) },
      { tripId: trips.darjeeling.id, name: "Tiger Hill sunrise", description: "Early-morning cab to Tiger Hill for the Kanchenjunga sunrise", costPerPax: rupees(300) },
    ],
  });

  return { trips, departures };
}

// ───────────────────────────── customers & bookings ─────────────────────────────

type Pay = { amount: number; at: Date; method?: "UPI" | "CARD" | "NETBANKING" | "CASH" | "BANK_TRANSFER" };

/** Every payment created, so the 6-month history can be topped up to the demo's bars. */
const paymentLedger: { amount: number; at: Date }[] = [];

async function createCustomer(data: { name: string; phone?: string; igUsername?: string; tags?: string[]; city?: string; optIn?: boolean }) {
  return db.customer.create({
    data: {
      name: data.name,
      phone: data.phone ?? (data.igUsername ? null : fakePhone()),
      igUsername: data.igUsername ?? null,
      igUserId: data.igUsername ? `seed-igsid-${data.igUsername}` : null,
      city: data.city ?? "Ranchi",
      tags: data.tags ?? [],
      marketingOptIn: data.optIn ?? true,
      marketingOptInAt: data.optIn === false ? null : ago(30 * DAY),
      optInSource: data.optIn === false ? null : "booking form",
    },
  });
}

function travellerNames(leadName: string, pax: number): string[] {
  const parts = leadName.replace(/&.*$/, "").trim().split(/\s+/);
  const surname = leadName.includes("&") ? leadName.split(/\s+/).at(-1)! : parts.at(-1)!;
  const lead = leadName.includes("&") ? `${parts[0]} ${surname}` : leadName;
  const names = [lead];
  if (leadName.includes("&")) names.push(`${leadName.split("&")[1]!.trim().split(/\s+/)[0]} ${surname}`);
  while (names.length < pax) {
    const first = pick(rand() < 0.5 ? FIRST_F : FIRST_M);
    const full = `${first} ${surname}`;
    if (!names.includes(full)) names.push(full);
  }
  return names.slice(0, pax);
}

async function createBooking(input: {
  code: string;
  customerId: string;
  leadName: string;
  leadPhone?: string | null;
  source: BookingSource;
  pax: number;
  pricePerPax: number; // rupees
  costPerPax: number; // rupees
  payments: Pay[];
  createdAt: Date;
  departureId?: string;
  custom?: { title: string; startDate: Date };
  balanceDueDate?: Date | null;
  status?: "CONFIRMED" | "COMPLETED" | "HELD";
  conversationId?: string;
  createdById?: string;
  notes?: string;
}) {
  const total = rupees(input.pricePerPax) * input.pax;
  const paid = input.payments.reduce((s, p) => s + rupees(p.amount), 0);
  if (paid > total) throw new Error(`${input.code}: paid ${paid} > total ${total}`);
  const booking = await db.booking.create({
    data: {
      code: input.code,
      kind: input.custom ? "CUSTOM" : "FIXED",
      status: input.status ?? "CONFIRMED",
      source: input.source,
      customerId: input.customerId,
      departureId: input.departureId ?? null,
      customTitle: input.custom?.title ?? null,
      customStartDate: input.custom?.startDate ?? null,
      conversationId: input.conversationId ?? null,
      pax: input.pax,
      pricePerPax: rupees(input.pricePerPax),
      totalAmount: total,
      paidAmount: paid,
      costTotalPlanned: rupees(input.costPerPax) * input.pax,
      balanceDueDate: input.balanceDueDate ?? null,
      createdById: input.createdById ?? null,
      notes: input.notes ?? null,
      createdAt: input.createdAt,
      travellers: {
        create: travellerNames(input.leadName, input.pax).map((fullName, i) => ({
          fullName,
          isLead: i === 0,
          phone: i === 0 ? (input.leadPhone ?? null) : null,
          age: i === 0 ? int(28, 52) : int(8, 65),
          gender: FIRST_F.includes(fullName.split(" ")[0]!) ? "F" : "M",
          idType: input.custom || input.departureId ? "aadhaar" : null,
          docStatus: input.status === "COMPLETED" ? "VERIFIED" : "PENDING",
        })),
      },
    },
  });
  let n = 0;
  for (const p of input.payments) {
    n += 1;
    await db.payment.create({
      data: {
        bookingId: booking.id,
        amount: rupees(p.amount),
        method: p.method ?? "UPI",
        status: "CAPTURED",
        provider: "RAZORPAY",
        providerPaymentId: `pay_seed_${input.code.replace("LVG-", "")}_${n}`,
        receivedAt: p.at,
        createdAt: p.at,
      },
    });
    paymentLedger.push({ amount: rupees(p.amount), at: p.at });
  }
  return booking;
}

const SRC: Record<string, BookingSource> = { WhatsApp: "WHATSAPP", Instagram: "INSTAGRAM", Website: "WEBSITE" };

// The 8 demo bookings. Offsets are relative to the demo's "today" (3 Nov): when = booked, due = balance due.
const DEMO_BOOKINGS = [
  { code: "LVG-24817", n: "Amit Kumar", ph: "70040 55871", dep: "NP-28N", pax: 4, total: 55_996, paid: 55_996, src: "WhatsApp", when: -1 },
  { code: "LVG-24822", n: "Sneha Oraon", ph: "62010 33019", dep: "NP-28N", pax: 2, total: 27_998, paid: 7_000, src: "Instagram", when: -2, due: 10 },
  { code: "LVG-24830", n: "Rahul Verma", ph: "90310 77452", dep: "DJ-19D", pax: 2, total: 22_998, paid: 5_750, src: "Website", when: -3, due: 31 },
  { code: "LVG-24836", n: "Priya & Karan Singh", ph: "98350 66120", dep: "NT-05D", pax: 2, total: 9_998, paid: 2_500, src: "WhatsApp", when: -4, due: -6 },
  { code: "LVG-24841", n: "Deepak Mahto", ph: "79790 22314", dep: "NP-28N", pax: 3, total: 41_997, paid: 10_500, src: "Website", when: -5, due: -2 },
  { code: "LVG-24844", n: "Ananya Tirkey", ph: "88770 41256", dep: "SK-09J", pax: 3, total: 56_997, paid: 14_250, src: "WhatsApp", when: -6, due: 52 },
  { code: "LVG-24850", n: "Rohit Gupta", ph: "93340 88017", dep: "NT-05D", pax: 5, total: 24_995, paid: 24_995, src: "Instagram", when: -8 },
  { code: "LVG-24853", n: "Meera Jha", ph: "70700 12893", dep: "NP-28N", pax: 2, total: 27_998, paid: 7_000, src: "WhatsApp", when: -14, due: -14 },
] as const;

// Filler bookings (fully paid) so sold counts match the demo: Nepal 21, Netarhat 12, Darjeeling 10, Sikkim 3.
const FILLERS = [
  { code: "LVG-24801", n: "Suman Toppo", dep: "NP-28N", pax: 2, when: -38, src: "WhatsApp" },
  { code: "LVG-24804", n: "Vivek Sharma", dep: "NP-28N", pax: 3, when: -33, src: "Website" },
  { code: "LVG-24807", n: "Pooja Kumari", dep: "NP-28N", pax: 2, when: -27, src: "Instagram" },
  { code: "LVG-24811", n: "Ankit Raj", dep: "NP-28N", pax: 3, when: -21, src: "WhatsApp" },
  { code: "LVG-24803", n: "Nikhil Barla", dep: "NT-05D", pax: 2, when: -35, src: "WhatsApp" },
  { code: "LVG-24812", n: "Shreya Mehta", dep: "NT-05D", pax: 3, when: -19, src: "Instagram" },
  { code: "LVG-24805", n: "Ritu Pandey", dep: "DJ-19D", pax: 2, when: -31, src: "Website" },
  { code: "LVG-24809", n: "Manish Oraon", dep: "DJ-19D", pax: 4, when: -24, src: "WhatsApp" },
  { code: "LVG-24814", n: "Kavita Singh", dep: "DJ-19D", pax: 2, when: -17, src: "Instagram" },
] as const;

const EXPECTED_SOLD: Record<string, number> = { "NP-28N": 21, "NT-05D": 12, "DJ-19D": 10, "SK-09J": 3 };

async function seedBookings(departures: Awaited<ReturnType<typeof seedCatalog>>["departures"], staffId: string) {
  const customers: Record<string, string> = {};

  for (const b of DEMO_BOOKINGS) {
    const dep = departures[b.dep]!;
    const cust = await createCustomer({ name: b.n, phone: e164(b.ph), tags: dep.trip === "netarhat" ? ["weekend"] : ["hills"] });
    customers[b.n] = cust.id;
    const payments: Pay[] =
      b.code === "LVG-24817"
        ? // Amit: advance yesterday, balance today (the demo feed's "₹27,998 received from Amit Kumar").
          [{ amount: 27_998, at: at(b.when, "18:20") }, { amount: 27_998, at: ago(30 * MIN) }]
        : [{ amount: b.paid, at: at(b.when, "12:30") }];
    await createBooking({
      code: b.code,
      customerId: cust.id,
      leadName: b.n,
      leadPhone: e164(b.ph),
      source: SRC[b.src]!,
      pax: b.pax,
      pricePerPax: b.total / b.pax,
      costPerPax: dep.cost,
      payments,
      createdAt: at(b.when, "11:00"),
      departureId: dep.id,
      balanceDueDate: "due" in b ? d(b.due) : addDays(dep.startDate, -15),
      createdById: b.src === "Website" ? undefined : staffId,
    });
  }

  for (const f of FILLERS) {
    const dep = departures[f.dep]!;
    const cust = await createCustomer({ name: f.n, tags: dep.trip === "netarhat" ? ["weekend"] : ["hills"] });
    customers[f.n] = cust.id;
    const total = dep.price * f.pax;
    const advance = Math.round(total / 4);
    await createBooking({
      code: f.code,
      customerId: cust.id,
      leadName: f.n,
      source: SRC[f.src]!,
      pax: f.pax,
      pricePerPax: dep.price,
      costPerPax: dep.cost,
      payments: [
        { amount: advance, at: at(f.when, "13:10") },
        { amount: total - advance, at: at(Math.min(f.when + 12, -1), "16:45") },
      ],
      createdAt: at(f.when, "12:00"),
      departureId: dep.id,
      balanceDueDate: addDays(dep.startDate, -15),
    });
  }

  // Sanity: sold counts must match the demo.
  for (const [code, expected] of Object.entries(EXPECTED_SOLD)) {
    const agg = await db.booking.aggregate({
      _sum: { pax: true },
      where: { departureId: departures[code]!.id, status: { in: ["HELD", "CONFIRMED", "COMPLETED"] } },
    });
    if (agg._sum.pax !== expected) throw new Error(`${code}: sold ${agg._sum.pax}, expected ${expected}`);
  }
  return customers;
}

// ───────────────────────────── custom trips + expenses ─────────────────────────────

async function seedCustomTrips(sauravId: string, staffId: string) {
  const expense = (bookingId: string, category: ExpenseCategory, amount: number, description: string, incurredOn: Date) =>
    db.expense.create({ data: { bookingId, category, amount: rupees(amount), description, incurredOn, createdById: staffId } });

  // Goa family (Saurav K.): revenue ₹96,400, cost ₹78,100. Starts on demo 14 Dec (+41).
  const goaStart = d(41);
  const goa = await createBooking({
    code: "LVG-24855",
    customerId: sauravId,
    leadName: "Saurav Kumar",
    source: "WHATSAPP",
    pax: 4,
    pricePerPax: 24_100,
    costPerPax: 19_525,
    payments: [{ amount: 48_200, at: at(-10, "15:20") }],
    createdAt: at(-11, "19:30"),
    custom: { title: "Goa family (Saurav K.)", startDate: goaStart },
    balanceDueDate: addDays(goaStart, -15),
    createdById: staffId,
  });
  await expense(goa.id, "TICKETS", 31_400, "IndiGo Ranchi → Goa, 4 × ₹7,850 (budgeted)", d(-1));
  await expense(goa.id, "HOTEL", 30_000, "Calangute resort, 2 rooms × 5 nights", d(-9));
  await expense(goa.id, "TRANSPORT", 9_000, "Airport transfers and North Goa cab", d(-9));
  await expense(goa.id, "ACTIVITIES", 7_700, "Dudhsagar jeep safari and river cruise", d(-8));

  // Puri & Konark (Jha family): revenue ₹42,800, cost ₹34,500. Already travelled.
  const jha = await createCustomer({ name: "Sunil Jha", tags: ["pilgrimage", "family"] });
  const puri = await createBooking({
    code: "LVG-24856",
    customerId: jha.id,
    leadName: "Sunil Jha",
    source: "PHONE",
    pax: 4,
    pricePerPax: 10_700,
    costPerPax: 8_625,
    payments: [{ amount: 10_700, at: at(-48, "11:40") }, { amount: 32_100, at: at(-27, "10:05") }],
    createdAt: at(-48, "11:00"),
    custom: { title: "Puri & Konark (Jha family)", startDate: d(-20) },
    balanceDueDate: d(-25),
    status: "COMPLETED",
    createdById: staffId,
  });
  await expense(puri.id, "HOTEL", 18_000, "Puri sea-view hotel, 2 rooms × 3 nights", d(-20));
  await expense(puri.id, "TRANSPORT", 12_000, "Train 3AC + Innova for Konark day", d(-20));
  await expense(puri.id, "FOOD", 4_500, "Meals not covered by hotel", d(-18));

  // Darjeeling couple: revenue ₹31,600, cost ₹23,900. Already travelled.
  const roy = await createCustomer({ name: "Aditya Roy", tags: ["hills", "couple"] });
  const djc = await createBooking({
    code: "LVG-24857",
    customerId: roy.id,
    leadName: "Aditya & Nisha Roy",
    source: "INSTAGRAM",
    pax: 2,
    pricePerPax: 15_800,
    costPerPax: 11_950,
    payments: [{ amount: 7_900, at: at(-62, "20:15") }, { amount: 23_700, at: at(-41, "09:50") }],
    createdAt: at(-62, "20:00"),
    custom: { title: "Darjeeling couple", startDate: d(-35) },
    balanceDueDate: d(-40),
    status: "COMPLETED",
    createdById: staffId,
  });
  await expense(djc.id, "HOTEL", 14_000, "Boutique stay, 4 nights", d(-35));
  await expense(djc.id, "TRANSPORT", 7_400, "Train 3AC + private cab NJP ↔ Darjeeling", d(-35));
  await expense(djc.id, "ACTIVITIES", 2_500, "Toy train joyride and Tiger Hill", d(-33));

  return { goaBookingId: goa.id, goaStart };
}

// ───────────────────────────── payment history (6-month chart) ─────────────────────────────

/** Demo bars, oldest → current month, in rupees: ₹1.9L, 2.3L, 3.1L, 2.8L, 4.1L, 4.9L. */
const MONTHLY_TARGETS = [190_000, 230_000, 310_000, 280_000, 410_000, 490_000];

const monthKey = (instant: Date) => istDateString(instant).slice(0, 7);

function monthStartOffset(monthsAgo: number): { first: Date; last: Date } {
  const [y, m] = istDateStringOf(TODAY).split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 - monthsAgo, 1));
  const lastOfMonth = new Date(Date.UTC(y, m - monthsAgo, 0));
  return { first, last: monthsAgo === 0 ? TODAY : lastOfMonth };
}

async function seedPaymentHistory(trips: Awaited<ReturnType<typeof seedCatalog>>["trips"]) {
  const tally = new Map<string, number>();
  for (const p of paymentLedger) tally.set(monthKey(p.at), (tally.get(monthKey(p.at)) ?? 0) + p.amount);

  const rotation: { trip: TripKey; price: number; cost: number; prefix: string }[] = [
    { trip: "darjeeling", price: 10_999, cost: 8_600, prefix: "DJ" },
    { trip: "netarhat", price: 4_799, cost: 3_550, prefix: "NT" },
    { trip: "nepal", price: 13_499, cost: 10_600, prefix: "NP" },
    { trip: "netarhat", price: 4_799, cost: 3_550, prefix: "NT" },
    { trip: "darjeeling", price: 10_999, cost: 8_600, prefix: "DJ" },
    { trip: "netarhat", price: 4_999, cost: 3_700, prefix: "NT" },
  ];
  let code = 24_600;
  const usedDepCodes = new Set(DEPARTURES.map((x) => x.code));

  for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) {
    const { first, last } = monthStartOffset(monthsAgo);
    const key = istDateStringOf(first).slice(0, 7);
    const target = rupees(MONTHLY_TARGETS[5 - monthsAgo]!);
    let remaining = target - (tally.get(key) ?? 0);
    if (remaining <= 0) continue;

    // A past departure in that month whose (fully paid) bookings carry the month's collections.
    const r = rotation[5 - monthsAgo]!;
    const span = Math.max(0, Math.round((last.getTime() - first.getTime()) / DAY));
    const startDate = addDays(first, Math.min(span, 18));
    const endDate = addDays(startDate, TRIPS[r.trip].days as number - 1);
    let depCode = `${r.prefix}-${formatDate(startDate, "dd")}${formatDate(startDate, "MMM")[0]}`;
    while (usedDepCodes.has(depCode)) depCode += "X";
    usedDepCodes.add(depCode);
    const done = endDate < TODAY;
    const dep = await db.departure.create({
      data: {
        code: depCode, tripId: trips[r.trip].id, startDate, endDate, seatsTotal: 30,
        pricePerPax: rupees(r.price), costPerPax: rupees(r.cost), status: done ? "COMPLETED" : "CLOSED",
      },
    });

    const payDay = (i: number) => {
      const day = addDays(first, Math.min(span, 1 + ((i * 3) % Math.max(1, span + 1))));
      return at(Math.round((day.getTime() - TODAY.getTime()) / DAY), `${String(10 + (i % 9)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`);
    };

    let i = 0;
    while (remaining >= rupees(r.price)) {
      const pax = Math.min(int(2, 6), Math.floor(remaining / rupees(r.price)));
      const name = `${pick(rand() < 0.5 ? FIRST_F : FIRST_M)} ${pick(["Kujur", "Minz", "Sahu", "Prasad", "Mahato", "Lakra", "Das", "Sinha", "Yadav", "Bhagat", "Ekka", "Tigga"])}`;
      const cust = await createCustomer({ name, tags: r.trip === "netarhat" ? ["weekend"] : ["hills"] });
      code += 1;
      await createBooking({
        code: `LVG-${code}`, customerId: cust.id, leadName: name, source: pick(["WHATSAPP", "INSTAGRAM", "WEBSITE", "WALK_IN"] as const),
        pax, pricePerPax: r.price, costPerPax: r.cost, payments: [{ amount: r.price * pax, at: payDay(i) }],
        createdAt: payDay(i), departureId: dep.id, balanceDueDate: addDays(startDate, -15), status: done ? "COMPLETED" : "CONFIRMED",
      });
      remaining -= rupees(r.price) * pax;
      i += 1;
    }
    if (remaining > 0) {
      // Remainder: a one-off custom day trip at whatever it cost, so the bar is exact.
      const cust = await createCustomer({ name: "Ranchi Public School (staff outing)", tags: ["corporate"], optIn: false });
      code += 1;
      await createBooking({
        code: `LVG-${code}`, customerId: cust.id, leadName: "Ranchi Public School", source: "PHONE", pax: 1,
        pricePerPax: remaining / 100, costPerPax: Math.round((remaining / 100) * 0.8), payments: [{ amount: remaining / 100, at: payDay(i), method: "BANK_TRANSFER" }],
        createdAt: payDay(i), custom: { title: "Patratu valley day outing", startDate: addDays(first, Math.min(span, 20)) },
        status: "COMPLETED", notes: "Group outing billed as one package",
      });
    }
  }
}

// ───────────────────────────── conversations ─────────────────────────────

type Msg = { who: "c" | "s" | "sys"; text: string; at: Date; kind?: "QUOTE" | "TEMPLATE" | "SYSTEM_NOTE"; payload?: Prisma.InputJsonValue };

async function createConversation(input: {
  channel: Channel;
  threadId: string;
  customerId: string;
  status: ConversationStatus;
  leadTemp: "NEW" | "COLD" | "WARM" | "HOT";
  pax?: number;
  departureId?: string;
  sourceNote?: string;
  messages: Msg[];
  staffId: string;
  unread?: number;
  lastAt?: Date;
}) {
  const inbound = input.messages.filter((m) => m.who === "c").map((m) => m.at);
  const lastAt = input.lastAt ?? input.messages.at(-1)?.at ?? NOW;
  const conv = await db.conversation.create({
    data: {
      channel: input.channel,
      externalThreadId: input.threadId,
      customerId: input.customerId,
      status: input.status,
      leadTemp: input.leadTemp,
      paxCount: input.pax ?? null,
      interestedDepartureId: input.departureId ?? null,
      sourceNote: input.sourceNote ?? null,
      lastInboundAt: inbound.length ? inbound.at(-1)! : null,
      lastMessageAt: lastAt,
      unreadCount: input.unread ?? 0,
      createdAt: input.messages[0]?.at ?? lastAt,
    },
  });
  let n = 0;
  for (const m of input.messages) {
    n += 1;
    await db.message.create({
      data: {
        conversationId: conv.id,
        direction: m.who === "c" ? "INBOUND" : "OUTBOUND",
        author: m.who === "c" ? "CUSTOMER" : m.who === "s" ? "OWNER" : "SYSTEM",
        authorUserId: m.who === "s" ? input.staffId : null,
        kind: m.kind ?? (m.who === "sys" ? "SYSTEM_NOTE" : "TEXT"),
        body: m.text,
        payload: m.payload,
        externalId: m.who === "sys" ? null : `wamid.seed.${input.threadId.replace(/\W/g, "")}.${n}`,
        status: m.who === "c" ? "RECEIVED" : m.who === "sys" ? "SENT" : "READ",
        createdAt: m.at,
      },
    });
  }
  return conv;
}

async function seedConversations(
  departures: Awaited<ReturnType<typeof seedCatalog>>["departures"],
  staffId: string,
  sauravId: string,
) {
  const np = departures["NP-28N"]!;
  const nt = departures["NT-05D"]!;
  const dj = departures["DJ-19D"]!;
  const sk = departures["SK-09J"]!;
  const date = (x: { startDate: Date }) => formatDate(x.startDate);

  // Riya Sinha: empty thread for the live demo (11:42 PM in the demo).
  const riya = await createCustomer({ name: "Riya Sinha", phone: "+919835011223", tags: ["hills", "family"], optIn: false });
  await createConversation({
    channel: "WHATSAPP", threadId: "+919835011223", customerId: riya.id, status: "NEW", leadTemp: "NEW",
    departureId: np.id, sourceNote: "came from your Instagram reel", messages: [], staffId, lastAt: NOW,
  });

  // Vikas Prasad: paid (10:18 PM).
  const vikas = await createCustomer({ name: "Vikas Prasad", phone: "+919934022871", tags: ["weekend"] });
  const v0 = NOW.getTime() - 84 * MIN;
  await createConversation({
    channel: "WHATSAPP", threadId: "+919934022871", customerId: vikas.id, status: "PAID", leadTemp: "HOT", pax: 2, departureId: nt.id,
    staffId, messages: [
      { who: "c", text: `Netarhat ${date(nt)} ke liye 2 seats available hai?`, at: new Date(v0 - 70 * MIN) },
      { who: "s", text: `Yes! 6 seats left on Netarhat Weekend, ${date(nt)}. ₹4,999 per person, all meals and stay included. Shall I hold 2 for you?`, at: new Date(v0 - 64 * MIN) },
      { who: "c", text: "Haan, hold kar dijiye. Payment link bhejiye", at: new Date(v0 - 40 * MIN) },
      { who: "s", text: "Here is your payment link for the ₹2,500 advance. Seats are held for 24 hours.", at: new Date(v0 - 37 * MIN) },
      { who: "c", text: "Paid 👍", at: new Date(v0 - 2 * MIN) },
      { who: "sys", text: "Payment received, invoice sent ✓", at: new Date(v0) },
    ],
  });

  // tanya.travels (Instagram): quote sent for Sikkim (9:51 PM).
  const tanya = await createCustomer({ name: "Tanya Bhattacharya", igUsername: "tanya.travels", tags: ["hills", "snow"] });
  const t0 = NOW.getTime() - 111 * MIN;
  const tanyaConv = await createConversation({
    channel: "INSTAGRAM", threadId: "seed-igsid-tanya.travels", customerId: tanya.id, status: "QUOTED", leadTemp: "WARM", pax: 2, departureId: sk.id,
    staffId, messages: [
      { who: "c", text: "Hi! Is the North Sikkim snow trip still open? 2 people", at: new Date(t0 - 25 * MIN) },
      { who: "s", text: `Sikkim ${date(sk)} has 17 seats left. ₹18,999 per person, with the early-bird ₹750 off it's ₹18,249. Quote below 👇`, at: new Date(t0 - 2 * MIN) },
      {
        who: "s", text: "Quote · North Sikkim Snow Trip · 2 travellers · ₹36,498", at: new Date(t0), kind: "QUOTE",
        payload: { departure: "SK-09J", pax: 2, listPricePerPax: rupees(18_999), discounts: [{ label: "Early-bird (45+ days)", amountPerPax: rupees(750) }], pricePerPax: rupees(18_249), totalAmount: rupees(36_498) },
      },
    ],
  });
  await db.quote.create({
    data: {
      conversationId: tanyaConv.id, customerId: tanya.id, departureId: sk.id, pax: 2,
      listPricePerPax: rupees(18_999), pricePerPax: rupees(18_249),
      discounts: [{ label: "Early-bird (45+ days)", amountPerPax: rupees(750) }],
      totalAmount: rupees(36_498), validUntil: new Date(t0 + 24 * HOUR), status: "SENT", createdBy: "OWNER", createdAt: new Date(t0),
    },
  });

  // Saurav Kumar: Goa custom trip for 4 (8:30 PM).
  const s0 = NOW.getTime() - 192 * MIN;
  await createConversation({
    channel: "WHATSAPP", threadId: "+919709344120", customerId: sauravId, status: "QUOTED", leadTemp: "HOT", pax: 4,
    staffId, unread: 1, messages: [
      { who: "s", text: "Your Goa plan is ready: 5 days, flights from Ranchi, Calangute resort, Dudhsagar safari. ₹24,100 per person, all inclusive.", at: new Date(s0 - 26 * HOUR) },
      { who: "c", text: "Looks good. Advance bhej diya hai", at: new Date(s0 - 25 * HOUR) },
      { who: "c", text: "Goa custom trip for 4? Flight timing confirm kar dijiye", at: new Date(s0) },
    ],
  });

  // Neha Lakra (Instagram): follow-up due on Darjeeling (yesterday).
  const neha = await createCustomer({ name: "Neha Lakra", igUsername: "neha.lakra", tags: ["hills"] });
  const n0 = NOW.getTime() - 22 * HOUR;
  await createConversation({
    channel: "INSTAGRAM", threadId: "seed-igsid-neha.lakra", customerId: neha.id, status: "FOLLOW_UP", leadTemp: "COLD", pax: 3, departureId: dj.id,
    staffId, messages: [
      { who: "c", text: "Darjeeling trip ka itinerary bhejo, 3 log hain", at: new Date(n0 - 30 * HOUR) },
      { who: "s", text: `Darjeeling Winter Escape, ${date(dj)}: 5 days, Tiger Hill sunrise, tea estate. ₹11,499 per person. Want me to hold 3 seats?`, at: new Date(n0 - 29 * HOUR) },
      { who: "s", text: "Following up on your Darjeeling plan. 14 seats left, shall I hold 3 for you?", at: new Date(n0), kind: "TEMPLATE" },
    ],
  });

  // Arjun Mishra: balance reminder with UPI link (yesterday).
  const arjun = await createCustomer({ name: "Arjun Mishra", phone: "+919431055602", tags: ["hills"] });
  const a0 = NOW.getTime() - 25 * HOUR;
  await createConversation({
    channel: "WHATSAPP", threadId: "+919431055602", customerId: arjun.id, status: "PAID", leadTemp: "WARM", pax: 2, departureId: np.id,
    staffId, messages: [
      { who: "c", text: "Nepal trip balance kab tak dena hai?", at: new Date(a0 - 3 * HOUR) },
      { who: "s", text: `Balance is due ${formatDate(addDays(np.startDate, -15))}. Sending you the UPI link now.`, at: new Date(a0 - 2 * HOUR) },
      { who: "sys", text: "Balance reminder sent with UPI link", at: new Date(a0) },
    ],
  });
}

// ───────────────────────────── suppliers ─────────────────────────────

async function seedSuppliers() {
  const rows = [
    { name: "Himalayan Stays", type: "AGENT", contactName: "Pema Bhutia", slug: "himalayan-stays" },
    { name: "Gangtok Hill Retreat", type: "HOTEL", contactName: "Karma Lepcha", slug: "gangtok-hill-retreat", notes: "Breakfast included" },
    { name: "Northern Trails DMC", type: "DMC", contactName: "Sonam Tamang", slug: "northern-trails", notes: "Can include the Lachung night" },
    { name: "Tashi Residency", type: "HOTEL", contactName: "Tashi Dorjee", slug: "tashi-residency", notes: "Breakfast + dinner" },
    { name: "Sikkim Holiday Partners", type: "AGENT", contactName: "Anil Pradhan", slug: "sikkim-holiday-partners" },
    { name: "Mountview Gangtok", type: "HOTEL", contactName: "Rinzing Sherpa", slug: "mountview-gangtok", notes: "Slow to reply" },
  ] as const;
  let i = 0;
  for (const s of rows) {
    i += 1;
    await db.supplier.create({
      data: {
        name: s.name,
        type: s.type,
        destinations: ["Gangtok, Sikkim", "North Sikkim"],
        contactName: s.contactName,
        phone: `+9190000000${String(i).padStart(2, "0")}`,
        email: `reservations@${s.slug}.example`,
        preferredChannel: "WHATSAPP",
        notes: "notes" in s ? s.notes : null,
      },
    });
  }
}

// ───────────────────────────── tickets desk ─────────────────────────────

type OptSeed = { mode: TravelMode; title: string; details: string; ticket: number; extras?: number; extrasNote?: string; tags: string[]; disqualified?: string };

async function createPlan(
  plan: Omit<Prisma.TravelPlanUncheckedCreateInput, "options">,
  options: OptSeed[],
  trend?: { optionIndex: number; fares: number[] },
) {
  const row = await db.travelPlan.create({ data: plan });
  for (const [idx, o] of options.entries()) {
    const opt = await db.travelOption.create({
      data: {
        planId: row.id, mode: o.mode, title: o.title, details: o.details, ticketPerPax: rupees(o.ticket),
        extrasPerPax: rupees(o.extras ?? 0), extrasNote: o.extrasNote ?? null, tags: o.tags,
        disqualified: Boolean(o.disqualified), disqualifiedReason: o.disqualified ?? null,
      },
    });
    const fares = trend?.optionIndex === idx ? trend.fares : [o.ticket];
    for (const [k, fare] of fares.entries()) {
      await db.fareSnapshot.create({
        data: { optionId: opt.id, farePerPax: rupees(fare), capturedAt: at(k - (fares.length - 1), "09:00") },
      });
    }
  }
  return row;
}

async function seedTravelPlans(
  departures: Awaited<ReturnType<typeof seedCatalog>>["departures"],
  goa: { goaBookingId: string; goaStart: Date },
  arpDays: number,
) {
  await createPlan(
    {
      label: "Goa family · custom", bookingId: goa.goaBookingId, origin: "Ranchi", destination: "Goa", travelDate: goa.goaStart,
      budgetPerPax: rupees(9_500), note: "All-inclusive package quote, so anything saved below the travel budget is your margin.",
    },
    [
      { mode: "FLIGHT", title: "IndiGo · Ranchi → Mumbai → Goa (GOI)", details: "07:05 → 13:40 · 1 stop · 6h 35m", ticket: 7_850, tags: ["Cheapest landed"] },
      { mode: "FLIGHT", title: "Air India Express · Ranchi → Bengaluru → Goa (GOX)", details: "10:20 → 16:55 · 1 stop · Mopa airport, +₹600 cab", ticket: 8_400, extras: 600, extrasNote: "Longer cab to North Goa", tags: [] },
      { mode: "FLIGHT", title: "IndiGo · Ranchi → Delhi → Goa (GOI)", details: "16:30 → 23:40 · lands at midnight", ticket: 7_300, extras: 1_650, extrasNote: "Extra hotel night (share of 2 rooms)", tags: ["Cheap ticket, expensive arrival"] },
      { mode: "TRAIN", title: "Train 3AC · Ranchi → Madgaon", details: "38 hours · 2 nights on the train", ticket: 2_450, extras: 4_800, extrasNote: "2 trip days lost, extra hotel and meals", tags: ["Too long for a 5-day trip"], disqualified: "Too long for a 5-day trip" },
    ],
    // 14 daily snapshots: the demo's rising trend (+₹730 in 2 weeks).
    { optionIndex: 0, fares: [7_120, 7_120, 7_240, 7_240, 7_380, 7_310, 7_450, 7_520, 7_520, 7_690, 7_690, 7_780, 7_850, 7_850] },
  );

  const np = departures["NP-28N"]!;
  await createPlan(
    {
      label: "Nepal · group", departureId: np.id, origin: "Ranchi", destination: "Raxaul", travelDate: np.startDate,
      budgetPerPax: rupees(2_600), note: "Fixed group price. Travel budget is ₹2,600 per person, return.",
    },
    [
      { mode: "TRAIN", title: "Train 3AC · Ranchi → Raxaul, return", details: "Overnight both ways · 1 change", ticket: 1_960, tags: ["Best value"] },
      { mode: "BUS", title: "Private AC bus · Ranchi → Raxaul, return", details: "Door to door · 11h each way · whole bus hired", ticket: 2_250, tags: ["Most comfortable"] },
      { mode: "TRAIN", title: "Train Sleeper · Ranchi → Raxaul, return", details: "Overnight both ways · 1 change", ticket: 1_140, tags: ["Cheapest", "Comfort complaints likely"] },
    ],
  );

  const sk = departures["SK-09J"]!;
  const windowDay = addDays(sk.startDate, -arpDays);
  const windowOpensAt = istDateTime(istDateStringOf(windowDay), "08:00");
  await createPlan(
    {
      label: "Sikkim · group", departureId: sk.id, origin: "Ranchi", destination: "New Jalpaiguri", travelDate: sk.startDate,
      budgetPerPax: rupees(2_200), status: "WINDOW_PENDING", windowOpensAt,
      note: `Train bookings open ${arpDays} days before travel. For a group, the first morning decides whether you get seats together.`,
    },
    [
      { mode: "TRAIN", title: "Train 3AC · Ranchi → New Jalpaiguri, return", details: `Overnight · bookings open ${formatDate(windowDay, "EEE d MMM")}, 8:00 AM`, ticket: 1_520, extras: 450, extrasNote: "Shared cab NJP → Gangtok", tags: ["Plan to book"] },
      { mode: "FLIGHT", title: "Flight · Ranchi → Kolkata → Bagdogra, return", details: "Same day · fares not yet tracked", ticket: 6_900, extras: 450, extrasNote: "Cab Bagdogra → Gangtok", tags: ["Over budget"], disqualified: "Over budget" },
    ],
  );
}

// ───────────────────────────── activity feed ─────────────────────────────

async function seedActivity(departures: Awaited<ReturnType<typeof seedCatalog>>["departures"]) {
  const np = formatDate(departures["NP-28N"]!.startDate);
  // The demo's 6 feed items, re-authored without AI; same gaps as the demo (11:40 … 09:15 vs 11:42).
  const items: [number, string, string, "USER" | "SYSTEM" | "SUPPLIER", string][] = [
    [2, "💬", "Team replied to 3 Instagram enquiries about the Sikkim trip", "USER", "conversation.replied"],
    [30, "💸", "₹27,998 received from Amit Kumar · invoice INV-24817 sent", "SYSTEM", "payment.received"],
    [47, "🏨", `Hotel Lakeview Pokhara confirmed 11 rooms for ${np}`, "SUPPLIER", "supplier.replied"],
    [72, "⏰", "Balance reminder sent to Meera Jha (₹20,998, 14 days late)", "SYSTEM", "reminder.sent"],
    [114, "📄", "Document checklist sent to 21 Nepal travellers", "SYSTEM", "documents.checklist_sent"],
    [147, "🔁", "6 enquiries went quiet · flagged for follow-up", "SYSTEM", "followups.flagged"],
  ];
  for (const [minsAgo, icon, text, actorType, type] of items) {
    await db.activityEvent.create({ data: { type, icon, text, actorType, createdAt: ago(minsAgo * MIN) } });
  }
}

// ───────────────────────────── reminder history (P2) ─────────────────────────────

/**
 * What the reminders.daily job would already have done for the open bookings: one ReminderLog per
 * rule whose fire date (due + offset) is before today. Gives the dues table real reminder counts
 * (Meera Jha: 3 sent + flagged, as in the demo).
 */
async function seedReminderHistory() {
  const rules = await db.reminderRule.findMany({ where: { enabled: true, anchor: "DUE_DATE" } });
  const open = await db.booking.findMany({ where: { status: { in: ["HELD", "CONFIRMED"] }, balanceDueDate: { not: null } } });
  for (const b of open) {
    if (b.paidAmount >= b.totalAmount) continue;
    for (const r of rules) {
      const fireDay = addDays(b.balanceDueDate!, r.offsetDays);
      if (fireDay >= TODAY) continue;
      await db.reminderLog.create({
        data: {
          bookingId: b.id, ruleId: r.id, scheduledFor: fireDay, status: "SENT",
          detail: r.action === "FLAG_OWNER" ? "flagged on Today" : `${r.templateName} (seed)`,
          createdAt: istDateTime(istDateStringOf(fireDay), "10:00"),
        },
      });
    }
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  console.log(`Seeding Lavigo OS demo data · today (IST) = ${istDateStringOf(TODAY)}`);
  await wipe();
  const { owner, staff, generated } = await seedUsers();
  await seedRules(owner.id);
  const { trips, departures } = await seedCatalog();
  const customers = await seedBookings(departures, staff.id);
  const saurav = await createCustomer({ name: "Saurav Kumar", phone: "+919709344120", tags: ["beach", "family"] });
  customers["Saurav Kumar"] = saurav.id;
  const goa = await seedCustomTrips(saurav.id, staff.id);
  await seedPaymentHistory(trips);
  await seedConversations(departures, staff.id, saurav.id);
  await seedSuppliers();
  await seedTravelPlans(departures, goa, Number(process.env.IRCTC_ARP_DAYS) || 60);
  await seedActivity(departures);
  await seedReminderHistory();

  const counts = {
    users: await db.user.count(), customers: await db.customer.count(), departures: await db.departure.count(),
    bookings: await db.booking.count(), payments: await db.payment.count(), conversations: await db.conversation.count(),
    messages: await db.message.count(), suppliers: await db.supplier.count(), travelPlans: await db.travelPlan.count(),
    fareSnapshots: await db.fareSnapshot.count(), expenses: await db.expense.count(), templates: await db.messageTemplate.count(),
  };
  console.log("Done.", counts);

  const months = await db.$queryRaw<{ month: string; total: bigint }[]>`
    SELECT to_char("receivedAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, SUM(amount)::bigint AS total
    FROM "Payment" WHERE status = 'CAPTURED' GROUP BY 1 ORDER BY 1 DESC LIMIT 6`;
  console.log("Collected per month:", months.map((m) => `${m.month} ₹${(Number(m.total) / 100 / 100_000).toFixed(1)}L`).reverse().join(" · "));

  if (generated.length) {
    console.log("\nGenerated login passwords (set SEED_OWNER_PASSWORD / SEED_STAFF_PASSWORD to choose your own):");
    console.log(generated.join("\n"));
  } else {
    console.log("\nLogins: owner@lavigo.local / staff@lavigo.local with the SEED_* passwords from your env.");
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
