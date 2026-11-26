/**
 * Rule-based supplier-quote parser (SUP-4, system design §6.2). PURE: no I/O, no clock.
 *
 * v2 can swap this for an LLM parser behind the same `parseSupplierReply(text, rfqContext)` signature.
 * Amounts come back in paise (CLAUDE.md money rule); confidence is a 0–1 score.
 */
import type { MealPlan } from "@prisma/client";

export type RfqContext = { rooms: number; nights: number };

export type ParsedSupplierReply = {
  /** Paise per room per night, or null when no usable amount was found. */
  ratePerRoomNight: number | null;
  /** Paise, when the supplier stated a total. */
  totalIfStated: number | null;
  /** Human-readable inclusions ("Breakfast incl.", "Incl. Lachung night"), or null. */
  inclusions: string | null;
  mealPlan: MealPlan | null;
  isDecline: boolean;
  /** 0–1. ≥ 0.8 is "high": anything below is saved as "needs check". */
  confidence: number;
  level: "high" | "medium" | "low";
  /** Paise per room-night: one-click choices for a "needs check" quote. */
  candidates: number[];
};

export const HIGH_CONFIDENCE = 0.8;
const TOTAL_ONLY_CONFIDENCE = 0.6;
const AMBIGUOUS_CONFIDENCE = 0.4;
const SINGLE_UNLABELLED_CONFIDENCE = 0.5;

/** Plausible per-room-night range (₹500–₹50,000). */
const MIN_RATE = 500;
const MAX_RATE = 50_000;
const WINDOW = 25;

type Kind = "strong" | "total" | "other";

const KEYWORDS: { kind: Kind; re: RegExp }[] = [
  { kind: "strong", re: /per\s*room|\/\s*room|room\s*night|per\s*night|\/\s*night|\bpn\b|\bp\.n\.?|\brate\b|\btariff\b/g },
  { kind: "total", re: /\btotal\b|\bfor\s+\d+\s+rooms?\b|\boverall\b|\baltogether\b/g },
  { kind: "other", re: /\bextra\b|\bcab\b|\bcar\b|\btaxi\b|\btransfer\b|\bgst\b|\btax\b|\bdeposit\b|\badvance\b/g },
];

const DECLINE = /\bsorry\b|not\s+available|\bunavailable\b|sold\s*out|\bfull(y)?\b|no\s+rooms?\b|\bregret\b|can'?t\s+(do|accommodate)/;

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

