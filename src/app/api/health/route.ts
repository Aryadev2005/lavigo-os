import { db } from "@/server/db";
import { redis } from "@/server/redis";

export const dynamic = "force-dynamic";

async function check(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
  const start = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000))]);
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - start) };
  }
}

export async function GET() {
  const [database, cache] = await Promise.all([check(() => db.$queryRaw`SELECT 1`), check(() => redis.ping())]);
  const ok = database.ok && cache.ok;
  return Response.json(
    { status: ok ? "ok" : "degraded", checks: { db: database, redis: cache } },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
