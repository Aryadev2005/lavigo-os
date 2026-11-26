/**
 * Shared PDF building blocks (@react-pdf/renderer). Lavigo palette from the demo tokens.
 * Built-in Helvetica has no ₹ glyph, so PDFs print amounts as "Rs. 13,999".
 */
import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";

export const INK = "#221944";
export const LAV = "#C9B8F5";
export const LAV3 = "#F6F3FE";
export const MUTED = "#6B6488";
export const LINE = "#E6E1F5";

/** Seller details. Placeholders until the client confirms them (SRS open questions). */
export const LAVIGO = {
  name: "Lavigo Travel Co.",
  address: "[Address line], Ranchi, Jharkhand [PIN]",
  phone: "[+91 phone]",
  email: "[hello@lavigo.in]",
  stateCode: "20 (Jharkhand)",
};

const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const exact = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Paise → "Rs. 13,999" (or "Rs. 13,332.38" when there are paise). */
export function rs(paise: number, opts: { exact?: boolean } = {}): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const body = opts.exact || abs % 100 !== 0 ? exact.format(abs / 100) : whole.format(abs / 100);
  return `${sign}Rs. ${body}`;
}

export const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#1C1733" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", backgroundColor: INK, color: "#fff", padding: 16, borderRadius: 8 },
  h1: { fontSize: 18, fontFamily: "Helvetica-Bold", color: "#fff" },
  sub: { fontSize: 9, color: "#D8CFF7", marginTop: 2 },
  section: { marginTop: 16 },
  label: { fontSize: 8, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  bold: { fontFamily: "Helvetica-Bold" },
  muted: { color: MUTED },
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 6 },
  th: { flexDirection: "row", backgroundColor: LAV3, padding: 6, fontFamily: "Helvetica-Bold", fontSize: 9 },
  td: { flexDirection: "row", padding: 6, borderTopWidth: 1, borderTopColor: LINE },
  total: { flexDirection: "row", justifyContent: "space-between", padding: 8, backgroundColor: INK, color: "#fff", borderRadius: 6, marginTop: 8 },
  footer: { position: "absolute", bottom: 24, left: 36, right: 36, fontSize: 8, color: MUTED, textAlign: "center" },
});

export function Header({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={s.header}>
      <View>
        <Text style={s.h1}>{title}</Text>
        {subtitle ? <Text style={s.sub}>{subtitle}</Text> : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[s.bold, { fontSize: 13, color: LAV }]}>{LAVIGO.name}</Text>
        <Text style={s.sub}>{LAVIGO.address}</Text>
        {right}
      </View>
    </View>
  );
}

export function KV({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.muted}>{k}</Text>
      <Text style={bold ? s.bold : undefined}>{v}</Text>
    </View>
  );
}

export function Footer({ text }: { text: string }) {
  return (
    <Text style={s.footer} fixed>
      {text}
    </Text>
  );
}
