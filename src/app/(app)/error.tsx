"use client";
/**
 * Error boundary for every signed-in screen: the sidebar and top bar (the layout) stay, the page
 * area shows this card. Server errors arrive without their message in production; the digest is
 * the id to find the full error in the server logs.
 */
import Link from "next/link";
import { useEffect } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="wrap">
      <div className="card pad" role="alert" style={{ maxWidth: 520, margin: "40px auto", textAlign: "center" }}>
        <div style={{ fontSize: 30 }} aria-hidden>
          ⚠️
        </div>
        <h2 style={{ fontSize: 20, marginTop: 6 }}>Something went wrong on this screen</h2>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
          Nothing you saved has been lost. Try again; if it keeps happening, send this code to support so we can find it in the logs.
        </p>
        {error.digest ? (
          <p style={{ marginTop: 10 }}>
            <code className="pill p-g">{error.digest}</code>
          </p>
        ) : null}
        <div className="chips" style={{ justifyContent: "center", marginTop: 14 }}>
          <button type="button" className="btn b1 sm" onClick={reset}>
            Try again
          </button>
          <Link href="/today" className="btn b2 sm">
            Back to Today
          </Link>
        </div>
      </div>
    </div>
  );
}
