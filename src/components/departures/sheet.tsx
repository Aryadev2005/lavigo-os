"use client";
/**
 * Trip + departure sheet (DEP-2): pick or add a trip (title, itinerary days, inclusions, tags, photo)
 * and set the departure (code, dates, seats, price, travel budget, usual room rate). The cost per
 * person is the owner's: staff don't see the field and a staff save keeps the stored cost.
 */
import type { DepartureStatus } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveDepartureAction, saveTripAction } from "@/app/(app)/departures/actions";
import { useToast } from "@/components/shell/toast";
import type { DepartureForm, TripForm } from "@/server/domain/departures/queries";

const PHOTOS: [string, string][] = [
  ["images/departures/nepal.jpg", "Nepal"],
  ["images/departures/netarhat.jpg", "Netarhat"],
  ["images/departures/darjeeling.jpg", "Darjeeling"],
  ["images/departures/sikkim.jpg", "Sikkim"],
];
const STATUSES: [DepartureStatus, string][] = [
  ["DRAFT", "Draft"],
  ["OPEN", "Open for booking"],
  ["CLOSED", "Closed"],
  ["COMPLETED", "Completed"],
  ["CANCELLED", "Cancelled"],
];
const rupeesOf = (paise: number | null | undefined) => (paise ? String(Math.round(paise / 100)) : "");
const toLines = (xs: string[]) => xs.join("\n");
const fromLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

type TripDraft = {
  name: string;
  title: string;
  destination: string;
  nights: string;
  days: string;
  summary: string;
  inclusions: string;
  exclusions: string;
  tags: string;
  heroImageKey: string;
  itinerary: { title: string; description: string }[];
};

const tripDraft = (t: TripForm | undefined): TripDraft => ({
  name: t?.name ?? "",
  title: t?.title ?? "",
  destination: t?.destination ?? "",
  nights: String(t?.nights ?? ""),
  days: String(t?.days ?? ""),
  summary: t?.summary ?? "",
  inclusions: toLines(t?.inclusions ?? []),
  exclusions: toLines(t?.exclusions ?? []),
  tags: (t?.tags ?? []).join(", "),
  heroImageKey: t?.heroImageKey ?? "",
  itinerary: t?.itinerary.length ? t.itinerary.map((d) => ({ title: d.title, description: d.description ?? "" })) : [{ title: "", description: "" }],
});

