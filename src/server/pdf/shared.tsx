/**
 * Shared PDF building blocks (@react-pdf/renderer). Lavigo palette from the demo tokens.
 * Text is set in Noto Sans (SIL OFL 1.1, see fonts/OFL.txt), which has the ₹ glyph; amounts use
 * the same inr() formatter as the UI. The TTFs sit next to this module; the tsup worker bundle
 * copies them to dist/fonts so the same relative URL resolves there.
 */
import { fileURLToPath } from "node:url";
import { Font, StyleSheet, Text, View } from "@react-pdf/renderer";
import { inr } from "../money";
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

const fontFile = (name: string) => fileURLToPath(new URL(`./fonts/${name}`, import.meta.url));

export const FONT = "NotoSans";
Font.register({
  family: FONT,
  fonts: [
    { src: fontFile("NotoSans-Regular.ttf"), fontWeight: 400 },
    { src: fontFile("NotoSans-Bold.ttf"), fontWeight: 700 },
  ],
});
// Keep words whole: react-pdf's default hyphenation splits Indian names oddly.
Font.registerHyphenationCallback((word) => [word]);

/** Paise → "₹13,999" (or "₹13,332.38" when there are paise / exact is set). */
export function rs(paise: number, opts: { exact?: boolean } = {}): string {
  return inr(paise, opts);
}

export const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: FONT, color: "#1C1733" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", backgroundColor: INK, color: "#fff", padding: 16, borderRadius: 8 },
  h1: { fontSize: 18, fontWeight: 700, color: "#fff" },
  sub: { fontSize: 9, color: "#D8CFF7", marginTop: 2 },
  section: { marginTop: 16 },
  label: { fontSize: 8, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  bold: { fontWeight: 700 },
  muted: { color: MUTED },
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 6 },
  th: { flexDirection: "row", backgroundColor: LAV3, padding: 6, fontWeight: 700, fontSize: 9 },
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
