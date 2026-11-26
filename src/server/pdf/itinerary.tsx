/** Day-by-day itinerary from Trip.itinerary ([{ day, title, description }]). */
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { formatDate } from "../time";
import { Footer, Header, LAV3, LAVIGO, s } from "./shared";

export type ItineraryDay = { day: number; title: string; description?: string };
export type ItineraryData = {
  title: string;
  departureCode: string;
  startDate: Date;
  endDate: Date;
  bookingCode?: string;
  days: ItineraryDay[];
  inclusions: string[];
  exclusions: string[];
};

/** Tolerant parse of the Json column; bad rows are dropped rather than failing the render. */
export function parseItinerary(json: unknown): ItineraryDay[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d, i) => ({ day: Number(d.day) || i + 1, title: String(d.title ?? ""), description: d.description ? String(d.description) : undefined }))
    .filter((d) => d.title);
}

export function ItineraryPdf({ d }: { d: ItineraryData }) {
  return (
    <Document title={`${d.title} itinerary`} author={LAVIGO.name}>
      <Page size="A4" style={s.page}>
        <Header
          title={d.title}
          subtitle={`${d.departureCode} · ${formatDate(d.startDate, "d MMM")} – ${formatDate(d.endDate, "d MMM yyyy")}${d.bookingCode ? ` · ${d.bookingCode}` : ""}`}
        />
        <View style={s.section}>
          {d.days.map((day) => (
            <View key={day.day} style={{ flexDirection: "row", marginBottom: 8 }} wrap={false}>
              <View style={{ width: 54, backgroundColor: LAV3, borderRadius: 6, padding: 6, marginRight: 10 }}>
                <Text style={[s.bold, { textAlign: "center" }]}>Day {day.day}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.bold}>{day.title}</Text>
                {day.description ? <Text style={s.muted}>{day.description}</Text> : null}
              </View>
            </View>
          ))}
        </View>
        {d.inclusions.length ? (
          <View style={s.section}>
            <Text style={s.label}>Included</Text>
            {d.inclusions.map((x) => (
              <Text key={x}>• {x}</Text>
            ))}
          </View>
        ) : null}
        {d.exclusions.length ? (
          <View style={s.section}>
            <Text style={s.label}>Not included</Text>
            {d.exclusions.map((x) => (
              <Text key={x}>• {x}</Text>
            ))}
          </View>
        ) : null}
        <Footer text={`${LAVIGO.name} · ${LAVIGO.phone} · ${LAVIGO.email}`} />
      </Page>
    </Document>
  );
}
