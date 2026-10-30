import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { editApi, errorMessage, generationApi, type MeshStats } from '@shared/api/polypalApi'
import { isEditableMeshUrl, isWorkspaceMeshUrl, meshPathFromUrl } from '@areas/generate/meshPath'
import { showCompletionNotification, showErrorNotification } from '@shared/utils/notification'

export interface CurrentMesh {
  url:       string | null
  path:      string | null
  editable:  boolean
  workspace: boolean
}

/** The mesh in the viewer, as the API addresses it. */
export function useCurrentMesh(): CurrentMesh {
  const url = useAppStore((s) => (s.currentJob?.status === 'done' ? s.currentJob.outputUrl ?? null : null))
  return {
    url,
    path:      meshPathFromUrl(url),
    editable:  isEditableMeshUrl(url),
    workspace: isWorkspaceMeshUrl(url),
  }
}

/** Geometry/topology stats of the current mesh; refetches when it changes. */
export function useMeshStats(path: string | null, enabled = true): {
  stats: MeshStats | null
  loading: boolean
  error: string | null
  refresh: () => void
} {
  const [stats, setStats] = useState<MeshStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!path || !enabled) { setStats(null); setError(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    editApi.stats(path)
      .then((s) => { if (!cancelled) setStats(s) })
      .catch((e) => { if (!cancelled) { setStats(null); setError(errorMessage(e)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path, enabled, nonce])

  return { stats, loading, error, refresh: useCallback(() => setNonce((n) => n + 1), []) }
}

/** Show a new mesh version in the viewer and record it in undo history. */
export function applyMeshResult(url: string, label: string): void {
  const store = useAppStore.getState()
  store.updateCurrentJob({ outputUrl: url, status: 'done', progress: 100 })
  store.pushMeshUrl(url, label)
}

/** Convert an absolute file path written by a plugin into a viewer URL. */
export function urlForFile(filePath: string, workspaceDir: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const ws = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (norm.startsWith(`${ws}/`)) return `/workspace/${norm.slice(ws.length + 1).split('/').map(encodeURIComponent).join('/')}`
  return `/optimize/serve-file?path=${encodeURIComponent(filePath)}`
}

/** Absolute path of a mesh for process-extension plugins (which read from disk). */
export async function absoluteMeshPath(mesh: CurrentMesh): Promise<string | null> {
  if (!mesh.path) return null
  if (!mesh.workspace) return mesh.path
  const { workspaceDir } = await window.electron.settings.get()
  return `${workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')}/${mesh.path}`
}

/**
 * Follow a queued generation job (e.g. a regeneration) in the viewer HUD until
 * it finishes, then show the result.
 */
export async function trackGenerationJob(jobId: string, label: string): Promise<void> {
  const store = useAppStore.getState()
  store.setCurrentJob({
    id: jobId, imageFile: '', status: 'generating', progress: 0,
    step: 'Queued…', createdAt: Date.now(),
  })
  while (true) {
    await new Promise((r) => setTimeout(r, 1000))
    const current = useAppStore.getState().currentJob
    if (!current || current.id !== jobId) return  // the user moved on
    let status
    try {
      status = await generationApi.status(jobId)
    } catch (e) {
      useAppStore.getState().updateCurrentJob({ status: 'error', error: errorMessage(e) })
      return
    }
    if (status.status === 'done' && status.output_url) {
      useAppStore.getState().updateCurrentJob({
        status: 'done', progress: 100, outputUrl: status.output_url, originalOutputUrl: status.output_url,
      })
      useAppStore.getState().pushMeshUrl(status.output_url, label)
      void showCompletionNotification(`${label} complete`)
      return
    }
    if (status.status === 'error') {
      useAppStore.getState().updateCurrentJob({ status: 'error', error: status.error })
      void showErrorNotification(status.error ?? 'Unknown error', `${label} failed`)
      return
    }
    if (status.status === 'cancelled') {
      useAppStore.getState().setCurrentJob(null)
      return
    }
    const step = status.status === 'pending' && status.queue_position
      ? `Queued — position ${status.queue_position}`
      : status.step
    useAppStore.getState().updateCurrentJob({ progress: status.progress, step })
  }
}
