/**
 * Production seed (design §14 step 4): `pnpm seed:prod`. NON-DESTRUCTIVE and safe to re-run:
 *
 *  - owner user from SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD (+ SEED_OWNER_NAME / SEED_OWNER_PHONE);
 *    an existing owner keeps their password unless SEED_OWNER_RESET_PASSWORD=true;
 *  - AgentSettings row (schema defaults), standing offers and reminder rules: created if missing,
 *    never overwritten (the owner edits them in the app);
 *  - WhatsApp templates from prisma/seed.ts: created or updated by name (body, variables, category,
 *    purpose, language). New ones start PENDING; `--approve-templates` marks them APPROVED once Meta
 *    has approved them (in a DEMO_FAKES demo they are approved straight away);
 *  - demo data ONLY with SEED_DEMO=true, and only into an empty database. It never wipes: to reset a
 *    demo instance use `make demo-reset` (or seed.js with SEED_DEMO=true and --force).
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/server/password";
import { BASE_OFFERS, REMINDER_RULES, seedDemo, TEMPLATES, templateRow } from "./seed";

const db = new PrismaClient();
const flag = (k: string) => process.env[k] === "true" || process.env[k] === "1";

async function main() {
  const approve = process.argv.includes("--approve-templates") || flag("DEMO_FAKES");

  // ── demo data first (it creates its own owner/staff), only into an empty database ──
  if (flag("SEED_DEMO")) {
    const used = (await db.customer.count()) + (await db.booking.count()) + (await db.conversation.count());
    if (used > 0) {
      console.error("SEED_DEMO=true but the database already has data. seed:prod never wipes; use `make demo-reset` for a demo instance.");
      process.exit(1);
    }
    await seedDemo();
  }

  // ── owner ──
  const email = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD ?? "";
  const existingOwner = email ? await db.user.findUnique({ where: { email } }) : null;
  if (!email) {
    if (!(await db.user.count({ where: { role: "OWNER", active: true } }))) {
      console.error("Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD (≥ 12 characters) to create the owner account.");
      process.exit(1);
    }
    console.log("owner: SEED_OWNER_EMAIL unset, keeping the existing owner(s)");
  } else if (!existingOwner) {
    if (password.length < 12) {
      console.error("SEED_OWNER_PASSWORD must be at least 12 characters.");
      process.exit(1);
    }
    await db.user.create({
      data: {
        email,
        name: process.env.SEED_OWNER_NAME?.trim() || "Owner",
        phone: process.env.SEED_OWNER_PHONE?.trim() || null,
        role: "OWNER",
        passwordHash: await hashPassword(password),
      },
    });
    console.log(`owner: created ${email}`);
  } else {
    const reset = flag("SEED_OWNER_RESET_PASSWORD");
    if (reset && password.length < 12) {
      console.error("SEED_OWNER_RESET_PASSWORD=true needs SEED_OWNER_PASSWORD of at least 12 characters.");
      process.exit(1);
    }
    await db.user.update({
      where: { id: existingOwner.id },
      data: { role: "OWNER", active: true, ...(reset ? { passwordHash: await hashPassword(password) } : {}) },
    });
    console.log(`owner: ${email} exists${reset ? ", password reset" : ", password kept"}`);
  }

  // ── settings, offers, reminder rules: create if missing, never overwrite ──
  const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  await db.agentSettings.createMany({ data: [{ id: 1, updatedById: owner.id }], skipDuplicates: true });
  if (!(await db.offer.count({ where: { departureId: null } }))) await db.offer.createMany({ data: [...BASE_OFFERS] });
  const rules = await db.reminderRule.createMany({ data: [...REMINDER_RULES], skipDuplicates: true });

  // ── templates: the list in prisma/seed.ts is the source of truth ──
  let created = 0;
  let updated = 0;
  for (const t of TEMPLATES) {
    const row = templateRow(t, approve ? "APPROVED" : "PENDING");
    const existing = await db.messageTemplate.findUnique({ where: { name: t.name } });
    if (!existing) {
      await db.messageTemplate.create({ data: row });
      created += 1;
    } else {
      const { metaStatus, ...content } = row;
      await db.messageTemplate.update({ where: { name: t.name }, data: { ...content, ...(approve ? { metaStatus } : {}) } });
      updated += 1;
    }
  }
  const stray = await db.messageTemplate.findMany({ where: { name: { notIn: TEMPLATES.map((t) => t.name) } }, select: { name: true } });

  console.log(`settings: ok · offers: ok · reminder rules: ${rules.count} added`);
  console.log(`templates: ${created} created, ${updated} updated (${approve ? "marked APPROVED" : "new ones PENDING; re-run with --approve-templates after Meta approves them"})`);
  if (stray.length) console.log(`templates not in prisma/seed.ts (left as they are): ${stray.map((s) => s.name).join(", ")}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
