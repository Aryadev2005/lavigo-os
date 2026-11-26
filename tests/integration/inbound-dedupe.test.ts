/** INB-1, INB-4, INB-11: inbound dedupe, supplier routing, the 24h window, webhook recovery. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueued: { name: string; data: unknown; jobId?: string }[] = [];
const queueMock = vi.hoisted(() => ({ enqueueReplacingFinished: vi.fn() }));
vi.mock("@/server/queue", () => ({
  enqueue: vi.fn(async (name: string, data: unknown, opts?: { jobId?: string }) => {
    enqueued.push({ name, data, jobId: opts?.jobId });
  }),
  enqueueReplacingFinished: queueMock.enqueueReplacingFinished,
  closeQueues: vi.fn(),
}));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));

const { db } = await import("@/server/db");
const { ingestInbound } = await import("@/server/domain/conversations/ingest");
const { send } = await import("@/server/channels/outbound");
const { ingestMetaWebhook } = await import("@/server/channels/webhook");
const { metaAppSecret, signMetaBody } = await import("@/server/channels/verify");

const uid = () => randomBytes(5).toString("hex");
const phone = () => `+9198${String(parseInt(uid(), 16)).padStart(8, "0").slice(-8)}`;
const inbound = (from: string, externalId = `wamid.T${uid()}`, at = new Date()) => ({
  channel: "WHATSAPP" as const,
  externalId,
  from,
  profileName: "Test Customer",
  kind: "TEXT" as const,
  text: "Nepal trip ka rate?",
  timestamp: at.toISOString(),
});

beforeAll(async () => {
  await db.messageTemplate.upsert({
    where: { name: "follow_up_test" },
    update: {},
    create: { name: "follow_up_test", category: "UTILITY", purpose: "FOLLOW_UP", bodyPreview: "Hi {{1}}, still keen on {{2}}?", variables: ["name", "trip"], metaStatus: "APPROVED" },
  });
});
beforeEach(() => {
  enqueued.length = 0;
  queueMock.enqueueReplacingFinished.mockReset();
  queueMock.enqueueReplacingFinished.mockImplementation(async (name: string, data: unknown, jobId: string) => {
    enqueued.push({ name, data, jobId });
  });
});
afterAll(() => db.$disconnect());

describe("ingestInbound", () => {
  it("stores the same wamid once, however often it is delivered", async () => {
    const from = phone();
    const msg = inbound(from);
    const [a, b] = await Promise.all([ingestInbound(msg), ingestInbound(msg)]);
    const c = await ingestInbound(msg);
    expect(new Set([a.messageId, b.messageId, c.messageId]).size).toBe(1);
    expect(c.status).toBe("duplicate");
    expect(await db.message.count({ where: { externalId: msg.externalId } })).toBe(1);
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: a.conversationId }, include: { customer: true } });
    expect(conv.unreadCount).toBe(1);
    expect(conv.customer?.phone).toBe(from);
    expect(conv.lastInboundAt?.toISOString()).toBe(msg.timestamp);
  });

  it("routes a known supplier's phone to a supplier conversation, never the customer inbox", async () => {
    const supplierPhone = phone();
    const supplier = await db.supplier.create({ data: { name: `Hotel ${uid()}`, type: "HOTEL", destinations: ["Gangtok"], phone: supplierPhone } });
    const r = await ingestInbound(inbound(supplierPhone));
    expect(r.status).toBe("supplier");
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: r.conversationId } });
    expect(conv.supplierId).toBe(supplier.id);
    expect(conv.customerId).toBeNull();
    expect(await db.customer.count({ where: { phone: supplierPhone } })).toBe(0);
    const msg = await db.message.findUniqueOrThrow({ where: { id: r.messageId } });
    expect(msg.author).toBe("SUPPLIER");
    expect(enqueued).toContainEqual({ name: "rfq.parseReply", data: { messageId: r.messageId, supplierId: supplier.id }, jobId: `rfq-parse-${r.messageId}` });
  });
});

describe("24h window policy (INB-11)", () => {
  it("blocks free text once the customer's last message is over 24h old, but allows templates", async () => {
    const now = new Date();
    const r = await ingestInbound(inbound(phone(), undefined, new Date(now.getTime() - 25 * 3600_000)));
    const before = await db.message.count({ where: { conversationId: r.conversationId } });

    const text = await send(r.conversationId, { type: "text", body: "Hello again!" }, "SYSTEM", { now });
    expect(text).toEqual({ status: "BLOCKED", reason: "WINDOW_CLOSED", conversationId: r.conversationId });
    expect(await db.message.count({ where: { conversationId: r.conversationId } })).toBe(before);
    expect(enqueued.filter((e) => e.name === "outbound.send")).toHaveLength(0);

    const tpl = await send(r.conversationId, { type: "template", name: "follow_up_test", vars: { name: "Test", trip: "Nepal" } }, "SYSTEM", { now });
    expect(tpl.status).toBe("QUEUED");
    const queued = await db.message.findUniqueOrThrow({ where: { id: (tpl as { messageId: string }).messageId } });
    expect(queued).toMatchObject({ status: "QUEUED", kind: "TEMPLATE", body: "Hi Test, still keen on Nepal?" });

    // Just inside the window, free text goes through.
    const fresh = await send(r.conversationId, { type: "text", body: "ok" }, "SYSTEM", { now: new Date(now.getTime() - 2 * 3600_000) });
    expect(fresh.status).toBe("QUEUED");
  });
});

describe("Meta webhook recovery", () => {
  it("re-enqueues a duplicate event whose processing never happened, with jobId = event id", async () => {
    const wamid = `wamid.R${uid()}`;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: "919800000001", profile: { name: "R" } }], messages: [{ from: "919800000001", id: wamid, timestamp: "1764000000", type: "text", text: { body: "hi" } }] } }] }],
    });
    const headers = new Headers({ "x-hub-signature-256": signMetaBody(body, metaAppSecret()) });

    queueMock.enqueueReplacingFinished.mockRejectedValueOnce(new Error("redis down"));
    await expect(ingestMetaWebhook("WHATSAPP", body, headers)).rejects.toThrow("redis down");
    const ev = await db.webhookEvent.findUniqueOrThrow({ where: { provider_externalId: { provider: "WHATSAPP", externalId: `msg:${wamid}` } } });
    expect(ev.processedAt).toBeNull();

    // Meta redelivers: same event, still unprocessed → enqueued again under the event's id.
    const again = await ingestMetaWebhook("WHATSAPP", body, headers);
    expect(again).toEqual({ status: 200, events: [{ webhookEventId: ev.id, duplicate: true }] });
    expect(enqueued).toEqual([{ name: "inbound.process", data: { webhookEventId: ev.id }, jobId: ev.id }]);

    // Once processed, a further redelivery is a no-op.
    await db.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: new Date() } });
    enqueued.length = 0;
    await ingestMetaWebhook("WHATSAPP", body, headers);
    expect(enqueued).toHaveLength(0);
    expect(await db.webhookEvent.count({ where: { externalId: `msg:${wamid}` } })).toBe(1);
  });

  it("rejects a bad signature before storing anything", async () => {
    const body = JSON.stringify({ entry: [] });
    const r = await ingestMetaWebhook("WHATSAPP", body, new Headers({ "x-hub-signature-256": signMetaBody(body, "wrong") }));
    expect(r).toEqual({ status: 401, reason: "bad_signature" });
  });
});
