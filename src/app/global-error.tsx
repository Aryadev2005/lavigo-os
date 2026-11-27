"use client";
/**
 * Last-resort boundary: replaces the root layout when it fails, so it brings its own <html> and
 * inline styles (the app's CSS may be what failed).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#F5F3FA", color: "#1E1640", display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <div role="alert" style={{ background: "#fff", borderRadius: 18, padding: 28, maxWidth: 440, textAlign: "center", boxShadow: "0 2px 12px rgba(30,22,64,.08)" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Lavigo OS hit a problem</h1>
          <p style={{ fontSize: 14, color: "#6B6585", margin: 0 }}>Reload the page. If it keeps happening, send support this code{error.digest ? `: ${error.digest}` : "."}</p>
          <button type="button" onClick={reset} style={{ marginTop: 16, background: "#1E1640", color: "#fff", border: 0, borderRadius: 10, padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
