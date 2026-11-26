import Link from "next/link";

export const metadata = { title: "Not allowed" };

/** 403 UI for forbidden() (requireUser with a role the user doesn't have). */
export default function Forbidden() {
  return (
    <div className="grid min-h-[70vh] place-items-center p-6">
      <div className="card pad max-w-md text-center">
        <div className="mx-auto mb-3 grid size-12 place-items-center rounded-[14px] bg-badbg text-2xl" aria-hidden>
          🔒
        </div>
        <span className="pill p-b">403 · Owner only</span>
        <h2 className="mt-3 text-xl font-bold">This page is for the owner</h2>
        <p className="muted mt-1 text-[13.5px]">
          Profit and pricing rules are visible to the owner only. Ask the owner if you need something changed here.
        </p>
        <Link href="/today" className="btn b1 mt-4">
          Back to Today
        </Link>
      </div>
    </div>
  );
}
