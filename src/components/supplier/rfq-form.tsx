"use client";
/**
 * SUP-2 "New rate request" (demo supplier()): destination, check-in, nights, rooms, category, meal
 * plan, "Send to" chips preselected by destination, and the editable "Your usual rate here" baseline.
 */
import type { MealPlan, RoomCategory } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { createRfqAction } from "@/app/(app)/supplier/actions";
import { useToast } from "@/components/shell/toast";
import { CATEGORY_LABEL, destinationMatches, MEAL_PLAN_LABEL } from "@/server/domain/suppliers/common";
import type { RfqForm as FormData } from "@/server/domain/suppliers/queries";

const rupeesOf = (paise: number | null | undefined) => (paise ? String(Math.round(paise / 100)) : "");

export function RfqForm({ form }: { form: FormData }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  const firstDest = form.destinations.find((d) => form.suppliers.some((s) => s.destinations.includes(d))) ?? form.destinations[0] ?? "";
  const firstDep = form.departures.find((d) => destinationMatches(d.destination, firstDest)) ?? null;

  const [destination, setDestination] = useState(firstDest);
  const [departureId, setDepartureId] = useState<string>(firstDep?.id ?? "");
  const [checkIn, setCheckIn] = useState(firstDep?.checkIn ?? "");
  const [nights, setNights] = useState(3);
  const [rooms, setRooms] = useState(10);
  const [category, setCategory] = useState<RoomCategory>("COMFORT");
  const [mealPlan, setMealPlan] = useState<MealPlan>("MAP");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(form.suppliers.filter((s) => s.destinations.some((d) => destinationMatches(d, firstDest))).map((s) => s.id)));
  const [baselineEdited, setBaselineEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dep = form.departures.find((d) => d.id === departureId) ?? null;
  // Prefill: the departure's usual room rate, else the last booked rate for destination + category.
  const prefill = useMemo(
    () => dep?.usualRoomRate ?? form.lastBooked.find((b) => b.destination === destination && b.category === category)?.rate ?? null,
    [dep, form.lastBooked, destination, category],
  );
  const baseline = baselineEdited ?? rupeesOf(prefill);

  const chooseDestination = (d: string) => {
    setDestination(d);
    setPicked(new Set(form.suppliers.filter((s) => s.destinations.some((x) => destinationMatches(x, d))).map((s) => s.id)));
    const match = form.departures.find((x) => destinationMatches(x.destination, d));
    if (dep && !destinationMatches(dep.destination, d)) setDepartureId(match?.id ?? "");
  };
  const chooseDeparture = (idValue: string) => {
    setDepartureId(idValue);
    const d = form.departures.find((x) => x.id === idValue);
    if (d) {
      setCheckIn(d.checkIn);
      const dest = form.destinations.find((x) => form.suppliers.some((s) => s.destinations.includes(x)) && destinationMatches(x, d.destination));
      if (dest && dest !== destination) chooseDestination(dest);
    }
    setBaselineEdited(null);
  };
  const toggle = (sid: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(sid)) n.delete(sid);
      else n.add(sid);
      return n;
    });

  const submit = () => {
    setError(null);
    start(async () => {
      const r = await createRfqAction({
        destination,
        departureId: departureId || null,
        checkIn,
        nights,
        rooms,
        category,
        mealPlan,
        baseline,
        supplierIds: [...picked],
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast(`Rate request sent to ${r.sentTo} supplier${r.sentTo === 1 ? "" : "s"}`, "📨");
      router.push(`/supplier?rfq=${r.rfqId}`, { scroll: false });
    });
  };

  const n = picked.size;
  return (
    <div className="card pad">
      <h3 style={{ marginBottom: 4 }}>New rate request</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        One request goes to all your hotels and agents on WhatsApp and email. Their replies land here.
      </p>
      <div className="fld">
        <label htmlFor="rfq-dest">Destination</label>
        <select id="rfq-dest" className="inp" value={destination} onChange={(e) => chooseDestination(e.target.value)}>
          {form.destinations.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="rfq-dep">For departure (optional)</label>
        <select id="rfq-dep" className="inp" value={departureId} onChange={(e) => chooseDeparture(e.target.value)}>
          <option value="">Not linked to a departure</option>
          {form.departures.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div className="two">
        <div className="fld">
          <label htmlFor="rfq-in">Check-in</label>
          <input id="rfq-in" className="inp" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="rfq-n">Nights</label>
          <input id="rfq-n" className="inp" type="number" min={1} max={30} value={nights} onChange={(e) => setNights(Number(e.target.value) || 1)} />
        </div>
      </div>
      <div className="two">
        <div className="fld">
          <label htmlFor="rfq-r">Rooms</label>
          <input id="rfq-r" className="inp" type="number" min={1} max={200} value={rooms} onChange={(e) => setRooms(Number(e.target.value) || 1)} />
        </div>
        <div className="fld">
          <label htmlFor="rfq-c">Category</label>
          <select
            id="rfq-c"
            className="inp"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as RoomCategory);
              setBaselineEdited(null);
            }}
          >
            {(Object.keys(CATEGORY_LABEL) as RoomCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="fld">
        <label htmlFor="rfq-m">Meal plan</label>
        <select id="rfq-m" className="inp" value={mealPlan} onChange={(e) => setMealPlan(e.target.value as MealPlan)}>
          {(["MAP", "CP", "AP", "EP"] as MealPlan[]).map((m) => (
            <option key={m} value={m}>
              {MEAL_PLAN_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label>Send to</label>
        <div className="chips">
          {form.suppliers.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`pill ${picked.has(s.id) ? "p-l" : "p-g"}`}
              style={{ border: 0, cursor: "pointer" }}
              aria-pressed={picked.has(s.id)}
              title={`${s.destinations.join(", ")} · ${s.channel === "EMAIL" ? "email" : "WhatsApp"}`}
              onClick={() => toggle(s.id)}
            >
              {s.name}
            </button>
          ))}
          {form.suppliers.length === 0 ? <span className="muted">Add suppliers first.</span> : null}
        </div>
      </div>
      <div className="fld">
        <label htmlFor="rfq-b">Your usual rate here (₹/room/night)</label>
        <input id="rfq-b" className="inp" inputMode="numeric" placeholder="e.g. 2500" value={baseline} onChange={(e) => setBaselineEdited(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5 }}>
          {error}
        </p>
      ) : null}
      <button type="button" className="btn b1" style={{ width: "100%", marginTop: 6 }} disabled={pending || n === 0 || !checkIn} onClick={submit}>
        {pending ? "Sending…" : `Send to ${n} supplier${n === 1 ? "" : "s"}`}
      </button>
      {baseline ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Your usual rate here: ₹{Number(baseline).toLocaleString("en-IN")}/room/night
        </p>
      ) : null}
    </div>
  );
}
