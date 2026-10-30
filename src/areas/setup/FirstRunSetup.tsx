import { useEffect, useState } from 'react'
import { useAppStore, SetupProgress } from '@shared/stores/appStore'
import { PolyPalLogo } from '@shared/components/ui/PolyPalLogo'

// ─── Logo (shared) ──────────────────────────────────────────────────────────

function SplashLogo(): JSX.Element {
  return (
    <div className="mb-8">
      <PolyPalLogo size={64} />
    </div>
  )
}

function AppHeader(): JSX.Element {
  return (
    <>
      <SplashLogo />
      <h1 className="text-2xl font-semibold text-zinc-100 mb-1">PolyPal</h1>
      <p className="text-sm text-zinc-500 mb-10">AI-powered 3D mesh generation</p>
    </>
  )
}

// ─── Panels ─────────────────────────────────────────────────────────────────

function CheckingPanel(): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100">Checking environment…</p>
      <div className="mt-4 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '30%' }} />
      </div>
    </div>
  )
}

function ChoosePathPanel({
  defaultPath,
  platform,
  arch,
  onConfirm,
}: {
  defaultPath: string
  platform: string
  arch: string
  onConfirm: (path: string) => void
}): JSX.Element {
  const [selectedPath, setSelectedPath] = useState(defaultPath || '')

  // Sync if defaultPath arrives after mount (async IPC)
  useEffect(() => {
    if (defaultPath && !selectedPath) setSelectedPath(defaultPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when defaultPath arrives, not on user edits
  }, [defaultPath])

  async function handleBrowse() {
    const picked = await window.electron.fs.selectDirectory(selectedPath || undefined)
    if (picked) setSelectedPath(picked)
  }

  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100 mb-1">Choose a data folder</p>
      <p className="text-xs text-zinc-500 mb-4">
        Models can be several GB each. Choose a folder with plenty of free space.
        {platform === 'darwin' && arch === 'arm64'
          ? ' Apple Silicon is supported on this build.'
          : ' A fast local SSD is recommended.'}
      </p>

      {/* Path display */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1 min-w-0 bg-zinc-900 rounded-lg px-3 py-2">
          <p className="text-xs font-mono text-zinc-400 truncate" title={selectedPath}>
            {selectedPath || 'No folder selected'}
          </p>
        </div>
        <button
          onClick={handleBrowse}
          className="shrink-0 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition-colors"
        >
          Browse…
        </button>
      </div>

      <button
        onClick={() => onConfirm(selectedPath)}
        disabled={!selectedPath}
        className="w-full py-2 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
      >
        Continue
      </button>
    </div>
  )
}

const STEPS = [
  { key: 'enabling-site', label: 'Preparing Python' },
  { key: 'pip',           label: 'Installing pip' },
  { key: 'packages',      label: 'Installing packages' },
] as const

function stepIndex(step: string): number {
  return STEPS.findIndex((s) => s.key === step)
}

function InstallingPanel({ progress }: { progress: SetupProgress | null }): JSX.Element {
  const currentIdx = progress ? stepIndex(progress.step) : -1
  const percent = progress?.percent ?? 0

  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100 mb-4">Setting up environment…</p>

      {/* Step indicators */}
      <div className="flex gap-2 mb-4">
        {STEPS.map((step, idx) => {
          const done    = idx < currentIdx
          const active  = idx === currentIdx
          return (
            <div key={step.key} className="flex-1 min-w-0">
              <div
                className={`h-1 rounded-full transition-colors ${
                  done   ? 'bg-accent' :
                  active ? 'bg-accent opacity-60 animate-pulse' :
                           'bg-zinc-700'
                }`}
              />
              <p className={`text-xs mt-1 truncate ${active ? 'text-zinc-300' : 'text-zinc-600'}`}>
                {step.label}
              </p>
            </div>
          )
        })}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex justify-between items-center">
        <p className="text-xs text-zinc-500 truncate flex-1 min-w-0">
          {progress?.currentPackage ?? (currentIdx >= 0 ? STEPS[currentIdx]?.label : 'Initialising…')}
        </p>
        <p className="text-xs text-zinc-500 ml-2 shrink-0">{percent}%</p>
      </div>
    </div>
  )
}

