import { useEffect } from 'react'
import { useNavStore, ADVANCED_PAGES, SIMPLE_PAGES, type Page } from '@shared/stores/navStore'
import { useAppStore } from '@shared/stores/appStore'

const ICON = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const NAV: Record<Page, { label: string; hint: string; icon: JSX.Element }> = {
  create: {
    label: '3D Generate', hint: 'Turn a picture or words into a 3D model',
    icon: <svg {...ICON}><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="m3 7 9 5 9-5M12 12v10" /></svg>,
  },
  generate: {
    label: 'Studio', hint: 'Full generation, editing and diagnostics',
    icon: <svg {...ICON}><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>,
  },
  images: {
    label: 'Image Generator', hint: 'Make pictures from a description',
    icon: <svg {...ICON}><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  },
  library: {
    label: 'Library', hint: 'Your saved models',
    icon: <svg {...ICON}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
  },
  skills: {
    label: 'Skills', hint: 'Rules and know-how for the assistant',
    icon: <svg {...ICON}><path d="M12 3 14.5 8.5 20 9.3l-4 3.9.9 5.6L12 16.2l-4.9 2.6.9-5.6-4-3.9 5.5-.8z" /></svg>,
  },
  workflows: {
    label: 'Workflows', hint: 'Node-based pipelines',
    icon: <svg {...ICON}><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h4a2 2 0 0 1 2 2v7" /></svg>,
  },
  models: {
    label: 'Extensions', hint: 'Install and manage AI models',
    icon: <svg {...ICON}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /></svg>,
  },
  settings: {
    label: 'Settings', hint: 'Preferences, AI models and mode',
    icon: <svg {...ICON}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.18V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 4.6 19.4l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.09 14H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 7.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.18l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  },
}

export function ModeSwitch({ compact = false }: { compact?: boolean }): JSX.Element {
  const uiMode = useAppStore((s) => s.uiMode)
  const setUiMode = useAppStore((s) => s.setUiMode)
  return (
    <div role="radiogroup" aria-label="Interface mode" className="grid grid-cols-2 gap-1 rounded-xl border border-white/[0.06] bg-black/30 p-1">
      {(['simple', 'advanced'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={uiMode === mode}
          onClick={() => setUiMode(mode)}
          className={`rounded-lg py-1.5 font-medium transition-colors ${compact ? 'text-[11px]' : 'text-xs'} ${
            uiMode === mode ? 'bg-accent text-white shadow-glow' : 'text-zinc-400 hover:text-zinc-100'
          }`}
        >
          {mode === 'simple' ? 'Simplified' : 'Advanced'}
        </button>
      ))}
    </div>
  )
}

export default function Sidebar(): JSX.Element {
  const { currentPage, navigate } = useNavStore()
  const uiMode = useAppStore((s) => s.uiMode)
  const pages = uiMode === 'advanced' ? ADVANCED_PAGES : SIMPLE_PAGES

  // Switching mode never strands you on a page the new mode hides.
  useEffect(() => {
    if (!pages.includes(currentPage)) navigate(pages[0])
  }, [pages, currentPage, navigate])

  return (
    <aside className="flex w-[216px] shrink-0 flex-col border-r border-white/[0.05] bg-surface-500 px-3 pb-3 pt-4">
      <nav aria-label="Main" className="flex flex-col gap-1">
        {pages.map((id) => {
          const item = NAV[id]
          const active = currentPage === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => navigate(id)}
              title={item.hint}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13.5px] transition-colors ${
                active ? 'bg-accent/[0.12] text-white' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
              }`}
            >
              {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent-light" />}
              <span className={active ? 'text-accent-light' : 'text-zinc-500 group-hover:text-zinc-300'}>{item.icon}</span>
              <span className="font-medium">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Mode</p>
        <ModeSwitch compact />
        <p className="px-1 text-[10.5px] leading-snug text-zinc-600">
          {uiMode === 'simple' ? 'Advanced adds the studio, workflows and extensions.' : 'Simplified keeps only the essentials.'}
        </p>
      </div>
    </aside>
  )
}
