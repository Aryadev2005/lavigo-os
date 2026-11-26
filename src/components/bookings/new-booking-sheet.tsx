"use client";
/**
 * New booking (BKG-2): customer (search or create), departure or custom trip, pax, price per pax
 * (checked live on the server by the pricing engine for the current role), travellers, optional
 * advance. The server re-validates everything on submit; this form only previews.
 */
import type { Role } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { checkPriceAction, createBookingAction, searchCustomersAction, type PriceCheck } from "@/app/(app)/bookings/actions";
import { useToast } from "@/components/shell/toast";
import type { CustomerHit } from "@/server/domain/bookings/queries";
import { inr } from "@/server/money";

type Departure = { id: string; code: string; label: string; pricePerPax: number; seatsLeft: number };
type Source = "WALK_IN" | "PHONE" | "WEBSITE" | "WHATSAPP" | "INSTAGRAM";

export function NewBookingSheet({ role, departures, closeHref }: { role: Role; departures: Departure[]; closeHref: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  // customer
  const [query, setQuery] = useState("");
  const [rawHits, setHits] = useState<CustomerHit[]>([]);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [newCustomer, setNewCustomer] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  // trip
  const [source, setSource] = useState<Source>("WALK_IN");
  const [kind, setKind] = useState<"fixed" | "custom">("fixed");
  const [departureId, setDepartureId] = useState(departures[0]?.id ?? "");
  const [customTitle, setCustomTitle] = useState("");
  const [customStart, setCustomStart] = useState("");
  const [customCost, setCustomCost] = useState("");
  const [pax, setPax] = useState(2);
  const [price, setPrice] = useState("");
  const priceTouched = useRef(false);
  const [confirmBelowFloor, setConfirmBelowFloor] = useState(false);
  const [rawCheck, setCheck] = useState<PriceCheck | null>(null);
  // travellers + advance
  const [allTravellers, setTravellers] = useState<string[]>([]);
  const [advance, setAdvance] = useState<"none" | "manual" | "link">("none");
  const [advAmount, setAdvAmount] = useState("");
  const [advMethod, setAdvMethod] = useState<"CASH" | "BANK_TRANSFER" | "UPI" | "CARD">("CASH");
  const [error, setError] = useState<string | null>(null);

  const dep = departures.find((d) => d.id === departureId);

  // Customer search (debounced).
  useEffect(() => {
    if (customer || newCustomer || query.trim().length < 2) return;
    const t = setTimeout(() => void searchCustomersAction(query).then(setHits), 200);
    return () => clearTimeout(t);
  }, [query, customer, newCustomer]);

  // Prefill the price with the engine's auto offer (list − best eligible offer) until the user edits it.
  useEffect(() => {
    if (kind !== "fixed" || !dep || priceTouched.current) return;
    let live = true;
    void checkPriceAction({ departureId: dep.id, customerId: customer?.id, pax, pricePerPax: String(dep.pricePerPax / 100) }).then((r) => {
      if (live && r.view && !priceTouched.current) setPrice(String(r.view.autoOffer / 100));
    });
    return () => {
      live = false;
    };
  }, [kind, dep, pax, customer?.id]);

  // Live price check on the server (debounced).
  useEffect(() => {
    if (!price) return;
    const t = setTimeout(() => {
      void checkPriceAction({
        departureId: kind === "fixed" ? departureId : undefined,
        customCostTotal: kind === "custom" ? customCost : undefined,
        customerId: customer?.id,
        pax,
        pricePerPax: price,
        confirmBelowFloor,
      }).then(setCheck);
    }, 250);
    return () => clearTimeout(t);
  }, [price, pax, departureId, kind, customCost, customer?.id, confirmBelowFloor]);

  // Derived, not synced through effects.
  const hits = customer || newCustomer || query.trim().length < 2 ? [] : rawHits;
  const check = price ? rawCheck : null;
  const travellers = allTravellers.slice(0, pax);

  const view = check?.view;
  const ownerView = view && view.role === "OWNER" ? view : null;
  const tone = !check ? undefined : check.ok ? (check.reason === "OWNER_BELOW_FLOOR_CONFIRMED" ? "var(--warn)" : "var(--ok)") : "var(--bad)";
  const customerReady = customer || (newCustomer && newName.trim().length >= 2);
  const canSubmit = !!customerReady && !!check?.ok && !pending && (kind === "fixed" ? !!departureId : customTitle && customStart && customCost);

  function submit() {
    setError(null);
    start(async () => {
      const r = await createBookingAction({
        customer: customer ? { id: customer.id } : { name: newName, phone: newPhone || undefined },
        source,
        departureId: kind === "fixed" ? departureId : undefined,
        custom: kind === "custom" ? { title: customTitle, startDate: customStart, costTotal: customCost } : undefined,
        pax,
        pricePerPax: price,
        confirmBelowFloor,
        travellers: travellers.filter((t) => t.trim().length >= 2).map((fullName) => ({ fullName })),
        advance: advance === "manual" ? { kind: "manual", amount: advAmount, method: advMethod } : { kind: advance },
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast(`Booking ${r.code} created${r.note ? ` · ${r.note}` : ""}`, "🎉");
      router.push(`/bookings?b=${r.code}`, { scroll: false });
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <div className="h">
        <div>
          <span className="muted">Walk-in, phone or website</span>
          <h2 style={{ fontSize: 22 }}>New booking</h2>
        </div>
        <button type="button" className="btn b2 sm" onClick={() => router.push(closeHref, { scroll: false })}>
          Close
        </button>
      </div>

      <h3 style={{ margin: "6px 0 10px" }}>Customer</h3>
      {customer ? (
        <div className="kv" style={{ alignItems: "center" }}>
          <b>{customer.name}</b>
          <button type="button" className="btn b2 sm" onClick={() => setCustomer(null)}>
            Change
          </button>
        </div>
      ) : newCustomer ? (
        <>
          <div className="fld">
            <label htmlFor="nb-name">Full name</label>
            <input id="nb-name" className="inp" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </div>
          <div className="fld">
            <label htmlFor="nb-phone">WhatsApp number</label>
            <input id="nb-phone" className="inp" inputMode="tel" placeholder="98350 11223" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          </div>
          <button type="button" className="btn b2 sm" onClick={() => setNewCustomer(false)}>
            Search existing instead
          </button>
        </>
      ) : (
        <div className="fld" style={{ position: "relative" }}>
          <label htmlFor="nb-search">Search by name or phone</label>
          <input id="nb-search" className="inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Riya, 98350…" autoFocus />
          {hits.length ? (
            <div className="card" style={{ marginTop: 6, padding: 6 }}>
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="btn b2 sm"
                  style={{ display: "flex", width: "100%", justifyContent: "space-between", marginBottom: 4, border: 0 }}
                  onClick={() => setCustomer({ id: h.id, name: h.name })}
                >
                  <span>{h.name}</span>
                  <small className="muted">
                    {h.phone ?? "no phone"} · {h.bookings} booking{h.bookings === 1 ? "" : "s"}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="btn b2 sm"
            style={{ marginTop: 8 }}
            onClick={() => {
              setNewCustomer(true);
              setNewName(/\d/.test(query) ? "" : query);
              setNewPhone(/\d/.test(query) ? query : "");
            }}
          >
            + New customer
          </button>
        </div>
      )}

      <h3 style={{ margin: "18px 0 10px" }}>Trip</h3>
      <div className="chips" style={{ marginBottom: 10 }}>
        <button type="button" className={`pill ${kind === "fixed" ? "p-l" : "p-g"}`} style={{ border: 0 }} onClick={() => setKind("fixed")}>
          Group departure
        </button>
        <button type="button" className={`pill ${kind === "custom" ? "p-l" : "p-g"}`} style={{ border: 0 }} onClick={() => setKind("custom")}>
          Custom trip
        </button>
      </div>
      {kind === "fixed" ? (
        <div className="fld">
          <label htmlFor="nb-dep">Departure</label>
          <select
            id="nb-dep"
            className="inp"
            value={departureId}
            onChange={(e) => {
              priceTouched.current = false;
              setDepartureId(e.target.value);
            }}
          >
            {departures.map((d) => (
              <option key={d.id} value={d.id} disabled={d.seatsLeft <= 0}>
                {d.label} · {d.seatsLeft} seats left
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="fld">
            <label htmlFor="nb-ct">Trip name</label>
            <input id="nb-ct" className="inp" placeholder="Goa family (Saurav K.)" value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="fld" style={{ flex: 1 }}>
              <label htmlFor="nb-cs">Start date</label>
              <input id="nb-cs" type="date" className="inp" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </div>
            <div className="fld" style={{ flex: 1 }}>
              <label htmlFor="nb-cc">Planned cost, all travellers (₹)</label>
              <input id="nb-cc" className="inp" inputMode="decimal" value={customCost} onChange={(e) => setCustomCost(e.target.value)} />
            </div>
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <div className="fld" style={{ flex: "0 0 110px" }}>
          <label htmlFor="nb-pax">Travellers</label>
          <input
            id="nb-pax"
            className="inp"
            type="number"
            min={1}
            max={kind === "fixed" ? Math.max(1, dep?.seatsLeft ?? 1) : 200}
            value={pax}
            onChange={(e) => setPax(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="fld" style={{ flex: 1 }}>
          <label htmlFor="nb-price">Price per person (₹, incl. GST)</label>
          <input
            id="nb-price"
            className="inp"
            inputMode="decimal"
            value={price}
            onChange={(e) => {
              priceTouched.current = true;
              setPrice(e.target.value);
            }}
          />
        </div>
        <div className="fld" style={{ flex: "0 0 90px" }}>
          <label htmlFor="nb-src">Source</label>
          <select id="nb-src" className="inp" value={source} onChange={(e) => setSource(e.target.value as Source)}>
            <option value="WALK_IN">Walk-in</option>
            <option value="PHONE">Phone</option>
            <option value="WEBSITE">Website</option>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="INSTAGRAM">Instagram</option>
          </select>
        </div>
      </div>

      {check ? (
        <div className="card pad" style={{ background: "var(--lav3)", fontSize: 13 }}>
          <b style={{ color: tone }}>{check.message}</b>
          {view ? (
            <div className="muted" style={{ marginTop: 4 }}>
              List {inr(view.listPrice)}
              {view.appliedOffers.length ? ` · ${view.appliedOffers.map((o) => o.name).join(", ")} → ${inr(view.autoOffer)}` : ""}
              {` · you can go down to ${inr(view.staffLimit)} alone`}
              {ownerView ? ` · floor ${inr(ownerView.floor)} · margin at this price ${(ownerView.marginBpsAtQuote / 100).toFixed(1)}%` : ""}
            </div>
          ) : null}
          {check.ok && check.totalAmount !== null ? <div style={{ marginTop: 4 }}>Total {inr(check.totalAmount)}</div> : null}
          {check.needsConfirmBelowFloor ? (
            <label style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input type="checkbox" checked={confirmBelowFloor} onChange={(e) => setConfirmBelowFloor(e.target.checked)} />
              I confirm selling below my minimum margin (this is logged)
            </label>
          ) : null}
        </div>
      ) : null}

      <h3 style={{ margin: "18px 0 10px" }}>
        Travellers <small className="muted" style={{ fontWeight: 500 }}>optional now, add later</small>
      </h3>
      {Array.from({ length: Math.min(pax, travellers.length + 1) }, (_, i) => (
        <input
          key={i}
          className="inp"
          style={{ marginBottom: 6 }}
          placeholder={i === 0 ? "Lead traveller, full name as on ID" : `Traveller ${i + 1}`}
          value={travellers[i] ?? ""}
          aria-label={`Traveller ${i + 1}`}
          onChange={(e) =>
            setTravellers((ts) => {
              const next = [...ts];
              next[i] = e.target.value;
              return next;
            })
          }
        />
      ))}

      <h3 style={{ margin: "18px 0 10px" }}>Advance</h3>
      <div className="chips" style={{ marginBottom: 10 }}>
        {(
          [
            ["none", "Not yet"],
            ["manual", "Received now"],
            ["link", "Send payment link"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={`pill ${advance === k ? "p-l" : "p-g"}`} style={{ border: 0 }} onClick={() => setAdvance(k)}>
            {label}
          </button>
        ))}
      </div>
      {advance === "manual" ? (
        <div style={{ display: "flex", gap: 8 }}>
          <div className="fld" style={{ flex: 1 }}>
            <label htmlFor="nb-adv">Amount (₹)</label>
            <input id="nb-adv" className="inp" inputMode="decimal" value={advAmount} onChange={(e) => setAdvAmount(e.target.value)} />
          </div>
          <div className="fld" style={{ flex: 1 }}>
            <label htmlFor="nb-advm">Method</label>
            <select id="nb-advm" className="inp" value={advMethod} onChange={(e) => setAdvMethod(e.target.value as typeof advMethod)}>
              <option value="CASH">Cash</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
            </select>
          </div>
        </div>
      ) : advance === "link" ? (
        <p className="muted" style={{ fontSize: 13 }}>
          A UPI link for the {role === "OWNER" ? "advance (your advance % of the total)" : "advance"} goes to the customer on WhatsApp. Seats are held until it&apos;s paid.
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          Seats are held for the quote validity period; unpaid holds are released automatically.
        </p>
      )}

      {error ? (
        <p style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 10 }} role="alert">
          {error}
        </p>
      ) : null}
      <div className="chips" style={{ marginTop: 16 }}>
        <button type="submit" className="btn b1" disabled={!canSubmit}>
          {pending ? "Creating…" : "Create booking"}
        </button>
        <button type="button" className="btn b2" onClick={() => router.push(closeHref, { scroll: false })}>
          Cancel
        </button>
      </div>
    </form>
  );
}