export function DepartureSheet({ trips, departure, isOwner, closeHref }: { trips: TripForm[]; departure: DepartureForm | null; isOwner: boolean; closeHref: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tripId, setTripId] = useState<string>(departure?.tripId ?? trips[0]?.id ?? "new");
  const [t, setT] = useState<TripDraft>(tripDraft(trips.find((x) => x.id === tripId)));
  const [d, setD] = useState({
    code: departure?.code ?? "",
    startDate: departure?.startDate ?? "",
    endDate: departure?.endDate ?? "",
    seatsTotal: String(departure?.seatsTotal ?? 20),
    price: rupeesOf(departure?.pricePerPax),
    cost: rupeesOf(departure?.costPerPax),
    travelBudget: rupeesOf(departure?.travelBudgetPerPax),
    usualRoomRate: rupeesOf(departure?.usualRoomRate),
    status: departure?.status ?? ("OPEN" as DepartureStatus),
  });
  const setTrip = (k: keyof TripDraft, v: string) => setT((x) => ({ ...x, [k]: v }));
  const setDep = (k: keyof typeof d, v: string) => setD((x) => ({ ...x, [k]: v }));
  const pickTrip = (v: string) => {
    setTripId(v);
    setT(tripDraft(trips.find((x) => x.id === v)));
  };
  const setDay = (i: number, k: "title" | "description", v: string) => setT((x) => ({ ...x, itinerary: x.itinerary.map((day, j) => (j === i ? { ...day, [k]: v } : day)) }));
  const moveDay = (i: number, by: -1 | 1) =>
    setT((x) => {
      const it = [...x.itinerary];
      const j = i + by;
      if (j < 0 || j >= it.length) return x;
      [it[i], it[j]] = [it[j]!, it[i]!];
      return { ...x, itinerary: it };
    });

  const save = () =>
    start(async () => {
      setError(null);
      const tr = await saveTripAction(tripId === "new" ? null : tripId, {
        name: t.name,
        title: t.title,
        destination: t.destination,
        nights: t.nights,
        days: t.days,
        summary: t.summary,
        inclusions: fromLines(t.inclusions),
        exclusions: fromLines(t.exclusions),
        itinerary: t.itinerary,
        tags: t.tags.split(",").map((x) => x.trim()).filter(Boolean),
        heroImageKey: (t.heroImageKey || null) as never,
      });
      if (!tr.ok) return setError(tr.error);
      setTripId(tr.id);
      const r = await saveDepartureAction(departure?.id ?? null, { tripId: tr.id, ...d, ...(isOwner ? {} : { cost: undefined }) });
      if (!r.ok) return setError(r.error);
      toast(departure ? "Departure saved" : "Departure added", "🚌");
      router.push(closeHref, { scroll: false });
      router.refresh();
    });

  return (
    <>
      <div className="h">
        <div>
          <span className="muted">Departures</span>
          <h2 style={{ fontSize: 22 }}>{departure ? departure.code : "New departure"}</h2>
        </div>
        <button type="button" className="btn b2 sm" onClick={() => router.push(closeHref, { scroll: false })}>
          Close
        </button>
      </div>

      <div className="card pad" style={{ margin: "12px 0" }}>
        <b>Trip</b>
        <div className="fld" style={{ marginTop: 10 }}>
          <label htmlFor="ds-trip">Trip</label>
          <select id="ds-trip" className="inp" value={tripId} onChange={(e) => pickTrip(e.target.value)}>
            {trips.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
            <option value="new">+ New trip</option>
          </select>
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="ds-name">Short name (on the photo)</label>
            <input id="ds-name" className="inp" value={t.name} onChange={(e) => setTrip("name", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-dest">Destination</label>
            <input id="ds-dest" className="inp" value={t.destination} onChange={(e) => setTrip("destination", e.target.value)} />
          </div>
        </div>
        <div className="fld">
          <label htmlFor="ds-title">Title</label>
          <input id="ds-title" className="inp" value={t.title} onChange={(e) => setTrip("title", e.target.value)} />
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="ds-days">Days</label>
            <input id="ds-days" className="inp" inputMode="numeric" value={t.days} onChange={(e) => setTrip("days", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-nights">Nights</label>
            <input id="ds-nights" className="inp" inputMode="numeric" value={t.nights} onChange={(e) => setTrip("nights", e.target.value)} />
          </div>
        </div>
        <div className="fld">
          <label htmlFor="ds-sum">Summary</label>
          <textarea id="ds-sum" className="inp" rows={2} value={t.summary} onChange={(e) => setTrip("summary", e.target.value)} />
        </div>

        <div className="fld">
          <label>Itinerary</label>
          {t.itinerary.map((day, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "56px 1fr auto", gap: 8, alignItems: "start", marginBottom: 8 }}>
              <span className="pill p-l" style={{ justifySelf: "start", marginTop: 8 }}>
                Day {i + 1}
              </span>
              <div>
                <input className="inp" aria-label={`Day ${i + 1} title`} placeholder="Ranchi → Raxaul" value={day.title} onChange={(e) => setDay(i, "title", e.target.value)} />
                <textarea className="inp" aria-label={`Day ${i + 1} details`} rows={2} style={{ marginTop: 6 }} placeholder="What happens that day" value={day.description} onChange={(e) => setDay(i, "description", e.target.value)} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button type="button" className="btn b2 sm" aria-label={`Move day ${i + 1} up`} disabled={i === 0} onClick={() => moveDay(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn b2 sm" aria-label={`Move day ${i + 1} down`} disabled={i === t.itinerary.length - 1} onClick={() => moveDay(i, 1)}>
                  ↓
                </button>
                <button type="button" className="btn b2 sm" aria-label={`Remove day ${i + 1}`} disabled={t.itinerary.length === 1} onClick={() => setT((x) => ({ ...x, itinerary: x.itinerary.filter((_, j) => j !== i) }))}>
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="btn b2 sm" onClick={() => setT((x) => ({ ...x, itinerary: [...x.itinerary, { title: "", description: "" }] }))}>
            + Add day
          </button>
        </div>

        <div className="two">
          <div className="fld">
            <label htmlFor="ds-inc">Inclusions (one per line)</label>
            <textarea id="ds-inc" className="inp" rows={4} value={t.inclusions} onChange={(e) => setTrip("inclusions", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-exc">Not included (one per line)</label>
            <textarea id="ds-exc" className="inp" rows={4} value={t.exclusions} onChange={(e) => setTrip("exclusions", e.target.value)} />
          </div>
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="ds-tags">Tags (for Fill seats)</label>
            <input id="ds-tags" className="inp" placeholder="hills, family" value={t.tags} onChange={(e) => setTrip("tags", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-photo">Photo</label>
            <select id="ds-photo" className="inp" value={t.heroImageKey} onChange={(e) => setTrip("heroImageKey", e.target.value)}>
              <option value="">None</option>
              {PHOTOS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card pad" style={{ margin: "12px 0" }}>
        <b>Departure</b>
        <div className="two" style={{ marginTop: 10 }}>
          <div className="fld">
            <label htmlFor="ds-code">Code</label>
            <input id="ds-code" className="inp" placeholder="NP-28N" value={d.code} onChange={(e) => setDep("code", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-status">Status</label>
            <select id="ds-status" className="inp" value={d.status} onChange={(e) => setDep("status", e.target.value)}>
              {STATUSES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="ds-start">Starts</label>
            <input id="ds-start" type="date" className="inp" value={d.startDate} onChange={(e) => setDep("startDate", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-end">Ends</label>
            <input id="ds-end" type="date" className="inp" value={d.endDate} onChange={(e) => setDep("endDate", e.target.value)} />
          </div>
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="ds-seats">Seats</label>
            <input id="ds-seats" className="inp" inputMode="numeric" value={d.seatsTotal} onChange={(e) => setDep("seatsTotal", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-price">Price per person (₹)</label>
            <input id="ds-price" className="inp" inputMode="numeric" value={d.price} onChange={(e) => setDep("price", e.target.value)} />
          </div>
        </div>
        <div className="two">
          {isOwner ? (
            <div className="fld">
              <label htmlFor="ds-cost">Your cost per person (₹)</label>
              <input id="ds-cost" className="inp" inputMode="numeric" value={d.cost} onChange={(e) => setDep("cost", e.target.value)} />
            </div>
          ) : null}
          <div className="fld">
            <label htmlFor="ds-budget">Travel budget per person (₹)</label>
            <input id="ds-budget" className="inp" inputMode="numeric" value={d.travelBudget} onChange={(e) => setDep("travelBudget", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="ds-room">Usual room rate (₹ a night, optional)</label>
            <input id="ds-room" className="inp" inputMode="numeric" value={d.usualRoomRate} onChange={(e) => setDep("usualRoomRate", e.target.value)} />
          </div>
        </div>
        {!isOwner ? (
          <p className="muted" style={{ fontSize: 12 }}>
            The cost price is set by the owner.
          </p>
        ) : null}
        {error ? (
          <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 8 }}>
            {error}
          </p>
        ) : null}
        <div className="chips" style={{ marginTop: 12 }}>
          <button type="button" className="btn b1 sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : departure ? "Save departure" : "Add departure"}
          </button>
        </div>
      </div>
    </>
  );
}
