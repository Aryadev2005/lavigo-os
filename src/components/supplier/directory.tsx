"use client";
/** SUP-1 supplier directory sheet: list + create/edit (name, type, destinations, phone, email, channel). */
import type { ContactChannel, SupplierType } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveSupplierAction } from "@/app/(app)/supplier/actions";
import { useToast } from "@/components/shell/toast";
import type { SupplierRow } from "@/server/domain/suppliers/queries";

const TYPES: [SupplierType, string][] = [
  ["HOTEL", "Hotel"],
  ["AGENT", "Agent"],
  ["DMC", "DMC"],
  ["TRANSPORT", "Transport"],
  ["OTHER", "Other"],
];

type Draft = {
  name: string;
  type: SupplierType;
  destinations: string;
  contactName: string;
  phone: string;
  email: string;
  preferredChannel: ContactChannel;
  active: boolean;
  notes: string;
};

const blank: Draft = { name: "", type: "HOTEL", destinations: "", contactName: "", phone: "", email: "", preferredChannel: "WHATSAPP", active: true, notes: "" };

const toDraft = (s: SupplierRow): Draft => ({
  name: s.name,
  type: s.type,
  destinations: s.destinations.join(", "),
  contactName: s.contactName ?? "",
  phone: s.phone ?? "",
  email: s.email ?? "",
  preferredChannel: s.preferredChannel,
  active: s.active,
  notes: s.notes ?? "",
});

export function SupplierDirectory({ suppliers, closeHref }: { suppliers: SupplierRow[]; closeHref: string }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [d, setD] = useState<Draft>(blank);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const edit = (s: SupplierRow | null) => {
    setError(null);
    setEditing(s ? s.id : "new");
    setD(s ? toDraft(s) : blank);
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveSupplierAction(editing === "new" ? null : editing, {
        name: d.name,
        type: d.type,
        destinations: d.destinations.split(/[;\n]|,(?=\s*[A-Z])/).map((x) => x.trim()).filter(Boolean),
        contactName: d.contactName,
        phone: d.phone,
        email: d.email,
        preferredChannel: d.preferredChannel,
        active: d.active,
        notes: d.notes,
      });
      if (!r.ok) return setError(r.error);
      toast(editing === "new" ? `${d.name} added` : `${d.name} saved`, "🏨");
      setEditing(null);
      router.refresh();
    });

  return (
    <>
      <div className="h">
        <div>
          <span className="muted">Supplier desk</span>
          <h2 style={{ fontSize: 22 }}>Suppliers</h2>
        </div>
        <span style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn b1 sm" onClick={() => edit(null)}>
            + Add supplier
          </button>
          <button type="button" className="btn b2 sm" onClick={() => router.push(closeHref, { scroll: false })}>
            Close
          </button>
        </span>
      </div>

      {editing ? (
        <div className="card pad" style={{ margin: "12px 0" }}>
          <b>{editing === "new" ? "New supplier" : `Edit ${d.name}`}</b>
          <div className="two" style={{ marginTop: 10 }}>
            <div className="fld">
              <label htmlFor="sp-n">Name</label>
              <input id="sp-n" className="inp" value={d.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="sp-t">Type</label>
              <select id="sp-t" className="inp" value={d.type} onChange={(e) => set("type", e.target.value as SupplierType)}>
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="sp-d">Destinations (separate with ; or new lines)</label>
            <input id="sp-d" className="inp" placeholder="Gangtok, Sikkim; North Sikkim" value={d.destinations} onChange={(e) => set("destinations", e.target.value)} />
          </div>
          <div className="two">
            <div className="fld">
              <label htmlFor="sp-c">Contact person</label>
              <input id="sp-c" className="inp" value={d.contactName} onChange={(e) => set("contactName", e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="sp-ch">Send requests by</label>
              <select id="sp-ch" className="inp" value={d.preferredChannel} onChange={(e) => set("preferredChannel", e.target.value as ContactChannel)}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="EMAIL">Email</option>
              </select>
            </div>
          </div>
          <div className="two">
            <div className="fld">
              <label htmlFor="sp-p">WhatsApp number</label>
              <input id="sp-p" className="inp" inputMode="tel" placeholder="98350 11223" value={d.phone} onChange={(e) => set("phone", e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="sp-e">Email</label>
              <input id="sp-e" className="inp" type="email" value={d.email} onChange={(e) => set("email", e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <label htmlFor="sp-no">Notes</label>
            <input id="sp-no" className="inp" value={d.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
            <input type="checkbox" checked={d.active} onChange={(e) => set("active", e.target.checked)} /> Active (gets rate requests)
          </label>
          {error ? (
            <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 8 }}>
              {error}
            </p>
          ) : null}
          <div className="chips" style={{ marginTop: 12 }}>
            <button type="button" className="btn b1 sm" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn b2 sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <table className="t" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Destinations</th>
            <th>Contact</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
              <td>
                <b>{s.name}</b>
                <br />
                <small className="muted">
                  {TYPES.find(([t]) => t === s.type)?.[1]}
                  {s.active ? "" : " · inactive"}
                </small>
              </td>
              <td style={{ fontSize: 12.5 }}>{s.destinations.join("; ")}</td>
              <td style={{ fontSize: 12.5 }}>
                {s.preferredChannel === "EMAIL" ? "✉️ " : "💬 "}
                {s.preferredChannel === "EMAIL" ? s.email : s.phone}
                {s.contactName ? <small className="muted"> · {s.contactName}</small> : null}
              </td>
              <td>
                <button type="button" className="btn b2 sm" onClick={() => edit(s)}>
                  Edit
                </button>
              </td>
            </tr>
          ))}
          {suppliers.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                No suppliers yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
