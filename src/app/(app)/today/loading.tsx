/** Today skeleton: KPI row, Needs-you list, activity feed, departures (mirrors page.tsx). */
import { Skel } from "@/components/shell/skeleton";

export default function Loading() {
  return (
    <div className="wrap" aria-busy="true" aria-label="Loading Today">
      <div className="g4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card pad kpi">
            <Skel w="55%" h={12} />
            <Skel w="70%" h={28} style={{ margin: "10px 0 8px" }} />
            <Skel w="80%" h={11} />
          </div>
        ))}
      </div>
      <div className="g2e" style={{ marginTop: 16 }}>
        {[0, 1].map((c) => (
          <div key={c} className="card pad">
            <Skel w="40%" h={16} style={{ marginBottom: 16 }} />
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
                <Skel w={34} h={34} r={10} />
                <div style={{ flex: 1 }}>
                  <Skel w={`${85 - i * 9}%`} h={12} />
                  <Skel w="35%" h={10} style={{ marginTop: 6 }} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
