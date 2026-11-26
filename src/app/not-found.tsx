import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-[70vh] place-items-center p-6">
      <div className="card pad max-w-md text-center">
        <span className="pill p-g">404</span>
        <h2 className="mt-3 text-xl font-bold">Nothing here</h2>
        <p className="muted mt-1 text-[13.5px]">That page doesn&apos;t exist or was moved.</p>
        <Link href="/today" className="btn b1 mt-4">Back to Today</Link>
      </div>
    </div>
  );
}
