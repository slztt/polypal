// Image generator readiness: engine installed + at least one model, with
// streamed setup downloads. Shared by the Image Generator, 3D Generate and
// Settings pages.
import { create } from 'zustand'
import { consumeSse } from '@shared/services/llmDownloads'
import { errorMessage, imagesApi, type DownloadState, type ImageStatus } from '@shared/api/polypalApi'

interface ImageEngineStore {
  status: ImageStatus | null
  error: string | null
  downloads: Record<string, DownloadState>
  refresh: () => Promise<void>
  installEngine: () => Promise<void>
  downloadModel: (id: string) => Promise<void>
  cancelDownload: (id: string) => Promise<void>
  deleteModel: (id: string) => Promise<void>
}

const watching = new Set<string>()

async function watch(key: string, url: string, set: (fn: (s: ImageEngineStore) => Partial<ImageEngineStore>) => void, refresh: () => Promise<void>) {
  if (watching.has(key)) return
  watching.add(key)
  try {
    await consumeSse(url, (event) => {
      set((s) => ({ downloads: { ...s.downloads, [key]: event as DownloadState } }))
    })
  } catch (e) {
    set((s) => ({ downloads: { ...s.downloads, [key]: { error: errorMessage(e) } } }))
  } finally {
    watching.delete(key)
    await refresh()
  }
}

export const useImageEngine = create<ImageEngineStore>((set, get) => ({
  status: null,
  error: null,
  downloads: {},
  async refresh() {
    try {
      const status = await imagesApi.status()
      set({ status, error: null })
      // Re-attach to downloads that were running before a page switch.
      for (const [key, state] of Object.entries(status.downloads)) {
        if (state.running) {
          const url = key === 'engine' ? imagesApi.engineInstallUrl() : imagesApi.modelDownloadUrl(key)
          void watch(key, url, set, get().refresh)
        }
      }
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },
  installEngine: () => watch('engine', imagesApi.engineInstallUrl(), set, get().refresh),
  downloadModel: (id) => watch(id, imagesApi.modelDownloadUrl(id), set, get().refresh),
  async cancelDownload(id) {
    await imagesApi.cancelDownload(id).catch(() => {})
  },
  async deleteModel(id) {
    await imagesApi.deleteModel(id)
    await get().refresh()
  },
}))

export function imageEngineReady(status: ImageStatus | null): boolean {
  return !!status?.engine_installed && !!status.default_model
}
