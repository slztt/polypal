// PolyPal brand mark: a low-poly hexagon split into six shaded facets around an
// off-centre apex. resources/icons/logo.svg holds the same geometry for the
// packaged app icons — keep the two in sync.

export const LOGO_FACETS: { points: string; fill: string }[] = [
  { points: '30,29 32,4 56.25,18',       fill: '#86efac' },
  { points: '30,29 56.25,18 56.25,46',   fill: '#22c55e' },
  { points: '30,29 56.25,46 32,60',      fill: '#15803d' },
  { points: '30,29 32,60 7.75,46',       fill: '#166534' },
  { points: '30,29 7.75,46 7.75,18',     fill: '#16a34a' },
  { points: '30,29 7.75,18 32,4',        fill: '#4ade80' },
]

export function PolyPalLogo({ size = 24, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="PolyPal"
    >
      <g stroke="#ffffff" strokeOpacity="0.22" strokeWidth="0.8" strokeLinejoin="round">
        {LOGO_FACETS.map((f) => <polygon key={f.points} points={f.points} fill={f.fill} />)}
      </g>
    </svg>
  )
}
