import type { ViewMode } from '../models'
export type { ViewMode }

interface ViewerToolbarProps {
  viewMode: ViewMode
  autoRotate: boolean
  onViewMode: (mode: ViewMode) => void
  onAutoRotate: () => void
  onScreenshot: () => void
  showViewModes?: boolean   // view modes are mesh-only; hidden for splats
  canCompare?: boolean      // an earlier version exists to compare against
  compareActive?: boolean
  onCompare?: () => void
  measureActive?: boolean
  onMeasure?: () => void
  contactShadows?: boolean
  onContactShadows?: () => void
}

const DEVIATION_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M12 3a9 9 0 1 0 9 9" />
    <path d="M12 7a5 5 0 1 0 5 5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
)

const MODES: { mode: ViewMode; icon: React.ReactNode; label: string }[] = [
  {
    mode: 'solid',
    label: 'Solid',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    mode: 'wireframe',
    label: 'Wireframe',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    ),
  },
  {
    mode: 'normals',
    label: 'Normals',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <line x1="3" y1="12" x2="21" y2="12" />
      </svg>
    ),
  },
  {
    mode: 'matcap',
    label: 'Matcap',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 10 Q10 7 12 10 Q14 13 16 10" />
      </svg>
    ),
  },
  {
    mode: 'uv',
    label: 'UV Checker',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <rect x="3" y="3" width="9" height="9" fill="currentColor" fillOpacity="0.3" />
        <rect x="12" y="12" width="9" height="9" fill="currentColor" fillOpacity="0.3" />
      </svg>
    ),
  },
]

export function ViewerToolbar({
  viewMode,
  autoRotate,
  onViewMode,
  onAutoRotate,
  onScreenshot,
  showViewModes = true,
  canCompare = false,
  compareActive = false,
  onCompare,
  measureActive = false,
  onMeasure,
  contactShadows = false,
  onContactShadows,
}: ViewerToolbarProps): JSX.Element {
  return (
    <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1 bg-zinc-900/70 border border-zinc-700/50 backdrop-blur-sm rounded-xl p-1.5">
      {showViewModes && MODES.map(({ mode, icon, label }) => (
        <ToolbarButton
          key={mode}
          active={viewMode === mode}
          label={label}
          onClick={() => onViewMode(mode)}
        >
          {icon}
        </ToolbarButton>
      ))}

      {showViewModes && (
        <ToolbarButton
          active={viewMode === 'deviation'}
          disabled={!canCompare}
          label={canCompare ? 'Deviation heatmap (vs. earlier version)' : 'Deviation heatmap — edit the mesh first'}
          onClick={() => onViewMode(viewMode === 'deviation' ? 'solid' : 'deviation')}
        >
          {DEVIATION_ICON}
        </ToolbarButton>
      )}

      {showViewModes && <div className="my-1 border-t border-zinc-700/50" />}

      {showViewModes && onCompare && (
        <ToolbarButton
          active={compareActive}
          disabled={!canCompare}
          label={canCompare ? 'Before / after comparison' : 'Before / after — edit the mesh first'}
          onClick={onCompare}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="12" y1="2" x2="12" y2="22" />
            <path d="M3 4h9v16H3z" fill="currentColor" fillOpacity="0.25" />
          </svg>
        </ToolbarButton>
      )}

      {showViewModes && onMeasure && (
        <ToolbarButton active={measureActive} label="Measure distance" onClick={onMeasure}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M3 17 17 3l4 4L7 21z" />
            <path d="m7 13 2 2M10 10l2 2M13 7l2 2" />
          </svg>
        </ToolbarButton>
      )}

      {showViewModes && onContactShadows && (
        <ToolbarButton active={contactShadows} label="Contact shadows" onClick={onContactShadows}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M12 3 5 14h14z" />
            <ellipse cx="12" cy="19" rx="8" ry="2" fill="currentColor" fillOpacity="0.35" />
          </svg>
        </ToolbarButton>
      )}

      {showViewModes && (onCompare || onMeasure || onContactShadows) && <div className="my-1 border-t border-zinc-700/50" />}

      <ToolbarButton
        active={autoRotate}
        label="Auto-rotate"
        onClick={onAutoRotate}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </ToolbarButton>

      <ToolbarButton
        active={false}
        label="Screenshot"
        onClick={onScreenshot}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </ToolbarButton>
    </div>
  )
}

interface ToolbarButtonProps {
  active: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}

function ToolbarButton({ active, disabled = false, label, onClick, children }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`
        relative w-8 h-8 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none
        ${active
          ? 'bg-green-600 text-white'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60'
        }
      `}
    >
      {children}
    </button>
  )
}
