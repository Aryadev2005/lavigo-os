/** Traveller list CSV (DEP-5). Signed-in owner or staff; cells are escaped against formula injection. */
import { DepartureError, travellerCsv } from "@/server/domain/departures";
import { currentUser } from "@/server/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/departures/[id]/travellers">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { fileName, csv } = await travellerCsv(id, { id: user.id, role: user.role });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof DepartureError && err.code === "NOT_FOUND") return Response.json({ error: "not found" }, { status: 404 });
    throw err;
  }
}
