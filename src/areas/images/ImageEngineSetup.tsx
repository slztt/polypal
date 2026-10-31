import { useEffect } from 'react'
import { formatBytes } from '@shared/utils/format'
import { useImageEngine } from './useImageEngine'
import type { DownloadState } from '@shared/api/polypalApi'

function Progress({ state }: { state?: DownloadState }): JSX.Element | null {
  if (!state || (!state.running && !state.error)) return null
  if (state.error) return <p role="alert" className="text-xs text-red-400">{state.error}</p>
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${state.percent ?? 0}%` }} />
      </div>
      <p className="text-[11px] text-zinc-500">
        {state.status ?? 'Downloading…'}
        {state.totalBytes ? ` · ${formatBytes(state.bytesDownloaded ?? 0)} of ${formatBytes(state.totalBytes)}` : ''}
      </p>
    </div>
  )
}

/** Engine + model setup. `compact` shows just the next step needed. */
export function ImageEngineSetup({ compact = false }: { compact?: boolean }): JSX.Element {
  const { status, downloads, error, refresh, installEngine, downloadModel, cancelDownload, deleteModel } = useImageEngine()
  useEffect(() => { void refresh() }, [refresh])

  if (!status) {
    return <p className="text-sm text-zinc-500">{error ?? 'Checking the image generator…'}</p>
  }

  const engineState = downloads.engine
  const recommended = status.models.find((m) => m.default) ?? status.models[0]

  if (compact) {
    return (
      <div className="pp-card flex flex-col gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-white">Set up the image generator</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            Pictures are made on your computer. {!status.engine_installed
              ? 'First install the engine (small download).'
              : `Then download ${recommended?.name} (${recommended?.size_gb} GB).`}
          </p>
        </div>
        {!status.engine_installed ? (
          <>
            <button type="button" className="pp-btn-primary" disabled={!!engineState?.running} onClick={() => void installEngine()}>
              {engineState?.running ? 'Installing…' : 'Install image engine'}
            </button>
            <Progress state={engineState} />
          </>
        ) : recommended ? (
          <>
            <button type="button" className="pp-btn-primary" disabled={!!downloads[recommended.id]?.running}
              onClick={() => void downloadModel(recommended.id)}>
              {downloads[recommended.id]?.running ? 'Downloading…' : `Download ${recommended.name}`}
            </button>
            <Progress state={downloads[recommended.id]} />
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="pp-card flex items-center justify-between gap-4 p-4">
        <div>
          <p className="text-sm font-medium text-white">Image engine</p>
          <p className="mt-0.5 text-xs text-zinc-400">Runs on NVIDIA, AMD, Apple and CPU — no internet needed once installed.</p>
          <div className="mt-2"><Progress state={engineState} /></div>
        </div>
        {status.engine_installed
          ? <span className="pp-chip border-accent/30 text-accent-light">Installed</span>
          : <button type="button" className="pp-btn-primary" disabled={!!engineState?.running} onClick={() => void installEngine()}>
              {engineState?.running ? 'Installing…' : 'Install'}
            </button>}
      </div>

      {status.models.map((model) => {
        const state = downloads[model.id]
        return (
          <div key={model.id} className="pp-card flex items-center justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-white">{model.name}</p>
                {model.default && <span className="pp-chip">Recommended</span>}
                {model.references === 'multi' && <span className="pp-chip">Up to 5 references</span>}
              </div>
              <p className="mt-0.5 text-xs text-zinc-400">{model.description} · {model.size_gb} GB · {model.vram_gb} GB graphics memory</p>
              <div className="mt-2"><Progress state={state} /></div>
            </div>
            {model.downloaded ? (
              <button type="button" className="pp-btn-ghost" onClick={() => void deleteModel(model.id)}>Remove</button>
            ) : state?.running ? (
              <button type="button" className="pp-btn-ghost" onClick={() => void cancelDownload(model.id)}>Cancel</button>
            ) : (
              <button type="button" className="pp-btn-primary" onClick={() => void downloadModel(model.id)}>Download</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
