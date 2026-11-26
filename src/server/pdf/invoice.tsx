/**
 * Tax invoice (PAY-8) for the booking total. Rendered once per booking, so it carries no payment
 * state (that would go stale); each payment gets its own receipt.
 */
import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { GstBreakup } from "../domain/payments/gst";
import { formatDate } from "../time";
import { Footer, Header, KV, LAVIGO, rs, s } from "./shared";

export type InvoiceData = {
  number: string;
  issuedAt: Date;
  bookingCode: string;
  gstin: string | null;
  customer: { name: string; phone: string | null; email: string | null; city: string | null };
  description: string; // "Nepal · Pokhara & Kathmandu (NP-28N), 12 Dec 2026"
  pax: number;
  pricePerPax: number;
  breakup: GstBreakup;
};

export function InvoicePdf({ d }: { d: InvoiceData }) {
  const b = d.breakup;
  const rate = (b.gstRateBps / 100).toFixed(2).replace(/\.00$/, "");
  const half = (b.gstRateBps / 200).toFixed(2).replace(/\.?0+$/, "");
  return (
    <Document title={`Invoice ${d.number}`} author={LAVIGO.name}>
      <Page size="A4" style={s.page}>
        <Header title="Tax Invoice" subtitle={`${d.number} · ${formatDate(d.issuedAt, "d MMM yyyy")}`} />

        <View style={[s.section, { flexDirection: "row", gap: 24 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Billed to</Text>
            <Text style={s.bold}>{d.customer.name}</Text>
            {d.customer.city ? <Text>{d.customer.city}</Text> : null}
            {d.customer.phone ? <Text>{d.customer.phone}</Text> : null}
            {d.customer.email ? <Text>{d.customer.email}</Text> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Seller</Text>
            <Text style={s.bold}>{LAVIGO.name}</Text>
            <Text>{LAVIGO.address}</Text>
            <Text>GSTIN: {d.gstin ?? "[GSTIN pending]"}</Text>
            <Text>State: {LAVIGO.stateCode}</Text>
          </View>
          <View style={{ flex: 0.8 }}>
            <Text style={s.label}>Booking</Text>
            <Text style={s.bold}>{d.bookingCode}</Text>
            <Text>SAC 998552 (tour operator)</Text>
          </View>
        </View>

        <View style={[s.section, s.table]}>
          <View style={s.th}>
            <Text style={{ flex: 4 }}>Description</Text>
            <Text style={{ flex: 1, textAlign: "right" }}>Pax</Text>
            <Text style={{ flex: 1.6, textAlign: "right" }}>Rate (incl. GST)</Text>
            <Text style={{ flex: 1.6, textAlign: "right" }}>Amount</Text>
          </View>
          <View style={s.td}>
            <Text style={{ flex: 4 }}>{d.description}</Text>
            <Text style={{ flex: 1, textAlign: "right" }}>{d.pax}</Text>
            <Text style={{ flex: 1.6, textAlign: "right" }}>{rs(d.pricePerPax)}</Text>
            <Text style={{ flex: 1.6, textAlign: "right" }}>{rs(b.total)}</Text>
          </View>
        </View>

        <View style={[s.section, { marginLeft: "50%" }]}>
          <KV k="Taxable value" v={rs(b.taxableValue, { exact: true })} />
          {b.igst > 0 ? (
            <KV k={`IGST @ ${rate}%`} v={rs(b.igst, { exact: true })} />
          ) : (
            <>
              <KV k={`CGST @ ${half}%`} v={rs(b.cgst, { exact: true })} />
              <KV k={`SGST @ ${half}%`} v={rs(b.sgst, { exact: true })} />
            </>
          )}
          <View style={s.total}>
            <Text style={s.bold}>Total (incl. GST)</Text>
            <Text style={s.bold}>{rs(b.total, { exact: true })}</Text>
          </View>
          <Text style={[s.muted, { marginTop: 6, fontSize: 8 }]}>Payments are acknowledged on separate receipts.</Text>
        </View>

        <Footer text={`${LAVIGO.name} · ${LAVIGO.phone} · ${LAVIGO.email} · GST rate pending CA confirmation. Computer-generated invoice.`} />
      </Page>
    </Document>
  );
}
