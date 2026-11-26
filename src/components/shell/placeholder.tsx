/** Phase-0 placeholder body in the demo's card style. Real screens replace these. */
export function Placeholder({ icon, heading, items, srs }: { icon: string; heading: string; items: string[]; srs: string }) {
  return (
    <div className="wrap">
      <div className="card pad max-w-3xl">
        <div className="h">
          <h3 className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-[11px] bg-lav2 text-[17px]" aria-hidden>
              {icon}
            </span>
            {heading}
          </h3>
          <span className="pill p-l">Coming next</span>
        </div>
        <ul className="m-0 list-none p-0">
          {items.map((item) => (
            <li key={item} className="need">
              <span className="muted" aria-hidden>
                •
              </span>
              <div className="x">{item}</div>
            </li>
          ))}
        </ul>
        <p className="muted mt-2 text-xs">Requirements: {srs}</p>
      </div>
    </div>
  );
}
