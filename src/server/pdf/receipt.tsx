/** Payment receipt, one per captured payment. */
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { formatIST } from "../time";
import { Footer, Header, KV, LAVIGO, rs, s } from "./shared";

export type ReceiptData = {
  number: string; // "RCPT-{bookingNo}-{n}"
  bookingCode: string;
  customerName: string;
  description: string;
  amount: number;
  method: string;
  reference: string | null;
  receivedAt: Date;
  totalAmount: number;
  paidAmount: number;
};

export function ReceiptPdf({ d }: { d: ReceiptData }) {
  return (
    <Document title={`Receipt ${d.number}`} author={LAVIGO.name}>
      <Page size="A5" style={s.page}>
        <Header title="Payment receipt" subtitle={d.number} />
        <View style={s.section}>
          <Text style={s.label}>Received from</Text>
          <Text style={s.bold}>{d.customerName}</Text>
          <Text>{d.description}</Text>
        </View>
        <View style={s.total}>
          <Text style={s.bold}>Amount received</Text>
          <Text style={s.bold}>{rs(d.amount)}</Text>
        </View>
        <View style={s.section}>
          <KV k="Booking" v={d.bookingCode} />
          <KV k="Received" v={formatIST(d.receivedAt, "d MMM yyyy, h:mm a")} />
          <KV k="Method" v={d.method} />
          {d.reference ? <KV k="Reference" v={d.reference} /> : null}
          <KV k="Trip total" v={rs(d.totalAmount)} />
          <KV k="Paid to date" v={rs(d.paidAmount)} />
          <KV k="Balance due" v={rs(Math.max(0, d.totalAmount - d.paidAmount))} bold />
        </View>
        <Footer text={`${LAVIGO.name} · ${LAVIGO.phone} · Thank you for travelling with us.`} />
      </Page>
    </Document>
  );
}
