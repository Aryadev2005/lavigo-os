/** Shimmer placeholder used by loading.tsx files. Server component, no JS. */
export function Skel({ w = "100%", h = 14, r, style }: { w?: number | string; h?: number; r?: number; style?: React.CSSProperties }) {
  return <span className="skel" aria-hidden style={{ width: w, height: h, borderRadius: r, ...style }} />;
}
