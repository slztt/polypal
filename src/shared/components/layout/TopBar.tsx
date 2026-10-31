import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import MemoryIndicator from './MemoryIndicator'
import { PolyPalLogo } from '@shared/components/ui/PolyPalLogo'

export default function TopBar(): JSX.Element {
  const { patchUpdateReady, platform, showRamIndicator, uiMode } = useAppStore()
  const isMac = platform === 'darwin'

  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    window.electron.window.isMaximized().then(setIsMaximized)
    window.electron.window.onMaximizeChange(setIsMaximized)
    return () => window.electron.window.offMaximizeChange()
  }, [])

  const handleMinimize = () => window.electron.window.minimize()
  const handleMaximize = () => window.electron.window.maximize()
  const handleClose    = () => window.electron.window.close()

  return (
    <header className="flex items-center h-11 px-4 bg-surface-500 border-b border-white/[0.05] drag-region shrink-0">
      {/* App name */}
      <div className={`flex items-center gap-2 no-drag ${isMac ? 'pl-[72px]' : ''}`}>
        <PolyPalLogo size={24} />
        <span className="text-[14px] font-semibold tracking-tight text-white">PolyPal</span>
        <span className="ml-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
          {uiMode === 'simple' ? 'Simplified' : 'Advanced'}
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Memory indicator */}
      {showRamIndicator && <MemoryIndicator />}

      {/* Patch update badge */}
      {patchUpdateReady && (
        <div className="flex items-center gap-2 mr-3 px-3 py-1 rounded-full bg-accent/15 border border-accent/30 text-xs text-accent-light no-drag">
          <span>Update ready</span>
          <button
            onClick={() => window.electron.updater.quitAndInstall()}
            className="ml-1 px-2 py-0.5 rounded-full bg-accent hover:bg-accent-dark text-white text-[11px] font-medium transition-colors"
          >
            Restart
          </button>
        </div>
      )}

      {/* Window controls — Mac uses the native traffic-light buttons on the left */}
      {!isMac && (
        <div className="flex items-center gap-1 no-drag">
          <button
            onClick={handleMinimize}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
            aria-label="Minimize"
          >
            <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
              <rect width="10" height="1" />
            </svg>
          </button>
          <button
            onClick={handleMaximize}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                <rect x="2.5" y="0.5" width="7" height="7" />
                <path d="M0.5 2.5v7h7" />
              </svg>
            ) : (
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor">
                <rect x="0.5" y="0.5" width="8" height="8" />
              </svg>
            )}
          </button>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-red-600 text-zinc-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2">
              <line x1="0" y1="0" x2="9" y2="9" />
              <line x1="9" y1="0" x2="0" y2="9" />
            </svg>
          </button>
        </div>
      )}
    </header>
  )
}
