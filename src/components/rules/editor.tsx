"use client";
/**
 * Pricing rules editor (RUL-1 … RUL-3). Sliders, offer toggles with editable amounts, "always needs
 * your OK", and a live preview from the SAME evaluatePrice the quote builder uses. No v2 AI rules.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { saveRulesAction } from "@/app/(app)/rules/actions";
import { useToast } from "@/components/shell/toast";
import { inr } from "@/server/money";
import { FLOOR_MAX_BPS, FLOOR_MIN_BPS, PREVIEW_PAX, previewRules, SOLO_MAX, SOLO_STEP, type RuleOffer, type RuleOfferKind } from "@/server/domain/settings/rules-preview";
import type { RulesView } from "@/server/domain/settings/rules";

const OFFER_TEXT: Record<RuleOfferKind, string> = { GROUP: "Group offer", EARLY_BIRD: "Early-bird", REPEAT_TRAVELLER: "Repeat traveller" };

export function RulesEditor({ view }: { view: RulesView }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [floorPct, setFloorPct] = useState(Math.round(view.floorMarginBps / 100));
  const [solo, setSolo] = useState(Math.round(view.soloDiscountPerPax / 100));
  const [stack, setStack] = useState(view.stackOffers);
  const [groupAt, setGroupAt] = useState(String(view.escalateGroupSizeAtLeast));
  const [offers, setOffers] = useState(view.offers.map((o) => ({ ...o, amount: String(Math.round(o.amountPerPax / 100)), minPaxText: String(o.minPax ?? ""), daysText: String(o.minDaysBeforeTravel ?? "") })));
  const setOffer = (kind: RuleOfferKind, patch: Partial<(typeof offers)[number]>) => setOffers((xs) => xs.map((o) => (o.kind === kind ? { ...o, ...patch } : o)));

  const toInt = (s: string) => (/^\d{1,7}$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const rules = useMemo(() => {
    const parsed: RuleOffer[] = offers.map((o) => ({
      kind: o.kind,
      enabled: o.enabled,
      amountPerPax: toInt(o.amount) * 100,
      minPax: o.kind === "GROUP" ? toInt(o.minPaxText) : null,
      minDaysBeforeTravel: o.kind === "EARLY_BIRD" ? toInt(o.daysText) : null,
    }));
    return { floorMarginBps: floorPct * 100, soloDiscountPerPax: solo * 100, stackOffers: stack, escalateGroupSizeAtLeast: toInt(groupAt), offers: parsed, charmEnding: view.charmEnding };
  }, [floorPct, solo, stack, groupAt, offers, view.charmEnding]);
  const valid = Number.isFinite(rules.escalateGroupSizeAtLeast) && rules.offers.every((o) => Number.isFinite(o.amountPerPax) && (o.minPax === null || Number.isFinite(o.minPax)) && (o.minDaysBeforeTravel === null || Number.isFinite(o.minDaysBeforeTravel)));
  const preview = useMemo(() => (view.sample && valid ? previewRules(rules, view.sample, view.sampleOffers, new Date(`${view.today}T00:00:00Z`)) : null), [rules, valid, view.sample, view.sampleOffers, view.today]);

  const save = () =>
    start(async () => {
      setError(null);
      if (!valid) return setError("Check the numbers: whole rupees, people and days only");
      const { charmEnding: _c, ...input } = rules;
      const r = await saveRulesAction(input);
      if (!r.ok) return setError(r.error);
      toast("Pricing rules saved. The next quote uses them.", "🎚️");
      router.refresh();
    });

  return (
    <div className="g2">
      <div className="card pad">
        <h3 style={{ marginBottom: 2 }}>How your team prices</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
          Staff quotes can never go below these rules. Anything outside them comes to you as a one-tap approval.
        </p>

        <div className="rule">
          <div>
            <b>Minimum margin</b>
            <small>Nobody sells below this profit without you</small>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input type="range" aria-label="Minimum margin" min={FLOOR_MIN_BPS / 100} max={FLOOR_MAX_BPS / 100} value={floorPct} onChange={(e) => setFloorPct(+e.target.value)} />
            <b style={{ minWidth: 40 }}>{floorPct}%</b>
          </div>
        </div>
        <div className="rule">
          <div>
            <b>Extra discount staff can give on their own</b>
            <small>Per person, on top of your approved offers, without asking you</small>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input type="range" aria-label="Extra discount staff can give on their own" min={0} max={SOLO_MAX / 100} step={SOLO_STEP / 100} value={solo} onChange={(e) => setSolo(+e.target.value)} />
            <b style={{ minWidth: 56 }}>₹{solo.toLocaleString("en-IN")}</b>
          </div>
        </div>

        {offers.map((o) => (
          <div className="rule" key={o.kind}>
            <div>
              <b>{OFFER_TEXT[o.kind]}</b>
              <small style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
                ₹
                <input className="inp" aria-label={`${OFFER_TEXT[o.kind]} amount per person`} style={{ width: 80, padding: "4px 8px" }} inputMode="numeric" value={o.amount} onChange={(e) => setOffer(o.kind, { amount: e.target.value })} />
                off per person
                {o.kind === "GROUP" ? (
                  <>
                    {" "}for
                    <input className="inp" aria-label="Group offer minimum people" style={{ width: 56, padding: "4px 8px" }} inputMode="numeric" value={o.minPaxText} onChange={(e) => setOffer(o.kind, { minPaxText: e.target.value })} />
                    or more
                  </>
                ) : o.kind === "EARLY_BIRD" ? (
                  <>
                    {" "}when booked
                    <input className="inp" aria-label="Early-bird days before travel" style={{ width: 56, padding: "4px 8px" }} inputMode="numeric" value={o.daysText} onChange={(e) => setOffer(o.kind, { daysText: e.target.value })} />
                    + days before
                  </>
                ) : (
                  " for anyone who travelled with Lavigo before"
                )}
              </small>
            </div>
            <label className="sw">
              <input type="checkbox" aria-label={OFFER_TEXT[o.kind]} checked={o.enabled} onChange={(e) => setOffer(o.kind, { enabled: e.target.checked })} />
              <span />
            </label>
          </div>
        ))}
        <div className="rule">
          <div>
            <b>Combine offers</b>
            <small>Off: only the best offer applies. On: eligible offers add up.</small>
          </div>
          <label className="sw">
            <input type="checkbox" aria-label="Combine offers" checked={stack} onChange={(e) => setStack(e.target.checked)} />
            <span />
          </label>
        </div>
        <div className="rule">
          <div>
            <b>Always needs your OK</b>
            <small>These always come to you, whatever the price</small>
          </div>
          <div className="chips" style={{ justifyContent: "flex-end", alignItems: "center" }}>
            <span className="pill p-l" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              Groups of
              <input className="inp" aria-label="Groups of this size or more need your OK" style={{ width: 48, padding: "2px 6px" }} inputMode="numeric" value={groupAt} onChange={(e) => setGroupAt(e.target.value)} />+
            </span>
            <span className="pill p-l">Below floor</span>
          </div>
        </div>

        {error ? (
          <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 8 }}>
            {error}
          </p>
        ) : null}
        <div className="chips" style={{ marginTop: 12 }}>
          <button type="button" className="btn b1 sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save rules"}
          </button>
        </div>
      </div>

      <div>
        <div className="preview" id="prev" aria-live="polite">
          {preview && view.sample ? (
            <>
              <p>
                On the {view.sample.name} trip ({inr(view.sample.pricePerPax)}, your cost {inr(view.sample.costPerPax)}), for a group of {PREVIEW_PAX} your staff can go down to
              </p>
              <div className="big">{inr(preview.result.staffLimit)}</div>
              <p>
                per person on their own.
                {preview.result.staffLimit > preview.result.floor ? (
                  <>
                    {" "}Between {inr(preview.result.staffLimit)} and your floor of <b style={{ color: "#fff" }}>{inr(preview.result.floor)}</b> they ask you first, with one tap.
                  </>
                ) : (
                  " That is already your floor."
                )}{" "}
                Below <b style={{ color: "#fff" }}>{inr(preview.result.floor)}</b> only you can approve, and you see a below-floor warning.
              </p>
              <p style={{ fontSize: 12.5, marginTop: 8 }}>In short: {preview.sentence}.</p>
            </>
          ) : (
            <p>{view.sample ? "Check the numbers to see the preview." : "Add an open departure to see a preview."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
