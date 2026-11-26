"use client";
/** Top-bar search (TOD-6): customers by name/phone, bookings by code. Results open the booking list or drawer. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { searchAction } from "@/app/(app)/search-actions";
import { SearchIcon } from "./icons";

type Results = Awaited<ReturnType<typeof searchAction>>;

export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [raw, setRaw] = useState<Results | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => void searchAction(q).then((r) => live && setRaw(r)), 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const results = q.trim().length >= 2 ? raw : null;
  const empty = results && results.customers.length === 0 && results.bookings.length === 0;
  const reset = () => {
    setOpen(false);
    setQ("");
  };
  const go = (href: string) => {
    reset();
    router.push(href);
  };

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <label className="search">
        <SearchIcon />
        <input
          placeholder="Search customer, booking, phone"
          aria-label="Search"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && results) {
              const b = results.bookings[0];
              const c = results.customers[0];
              if (b) go(`/bookings?b=${b.code}`);
              else if (c) go(`/bookings?customer=${c.id}`);
            }
          }}
        />
      </label>
      {open && results ? (
        <div className="card" role="listbox" style={{ position: "absolute", top: 46, left: 0, right: 0, zIndex: 40, padding: 6, boxShadow: "0 14px 40px -12px rgba(0,0,0,.25)" }}>
          {empty ? <div className="muted" style={{ padding: 10, fontSize: 13 }}>No matches</div> : null}
          {results.bookings.length ? <small className="muted" style={{ display: "block", padding: "6px 8px" }}>Bookings</small> : null}
          {results.bookings.map((b) => (
            <Link key={b.code} href={`/bookings?b=${b.code}`} onClick={reset} style={{ display: "block", padding: "7px 8px", borderRadius: 8, fontSize: 13.5 }}>
              <b>{b.code}</b> <span className="muted">· {b.customerName} · {b.trip}</span>
            </Link>
          ))}
          {results.customers.length ? <small className="muted" style={{ display: "block", padding: "6px 8px" }}>Customers</small> : null}
          {results.customers.map((c) => (
            <Link key={c.id} href={`/bookings?customer=${c.id}`} onClick={reset} style={{ display: "block", padding: "7px 8px", borderRadius: 8, fontSize: 13.5 }}>
              <b>{c.name}</b>{" "}
              <span className="muted">
                · {c.phone ?? "no phone"} · {c.bookings} booking{c.bookings === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
