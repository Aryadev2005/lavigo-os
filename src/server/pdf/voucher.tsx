/**
 * Hotel voucher (SUP-7 follow-on, Bookings drawer "Send vouchers"). One per booking, listing every
 * hotel booked through the Supplier desk for its departure. No supplier rates on it: those are costs.
 * ₹ renders through the registered Noto font (./fonts).
 */
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { formatDate } from "../time";
import { Footer, Header, KV, LAVIGO, s } from "./shared";

export type VoucherStay = {
  hotel: string;
  destination: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  roomType: string;
  mealPlan: string;
  reference: string;
};

export type VoucherData = {
  bookingCode: string;
  customerName: string;
  tripTitle: string;
  departureCode: string;
  pax: number;
  travellers: string[];
  stays: VoucherStay[];
};

export function VoucherPdf({ d }: { d: VoucherData }) {
  return (
    <Document title={`Hotel voucher ${d.bookingCode}`} author={LAVIGO.name}>
      <Page size="A4" style={s.page}>
        <Header title="Hotel voucher" subtitle={`${d.bookingCode} · ${d.departureCode}`} />
        <View style={s.section}>
          <Text style={s.label}>Guest</Text>
          <Text style={s.bold}>{d.customerName}</Text>
          <Text>
            {d.tripTitle} · {d.pax} traveller{d.pax === 1 ? "" : "s"}
          </Text>
          {d.travellers.length ? <Text style={[s.muted, { marginTop: 2 }]}>{d.travellers.join(", ")}</Text> : null}
        </View>
        {d.stays.map((st) => (
          <View key={st.reference} style={[s.section, s.table, { padding: 10 }]} wrap={false}>
            <Text style={[s.bold, { fontSize: 12 }]}>{st.hotel}</Text>
            <Text style={[s.muted, { marginBottom: 6 }]}>{st.destination}</Text>
            <KV k="Check-in" v={formatDate(st.checkIn, "EEE, d MMM yyyy")} />
            <KV k="Check-out" v={formatDate(st.checkOut, "EEE, d MMM yyyy")} />
            <KV k="Nights" v={String(st.nights)} />
            <KV k="Room type" v={st.roomType} />
            <KV k="Meal plan" v={st.mealPlan} />
            <KV k="Lavigo reference" v={st.reference} bold />
          </View>
        ))}
        <View style={s.section}>
          <Text style={s.muted}>
            Rooms are pre-paid by {LAVIGO.name} as part of your package: ₹0 to pay at the hotel, except personal extras. Show this voucher at check-in with a photo ID.
          </Text>
        </View>
        <Footer text={`${LAVIGO.name} · ${LAVIGO.phone} · Have a wonderful stay.`} />
      </Page>
    </Document>
  );
}
