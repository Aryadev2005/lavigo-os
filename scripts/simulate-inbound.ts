/**
 * Post a realistic, correctly signed WhatsApp Cloud API webhook to our own endpoint (INB-1).
 *
 *   pnpm tsx scripts/simulate-inbound.ts --from "+91 98350 11223" --name "Riya Sinha" --text "Nepal trip ka kya rate hai?"
 *   pnpm tsx scripts/simulate-inbound.ts --supplier --text "Rate for 6 rooms: ₹3,200 CP"   # first supplier's phone
 *   pnpm tsx scripts/simulate-inbound.ts --referral --text "Hi, saw your reel"            # click-to-chat ad referral
 *   pnpm tsx scripts/simulate-inbound.ts --twice                                           # same wamid twice (dedupe)
 *   pnpm tsx scripts/simulate-inbound.ts --status READ --id wamid.fake.…                   # delivery status
 *
 * Inside the web container the app listens on :3000 (default --url). Signs with META_APP_SECRET,
 * or the dev secret when it's empty. Never runs against production.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { metaAppSecret, signMetaBody } from "../src/server/channels/verify";
import { db } from "../src/server/db";
import { env } from "../src/server/env";
import { normalizePhone } from "../src/server/phone";

async function main() {
  if (env.isProd) throw new Error("simulate-inbound is for dev and staging only");
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "http://127.0.0.1:3000" },
      from: { type: "string", default: "+91 98350 11223" },
      name: { type: "string", default: "Riya Sinha" },
      text: { type: "string", default: "Hi, Nepal trip ka kya rate hai? 28 Nov wala 🙏" },
      supplier: { type: "boolean", default: false },
      referral: { type: "boolean", default: false },
      twice: { type: "boolean", default: false },
      status: { type: "string" },
      id: { type: "string" },
    },
  });

  let from = normalizePhone(values.from!);
  let name = values.name!;
  if (values.supplier) {
    const s = await db.supplier.findFirst({ where: { phone: { not: null }, active: true }, orderBy: { name: "asc" } });
    if (!s?.phone) throw new Error("No supplier with a phone number. Run make seed.");
    from = s.phone;
    name = s.contactName ?? s.name;
  }
  if (!from) throw new Error(`Not a phone number: ${values.from}`);
  const waId = from.replace(/\D/g, "");
  const now = Math.floor(Date.now() / 1000).toString();

  const value: Record<string, unknown> = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "916200000000", phone_number_id: env.WA_PHONE_NUMBER_ID ?? "000000000000000" },
  };
  if (values.status) {
    if (!values.id) throw new Error("--status needs --id <wamid>");
    value.statuses = [{ id: values.id, status: values.status.toLowerCase(), timestamp: now, recipient_id: waId }];
  } else {
    value.contacts = [{ profile: { name }, wa_id: waId }];
    value.messages = [
      {
        from: waId,
        id: `wamid.SIM${randomBytes(12).toString("hex").toUpperCase()}`,
        timestamp: now,
        type: "text",
        text: { body: values.text },
        ...(values.referral
          ? { referral: { source_url: "https://www.instagram.com/reel/lavigo-nepal", source_type: "ad", source_id: "120200000000", headline: "Nepal in 5 days from Ranchi", body: "Pokhara · Kathmandu · from ₹13,999" } }
          : {}),
      },
    ];
  }
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA_SIM", changes: [{ field: "messages", value }] }] });
  const headers = { "content-type": "application/json", "x-hub-signature-256": signMetaBody(body, metaAppSecret()) };

  for (let i = 0; i < (values.twice ? 2 : 1); i++) {
    const res = await fetch(`${values.url}/api/webhooks/whatsapp`, { method: "POST", headers, body });
    console.log(`POST /api/webhooks/whatsapp → ${res.status} ${await res.text()}`);
  }
  console.log(values.status ? `Status ${values.status} for ${values.id}` : `From ${values.supplier ? "supplier" : "customer"} ${name} (${from}): "${values.text}"`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
