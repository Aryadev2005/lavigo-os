"use client";
/** Error boundary for screens outside the signed-in shell (login, dev pay page). */
import { useEffect } from "react";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="grid min-h-[70vh] place-items-center p-6">
      <div className="card pad max-w-md text-center" role="alert">
        <span className="pill p-b">Error</span>
        <h2 className="mt-3 text-xl font-bold">Something went wrong</h2>
        <p className="muted mt-1 text-[13.5px]">Try again in a moment.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
        <button type="button" className="btn b1 mt-4" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
