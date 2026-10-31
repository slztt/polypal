// "Your models" drawer on 3D Generate: every generated mesh in the workspace,
// with open and delete. Library copies are separate and never touched here.
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { errorMessage, meshesApi, type WorkspaceMesh } from '@shared/api/polypalApi'
import { formatBytes } from '@shared/utils/format'
import { playSfx } from '@shared/utils/sfx'
import { useCreateStore } from './createStore'

export function openMesh(url: string, label = 'Opened'): void {
  const app = useAppStore.getState()
  useCreateStore.getState().reset()
  app.clearMeshHistory()
  app.setCurrentJob({ id: `open-${Date.now()}`, imageFile: '', status: 'done', progress: 100, step: '', createdAt: Date.now(), outputUrl: url, originalOutputUrl: url })
  app.pushMeshUrl(url, label)
}

export function RecentModels({ open, onClose, refreshKey }: { open: boolean; onClose: () => void; refreshKey: unknown }): JSX.Element | null {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const currentUrl = useAppStore((s) => s.currentJob?.outputUrl)
  const [items, setItems] = useState<WorkspaceMesh[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setItems(await meshesApi.list()); setError(null) } catch (e) { setError(errorMessage(e)) }
  }, [])
  useEffect(() => { if (open) void load() }, [open, load, refreshKey])

  const remove = async (item: WorkspaceMesh) => {
    setConfirm(null)
    try {
      await meshesApi.remove([item.path])
      playSfx('delete')
      if (currentUrl === item.url) useAppStore.getState().setCurrentJob(null)
      setItems((list) => list.filter((i) => i.path !== item.path))
    } catch (e) { setError(errorMessage(e)) }
  }

  if (!open) return null
  return (
    <div className="absolute inset-x-4 bottom-[76px] z-20 flex max-h-[46%] animate-rise-in flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-surface-400/95 shadow-card backdrop-blur" role="dialog" aria-label="Your models">
      <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5">
        <p className="text-sm font-medium text-white">Your models <span className="text-zinc-500">({items.length})</span></p>
        <button type="button" aria-label="Close" className="text-zinc-500 transition-colors hover:text-white" onClick={onClose}>✕</button>
      </div>
      {error && <p role="alert" className="px-4 pt-2 text-xs text-red-400">{error}</p>}
      {items.length === 0 ? (
        <p className="p-6 text-center text-xs text-zinc-500">Models you generate show up here.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5 overflow-y-auto p-3">
          {items.map((item, i) => (
            <li key={item.path} className="pp-card pp-card-hover group relative overflow-hidden animate-pop" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
              <button type="button" className="block w-full text-left" onClick={() => { openMesh(item.url); onClose() }} title={`Open ${item.name}`}>
                <div className="aspect-square bg-black/30">
                  {item.thumbnail_url
                    ? <img src={`${apiUrl}${item.thumbnail_url}`} alt="" className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105" loading="lazy" />
                    : <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">{item.kind === 'edit' ? 'Edited model' : '3D model'}</div>}
                </div>
                <div className="px-2.5 py-1.5">
                  <p className={`truncate text-xs ${currentUrl === item.url ? 'text-accent-light' : 'text-zinc-200'}`}>{item.name}</p>
                  <p className="truncate text-[10px] text-zinc-500">{new Date(item.modified_at).toLocaleDateString()} · {formatBytes(item.bytes)}</p>
                </div>
              </button>
              {confirm === item.path ? (
                <div className="absolute inset-0 flex animate-pop flex-col items-center justify-center gap-2 bg-black/80 p-2 text-center backdrop-blur-sm">
                  <p className="text-[11px] text-zinc-200">Delete this model for good?</p>
                  <div className="flex gap-1.5">
                    <button type="button" data-sfx="none" className="rounded-lg bg-red-500/80 px-2.5 py-1 text-[11px] text-white hover:bg-red-500" onClick={() => void remove(item)}>Delete</button>
                    <button type="button" className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-white/20" onClick={() => setConfirm(null)}>Keep</button>
                  </div>
                </div>
              ) : (
                <button type="button" aria-label={`Delete ${item.name}`} onClick={() => setConfirm(item.path)}
                  className="absolute right-1.5 top-1.5 flex h-7 w-7 scale-90 items-center justify-center rounded-lg bg-black/60 text-zinc-300 opacity-0 transition-all duration-150 hover:bg-red-500/80 hover:text-white group-hover:scale-100 group-hover:opacity-100 focus:opacity-100">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
