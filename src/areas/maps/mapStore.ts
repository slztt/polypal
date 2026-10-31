// Map Builder state lives in a store so leaving the tab and coming back keeps
// the picture, the options and the built map.
import { create } from 'zustand'
import { errorMessage, mapsApi, meshesApi, type MapOptions, type MapResult } from '@shared/api/polypalApi'
import { dataUrlToBlob } from '@shared/components/ui/ImagePicker'
import { showCompletionNotification, showErrorNotification } from '@shared/utils/notification'

interface MapState {
  image: string | null
  options: MapOptions
  building: boolean
  error: string | null
  result: MapResult | null
  openDoors: Record<string, boolean>
  setImage: (image: string | null) => void
  setOptions: (patch: Partial<MapOptions>) => void
  build: () => Promise<void>
  toggleDoor: (name: string) => void
  setAllDoors: (open: boolean) => void
  deleteMap: () => Promise<void>
}

export const DEFAULT_MAP_OPTIONS: MapOptions = {
  name: '',
  widthM: null,
  wallHeight: 2.7,
  walls: 'auto',
  wallColor: null,
  tolerance: 0.18,
  doors: true,
}

export const useMapStore = create<MapState>((set, get) => ({
  image: null,
  options: DEFAULT_MAP_OPTIONS,
  building: false,
  error: null,
  result: null,
  openDoors: {},

  setImage: (image) => set({ image, error: null }),
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),

  async build() {
    const { image, options } = get()
    if (!image) return
    set({ building: true, error: null })
    try {
      const result = await mapsApi.build(dataUrlToBlob(image), { ...options, name: options.name.trim() || 'map' })
      set({ result, openDoors: {} })
      void showCompletionNotification(`Your map is ready — ${result.doors.length} door${result.doors.length === 1 ? '' : 's'}`)
    } catch (e) {
      const message = errorMessage(e)
      set({ error: message })
      void showErrorNotification(message, 'Map build failed')
    } finally {
      set({ building: false })
    }
  },

  toggleDoor: (name) => set((s) => ({ openDoors: { ...s.openDoors, [name]: !s.openDoors[name] } })),
  setAllDoors: (open) => set((s) => ({
    openDoors: Object.fromEntries((s.result?.doors ?? []).map((d) => [d.name, open])),
  })),

  async deleteMap() {
    const result = get().result
    if (!result) return
    try {
      await meshesApi.remove([result.path])
      set({ result: null, openDoors: {} })
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },
}))
