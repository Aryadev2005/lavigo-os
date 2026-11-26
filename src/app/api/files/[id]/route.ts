/**
 * Private file download: auth + RBAC, then a 302 to a 5-minute presigned GET (ADR-9).
 * With the fake storage adapter (tests / no S3 keys) the bytes are streamed directly.
 */
import { db } from "@/server/db";
import { currentUser } from "@/server/rbac";
import { getStorage, PRESIGN_SECONDS } from "@/server/storage/s3";
import { audit } from "@/server/audit";
import type { Role, DocumentKind } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which roles may download which document kinds. Both roles work bookings end to end in v1. */
const ALLOWED: Record<DocumentKind, readonly Role[]> = {
  INVOICE: ["OWNER", "STAFF"],
  RECEIPT: ["OWNER", "STAFF"],
  ITINERARY: ["OWNER", "STAFF"],
  VOUCHER: ["OWNER", "STAFF"],
  TICKET: ["OWNER", "STAFF"],
  TRAVELLER_ID: ["OWNER", "STAFF"],
  OTHER: ["OWNER"], // e.g. supplier bills that carry costs
};

export async function GET(_req: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const doc = await db.document.findUnique({ where: { id } });
  if (!doc) return Response.json({ error: "not found" }, { status: 404 });
  if (!ALLOWED[doc.kind].includes(user.role)) return Response.json({ error: "forbidden" }, { status: 403 });

  if (doc.kind === "TRAVELLER_ID") {
    await audit({ userId: user.id, action: "document.download", entityType: "Document", entityId: doc.id });
  }

  const storage = getStorage();
  const headers = { "cache-control": "private, no-store" };
  if (storage.mode === "fake") {
    const body = await storage.get(doc.storageKey);
    return new Response(new Uint8Array(body), {
      headers: { ...headers, "content-type": doc.mimeType, "content-disposition": `attachment; filename="${doc.fileName}"` },
    });
  }
  const url = await storage.presignGet(doc.storageKey, { fileName: doc.fileName, expiresIn: PRESIGN_SECONDS });
  return new Response(null, { status: 302, headers: { ...headers, location: url } });
}