/** Step 1: lowercase, strip currency markers, expand "2.4k", drop thousands separators and dates. */
export function normalise(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/₹/g, " ")
      .replace(/\/-/g, " ")
      .replace(/\b(?:rs|inr)\.?\s*/g, " ")
      // dates that would otherwise look like amounts: 09/01/2027, 9 jan 2027, jan 9, 2027
      .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, " ")
      .replace(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s*(\\d{1,2})?,?\\s*20\\d{2}\\b`, "g"), " $1 ")
      // 1,05,000 / 64,500 → 105000 / 64500
      .replace(/(\d),(?=\d{2,3}\b)/g, "$1")
      .replace(/(\d),(?=\d{2,3}\b)/g, "$1")
      // 2.4k / 2k → 2400 / 2000
      .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_m, n: string) => String(Math.round(Number(n) * 1000)))
      .replace(/\s+/g, " ")
      .trim()
  );
}

type Amount = { value: number; index: number; end: number; kind: Kind };

function classify(norm: string, index: number, end: number): Kind {
  let best: { kind: Kind; dist: number } | null = null;
  for (const { kind, re } of KEYWORDS) {
    re.lastIndex = 0;
    for (let m = re.exec(norm); m; m = re.exec(norm)) {
      const kStart = m.index;
      const kEnd = m.index + m[0].length;
      const dist = kEnd <= index ? index - kEnd : kStart >= end ? kStart - end : 0;
      if (dist > WINDOW) continue;
      // "for 10 rooms" names the total it follows, never an amount after it.
      if (kind === "total" && /^for/.test(m[0]) && kStart < index) continue;
      if (!best || dist < best.dist) best = { kind, dist };
    }
  }
  return best?.kind ?? "other";
}

function amounts(norm: string): Amount[] {
  const out: Amount[] = [];
  const re = /(?<![\d.])(\d{3,6})(?![\d.])/g;
  for (let m = re.exec(norm); m; m = re.exec(norm)) {
    const end = m.index + m[0].length;
    out.push({ value: Number(m[1]), index: m.index, end, kind: classify(norm, m.index, end) });
  }
  return out;
}

function mealPlanOf(norm: string): MealPlan | null {
  if (/\bmap\b|breakfast\s*(\+|and|&)\s*dinner|dinner\s*(\+|and|&)\s*breakfast|half\s*board/.test(norm)) return "MAP";
  if (/\bap\b|all\s+meals|full\s*board/.test(norm)) return "AP";
  if (/\bcp\b|breakfast|\bb&b\b|\bbb\b/.test(norm)) return "CP";
  if (/\bep\b|room\s+only/.test(norm)) return "EP";
  return null;
}

const MEAL_LABEL: Record<MealPlan, string> = {
  EP: "Room only",
  CP: "Breakfast incl.",
  MAP: "Breakfast + dinner",
  AP: "All meals",
};

function inclusionsOf(original: string, plan: MealPlan | null): string | null {
  const parts: string[] = [];
  if (plan) parts.push(MEAL_LABEL[plan]);
  // "incl lachung night", "including cab" → "Incl. lachung night" (not the meal words already covered)
  const m = original.match(/\bincl(?:uding|uded|\.)?\s+([a-z][a-z ]{2,40}?)(?=[,.;!\n]|$)/i);
  if (m && !/^(breakfast|dinner|meals?|taxes|gst)\b/i.test(m[1]!.trim())) parts.push(`Incl. ${m[1]!.trim()}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Count stated in the text ("10 rooms", "3 nights"), else the RFQ's. */
function stated(norm: string, unit: "room" | "night", fallback: number): number {
  const m = norm.match(new RegExp(`\\b(\\d{1,3})\\s*${unit}s?\\b`));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const paise = (r: number) => Math.round(r) * 100;
const inRange = (r: number) => r >= MIN_RATE && r <= MAX_RATE;

export function parseSupplierReply(text: string, rfqContext: RfqContext): ParsedSupplierReply {
  const norm = normalise(text ?? "");
  const plan = mealPlanOf(norm);
  const inclusions = inclusionsOf(text ?? "", plan);
  const base = { inclusions, mealPlan: plan, totalIfStated: null as number | null };
  const none = (isDecline: boolean): ParsedSupplierReply => ({ ...base, ratePerRoomNight: null, isDecline, confidence: 0, level: "low", candidates: [] });

  if (!norm) return none(false);

  const found = amounts(norm);
  const totals = found.filter((a) => a.kind === "total");
  const rates = found.filter((a) => a.kind !== "total" && inRange(a.value));
  const strong = rates.filter((a) => a.kind === "strong");
  const totalIfStated = totals.length === 1 ? paise(totals[0]!.value) : null;

  // Step 3: a decline only when there's no rate to consider.
  if (DECLINE.test(norm) && rates.length === 0 && totals.length === 0) return none(true);

  // Step 4: exactly one strongly-labelled plausible rate, and nothing else unexplained.
  if (strong.length === 1 && rates.length === 1) {
    return { ...base, totalIfStated, ratePerRoomNight: paise(strong[0]!.value), isDecline: false, confidence: 0.9, level: "high", candidates: [paise(strong[0]!.value)] };
  }

  // Step 5: only a total → divide by rooms × nights, flagged at medium confidence.
  if (rates.length === 0 && totals.length >= 1) {
    const total = totals[0]!.value;
    const roomNights = stated(norm, "room", rfqContext.rooms) * stated(norm, "night", rfqContext.nights);
    const rate = roomNights > 0 ? Math.round(total / roomNights) : NaN;
    if (inRange(rate)) {
      return { ...base, totalIfStated: paise(total), ratePerRoomNight: paise(rate), isDecline: false, confidence: TOTAL_ONLY_CONFIDENCE, level: "medium", candidates: [paise(rate)] };
    }
  }

  if (rates.length === 0) return { ...none(false), totalIfStated };

  // Ambiguous: offer every plausible amount, best guess first (strong before others, then text order).
  const ordered = [...strong, ...rates.filter((a) => a.kind !== "strong")];
  const candidates = [...new Set(ordered.map((a) => paise(a.value)))];
  const single = rates.length === 1;
  const confidence = single ? SINGLE_UNLABELLED_CONFIDENCE : AMBIGUOUS_CONFIDENCE;
  return { ...base, totalIfStated, ratePerRoomNight: candidates[0]!, isDecline: false, confidence, level: single ? "medium" : "low", candidates };
}

/** confidence (0–1) → SupplierQuote.confidenceBps. */
export const confidenceBps = (c: number) => Math.round(c * 10_000);