function StartingPanel(): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100">Starting backend…</p>
      <p className="text-xs text-zinc-500 mt-1">Launching the local AI server</p>
      <div className="mt-4 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '40%' }} />
      </div>
    </div>
  )
}

function ApplyingUpdatePanel({ version }: { version: string }): JSX.Element {
  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-light">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-100">Applying update {version}</p>
          <p className="text-xs text-zinc-500 mt-0.5">The app will restart automatically</p>
        </div>
      </div>
      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '70%' }} />
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string | null }): JSX.Element {
  const lines = (message ?? 'Check the console for details').split('\n')
  const isAntivirusHint = message?.includes('antivirus') ?? false

  return (
    <div className="w-80 bg-surface-300 rounded-xl p-6">
      <p className="text-sm font-medium text-zinc-100">Something went wrong</p>
      <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
        {lines.map((line, i) =>
          line === '' ? (
            <div key={i} className="h-1" />
          ) : (
            <p key={i} className="text-xs text-zinc-500 font-mono break-all">{line}</p>
          )
        )}
      </div>
      {isAntivirusHint && (
        <div className="mt-3 p-3 bg-amber-950/40 border border-amber-700/40 rounded-lg">
          <p className="text-xs text-amber-400 font-medium">Antivirus detected</p>
          <p className="text-xs text-amber-500/80 mt-0.5">
            Add the app folder to your antivirus exclusions, then click Retry.
          </p>
        </div>
      )}
      <button
        onClick={() => window.location.reload()}
        className="mt-4 w-full py-2 bg-accent hover:bg-accent-dark rounded-lg text-sm font-medium text-white transition-colors"
      >
        Retry
      </button>
    </div>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function FirstRunSetup(): JSX.Element {
  const { setupStatus, setupProgress, setupError, saveDataDir, defaultDataDir, backendStatus, backendError, platform, arch } =
    useAppStore()
  const [applyingVersion, setApplyingVersion] = useState<string | null>(null)
  const isMac = platform === 'darwin'

  useEffect(() => {
    window.electron.updater.onApplying(({ version }) => setApplyingVersion(`v${version}`))
    return () => { window.electron.updater.offApplying() }
  }, [])

  const renderPanel = () => {
    if (applyingVersion) return <ApplyingUpdatePanel version={applyingVersion} />
    switch (setupStatus) {
      case 'idle':
      case 'checking':
        return <CheckingPanel />

      case 'needed':
        return <ChoosePathPanel defaultPath={defaultDataDir} platform={platform} arch={arch} onConfirm={saveDataDir} />

      case 'installing':
        return <InstallingPanel progress={setupProgress} />

      case 'done':
        // setup done — now waiting for backend
        if (backendStatus === 'error') return <ErrorPanel message={backendError} />
        return <StartingPanel />

      case 'error':
        return <ErrorPanel message={setupError} />

      default:
        return <StartingPanel />
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface-500">
      {/* Title bar */}
      <div className="flex items-center h-9 px-3 shrink-0 drag-region">
        <div className={`flex items-center gap-2 no-drag ${isMac ? 'pl-[72px]' : ''}`}>
          <PolyPalLogo size={18} />
          <span className="text-xs font-semibold text-zinc-300">PolyPal</span>
        </div>
        <div className="flex-1" />
        {!isMac && (
          <div className="flex items-center gap-1 no-drag">
            <button
              onClick={() => window.electron.window.minimize()}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-100 transition-colors"
              aria-label="Minimize"
            >
              <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
                <rect width="10" height="1" />
              </svg>
            </button>
            <button
              onClick={() => window.electron.window.close()}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-600 text-zinc-500 hover:text-white transition-colors"
              aria-label="Close"
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2">
                <line x1="0" y1="0" x2="9" y2="9" />
                <line x1="9" y1="0" x2="0" y2="9" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 items-center justify-center">
        <AppHeader />
        {renderPanel()}
      </div>
    </div>
  )
}
