import type { NavKey } from "./pages";

// SVG paths copied from the demo's IC map so the nav looks identical.
const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;

export function NavIcon({ name }: { name: NavKey }) {
  switch (name) {
    case "today":
      return <svg {...common}><path d="M3 12l9-8 9 8M5 10v10h14V10" /></svg>;
    case "inbox":
      return <svg {...common}><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z" /></svg>;
    case "bookings":
      return <svg {...common}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
    case "dues":
      return <svg {...common}><rect x="2" y="6" width="20" height="13" rx="2" /><circle cx="12" cy="12.5" r="2.5" /></svg>;
    case "supplier":
      return <svg {...common}><path d="M3 21V8l6-4 6 4v13M15 21V12h6v9M7 10h4M7 14h4" /></svg>;
    case "tickets":
      return (
        <svg {...common}>
          <path d="M3 8a2 2 0 002-2h14a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 00-2 2H5a2 2 0 00-2-2v-2a2 2 0 000-4z" />
          <path d="M13 6v12" strokeDasharray="2 2" />
        </svg>
      );
    case "departures":
      return <svg {...common}><path d="M3 18h18M5 18l3-8 4 4 3-6 4 10" /></svg>;
    case "profit":
      return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
    case "rules":
      return (
        <svg {...common}>
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
          <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
        </svg>
      );
  }
}

export function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0" />
    </svg>
  );
}
