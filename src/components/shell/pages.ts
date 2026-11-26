/**
 * Navigation and page headers. Titles/subtitles follow the demo's meta() strings,
 * rewritten where the demo mentions AI (v1 has no AI).
 */
export type NavKey = "today" | "inbox" | "bookings" | "dues" | "supplier" | "tickets" | "departures" | "profit" | "rules";
export type BadgeKey = "inbox" | "dues" | "tickets";

export type NavItem = {
  key: NavKey;
  href: `/${string}`;
  label: string;
  ownerOnly?: boolean;
  badge?: BadgeKey;
};

export const NAV: NavItem[] = [
  { key: "today", href: "/today", label: "Today" },
  { key: "inbox", href: "/inbox", label: "Inbox", badge: "inbox" },
  { key: "bookings", href: "/bookings", label: "Bookings" },
  { key: "dues", href: "/dues", label: "Payments & dues", badge: "dues" },
  { key: "supplier", href: "/supplier", label: "Supplier desk" },
  { key: "tickets", href: "/tickets", label: "Tickets desk", badge: "tickets" },
  { key: "departures", href: "/departures", label: "Departures" },
  { key: "profit", href: "/profit", label: "Profit", ownerOnly: true },
  { key: "rules", href: "/rules", label: "Pricing rules", ownerOnly: true },
];

export type PageMeta = { title: string; subtitle: string };

/** Static headers by first path segment. "today" is computed per request (greeting + IST date). */
export const PAGE_META: Record<string, PageMeta> = {
  inbox: { title: "Inbox", subtitle: "Every WhatsApp and Instagram chat in one place, priced inside your rules" },
  bookings: { title: "Bookings", subtitle: "Every booking from the website, WhatsApp, Instagram and walk-ins in one place" },
  dues: { title: "Payments & dues", subtitle: "Who paid, who owes, and what the software is chasing for you" },
  supplier: { title: "Supplier desk", subtitle: "Ask all your hotels and agents for rates at once, and book the best one" },
  tickets: { title: "Tickets desk", subtitle: "Finds the cheapest way to get your travellers there, and tells you when to book" },
  departures: { title: "Departures", subtitle: "Seats, travellers and documents for every fixed-date trip" },
  profit: { title: "Profit", subtitle: "What you actually make on every trip, after hotels, travel and the trip leader" },
  rules: { title: "Pricing rules", subtitle: "You set the limits once. Your team quotes inside them." },
  sandbox: { title: "Sandbox", subtitle: "Chat as a customer to try the inbox without WhatsApp" },
  approvals: { title: "Approval", subtitle: "A price your team asked you about. One tap to decide." },
};
