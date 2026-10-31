import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LengthUnit } from '@shared/utils/units'
import type { GpuPolicy, JobPriority, ToolPolicy } from '@shared/api/polypalApi'

export type UiScale = 'small' | 'medium' | 'large' | 'very-large'
export type BackendStatus = 'not_started' | 'starting' | 'ready' | 'error'
export type SetupStatus = 'idle' | 'checking' | 'needed' | 'installing' | 'done' | 'error'
export interface SetupProgress { step: string; percent: number; currentPackage?: string }

export type GenerationStatus =
  | 'idle'
  | 'uploading'
  | 'generating'
  | 'done'
  | 'error'

export interface GenerationJob {
  id: string
  imageFile: string
  status: GenerationStatus
  progress: number
  step?: string
  outputUrl?: string
  originalOutputUrl?: string   // mesh URL before any optimization
  thumbnailUrl?: string
  modelId?: string             // model used for this generation
  originalTriangles?: number   // polygon count of the original mesh
  generationOptions?: GenerationOptions
  error?: string
  createdAt: number
}

export interface GenerationOptions {
  modelId: string
  remesh: 'quad' | 'triangle' | 'none'
  enableTexture: boolean
  textureResolution: number
  modelParams: Record<string, any>
}

export interface MeshViewStats {
  vertices: number
  triangles: number
  /** Bounding-box size in model units (metres when a real-world size is set). */
  extents?: [number, number, number]
}

export interface LightSettings {
  mainIntensity: number
  mainColor: string
  fillIntensity: number
  fillColor: string
  ambientIntensity: number
  envIntensity: number
}

export interface PointLight {
  id: string
  position: [number, number, number]
  color: string
  intensity: number
}

export interface AppToast {
  id: number
  message: string
  durationMs?: number
}

const DEFAULT_OPTIONS: GenerationOptions = {
  modelId: '',
  remesh: 'quad',
  enableTexture: false,
  textureResolution: 512,
  modelParams: {},
}

export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
  // Matches the offline debug renderer's flat studio rig: two soft directional
  // lights (key ~0.8 / fill ~0.35) + high ambient (0.45) that lifts dark albedo
  // (black cat) out of "void" shadows, NO IBL (envIntensity 0).
  // All live-adjustable from the Lighting popover (Reset returns here).
  mainIntensity: 0.8,
  mainColor: '#ffffff',
  fillIntensity: 0.35,
  fillColor: '#ffffff',
  ambientIntensity: 0.45,
  envIntensity: 0.0,
}

interface AppState {
  // Backend
  backendStatus: BackendStatus
  apiUrl: string
  backendError: string | null

  // Current generation
  currentJob: GenerationJob | null

  // Selected image (shared between ImageUpload and the Generate button)
  selectedImagePath: string | null
  setSelectedImagePath: (path: string | null) => void
  selectedImagePreviewUrl: string | null
  setSelectedImagePreviewUrl: (url: string | null) => void
  selectedImageData: string | null   // base64 content for drag & drop (when path is unavailable)
  setSelectedImageData: (data: string | null) => void

  // Generation options
  generationOptions: GenerationOptions

  // Mesh stats (set by Viewer3D, read by GenerationHUD)
  meshStats: MeshViewStats | null
  setMeshStats: (stats: MeshViewStats | null) => void

  // Mesh selection (set by Viewer3D click, read by the Generate tools bar)
  meshSelected: boolean
  setMeshSelected: (selected: boolean) => void

  // Setup
  setupStatus:    SetupStatus
  setupProgress:  SetupProgress | null
  setupError:     string | null
  defaultDataDir: string
  platform: string
  arch: string
  checkSetup:     () => Promise<void>
  runSetup:       () => Promise<void>
  saveDataDir:    (baseDir: string) => Promise<void>

  // Patch auto-update
  patchUpdateReady: boolean
  setPatchUpdateReady: (ready: boolean) => void

  // Error modal
  errorModal: string | null
  showError: (message: string) => void
  hideError: () => void

  // Toast
  toast: AppToast | null
  showToast: (message: string, durationMs?: number) => void
  hideToast: () => void

  // Mesh URL history (undo/redo). Labels describe the change that produced each entry.
  meshHistory: string[]
  meshHistoryLabels: string[]
  historyIndex: number
  pushMeshUrl: (url: string, label?: string) => void
  jumpToHistory: (index: number) => void
  undoMesh: () => void
  redoMesh: () => void
  clearMeshHistory: () => void

  // UI preferences
  showRamIndicator: boolean
  setShowRamIndicator: (v: boolean) => void

  // Accessibility
  useAtkinsonFont: boolean
  setUseAtkinsonFont: (v: boolean) => void
  uiScale: UiScale
  setUiScale: (v: UiScale) => void

  // Real-world units used for display and size input
  units: LengthUnit
  setUnits: (u: LengthUnit) => void

  // Viewer diagnostics
  contactShadows: boolean
  setContactShadows: (v: boolean) => void

  // Copilot: which tool risks wait for approval
  copilotToolPolicy: ToolPolicy
  setCopilotToolPolicy: (p: ToolPolicy) => void

  // GPU management (mirrored to the backend on startup and on change)
  gpuPolicy: GpuPolicy
  setGpuPolicy: (p: Partial<GpuPolicy>) => void
  generationPriority: JobPriority
  setGenerationPriority: (p: JobPriority) => void

  // Interface mode: Simplified (default) or Advanced (the full studio)
  uiMode: 'simple' | 'advanced'
  setUiMode: (mode: 'simple' | 'advanced') => void
  // Texture after generating: ask each time, always, or never
  textureMode: 'ask' | 'yes' | 'no'
  setTextureMode: (mode: 'ask' | 'yes' | 'no') => void

  // Mesh editor side panel
  editorOpen: boolean
  setEditorOpen: (v: boolean) => void
  editPlanner: 'rules' | 'ai'
  setEditPlanner: (v: 'rules' | 'ai') => void

  // 3D viewer lighting
  lightSettings: LightSettings
  setLightSettings: (settings: LightSettings) => void
  pointLights: PointLight[]
  setPointLights: (lights: PointLight[]) => void

  // Actions
  initApp: () => Promise<void>
  setCurrentJob: (job: GenerationJob | null) => void
  updateCurrentJob: (patch: Partial<GenerationJob>) => void
  setGenerationOptions: (patch: Partial<GenerationOptions>) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      backendStatus: 'not_started',
      apiUrl: '',
      backendError: null,

      setupStatus: 'idle',
      setupProgress: null,
      setupError: null,
      defaultDataDir: '',
      platform: '',
      arch: '',

      checkSetup: async () => {
        set({ setupStatus: 'checking' })
        const { needed, defaultDataDir, platform, arch } = await window.electron.setup.check()
        set({ setupStatus: needed ? 'needed' : 'done', defaultDataDir, platform, arch })
      },

      saveDataDir: async (baseDir: string) => {
        await window.electron.setup.saveDataDir(baseDir)
        get().runSetup()
      },

      runSetup: async () => {
        set({ setupStatus: 'installing', setupProgress: null, setupError: null })

        window.electron.setup.offProgress()
        window.electron.setup.offComplete()
        window.electron.setup.offError()

        window.electron.setup.onProgress((data) => {
          set({ setupProgress: data })
        })
        window.electron.setup.onComplete(() => {
          set({ setupStatus: 'done', setupProgress: null })
        })
        window.electron.setup.onError((data) => {
          set({ setupStatus: 'error', setupError: data.message })
        })

        // Fire and forget — progress comes via IPC events
        window.electron.setup.run()
      },

      patchUpdateReady: false,
      setPatchUpdateReady: (ready) => set({ patchUpdateReady: ready }),

      errorModal: null,
      showError: (message) => set({ errorModal: message }),
      hideError: () => set({ errorModal: null }),

      toast: null,
      showToast: (message, durationMs) => set({ toast: { id: Date.now(), message, durationMs } }),
      hideToast: () => set({ toast: null }),

      meshHistory: [],
      meshHistoryLabels: [],
      historyIndex: -1,

      pushMeshUrl: (url, label) => {
        const { meshHistory, meshHistoryLabels, historyIndex } = get()
        const next = [...meshHistory.slice(0, historyIndex + 1), url]
        const labels = [...meshHistoryLabels.slice(0, historyIndex + 1), label ?? (next.length === 1 ? 'Original' : 'Edit')]
        set({ meshHistory: next, meshHistoryLabels: labels, historyIndex: next.length - 1 })
      },

      jumpToHistory: (index) => {
        const { meshHistory } = get()
        if (index < 0 || index >= meshHistory.length) return
        set({ historyIndex: index })
        get().updateCurrentJob({ outputUrl: meshHistory[index] })
      },

      undoMesh: () => {
        const { meshHistory, historyIndex } = get()
        if (historyIndex <= 0) return
        const newIndex = historyIndex - 1
        set({ historyIndex: newIndex })
        get().updateCurrentJob({ outputUrl: meshHistory[newIndex] })
      },

      redoMesh: () => {
        const { meshHistory, historyIndex } = get()
        if (historyIndex >= meshHistory.length - 1) return
        const newIndex = historyIndex + 1
        set({ historyIndex: newIndex })
        get().updateCurrentJob({ outputUrl: meshHistory[newIndex] })
      },

      clearMeshHistory: () => set({ meshHistory: [], meshHistoryLabels: [], historyIndex: -1 }),

      units: 'cm',
      setUnits: (u) => set({ units: u }),

      contactShadows: true,
      setContactShadows: (v) => set({ contactShadows: v }),

      copilotToolPolicy: 'confirm_heavy',
      setCopilotToolPolicy: (p) => set({ copilotToolPolicy: p }),

      gpuPolicy: { unload_before_launch: 'auto', idle_unload_minutes: 15 },
      setGpuPolicy: (p) => {
        const next = { ...get().gpuPolicy, ...p }
        set({ gpuPolicy: next })
        void pushGpuPolicy(get().apiUrl, next)
      },
      generationPriority: 'normal',
      setGenerationPriority: (p) => set({ generationPriority: p }),

      uiMode: 'simple',
      setUiMode: (mode) => set({ uiMode: mode }),
      textureMode: 'ask',
      setTextureMode: (mode) => set({ textureMode: mode }),

      editorOpen: false,
      setEditorOpen: (v) => set({ editorOpen: v }),
      editPlanner: 'rules',
      setEditPlanner: (v) => set({ editPlanner: v }),

      showRamIndicator: true,
      setShowRamIndicator: (v) => set({ showRamIndicator: v }),

      useAtkinsonFont: false,
      setUseAtkinsonFont: (v) => set({ useAtkinsonFont: v }),
      uiScale: 'medium',
      setUiScale: (v) => set({ uiScale: v }),

      lightSettings: DEFAULT_LIGHT_SETTINGS,
      setLightSettings: (settings) => set({ lightSettings: settings }),
      pointLights: [],
      setPointLights: (lights) => set({ pointLights: lights }),

      currentJob: null,
      selectedImagePath: null,
      setSelectedImagePath: (path) => set({ selectedImagePath: path }),
      selectedImagePreviewUrl: null,
      setSelectedImagePreviewUrl: (url) => set({ selectedImagePreviewUrl: url }),
      selectedImageData: null,
      setSelectedImageData: (data) => set({ selectedImageData: data }),
      generationOptions: DEFAULT_OPTIONS,
      meshStats: null,
      setMeshStats: (stats) => set({ meshStats: stats }),
      meshSelected: false,
      setMeshSelected: (selected) => set({ meshSelected: selected }),
      initApp: async () => {
        set({ backendStatus: 'starting', backendError: null })

        window.electron.python.offCrashed()
        window.electron.python.onCrashed(({ code }) => {
          const msg = `FastAPI process crashed unexpectedly (exit code: ${code ?? 'unknown'})`
          set({ backendStatus: 'error', apiUrl: '', backendError: msg })
          get().showError(msg)
        })

        try {
          const result = await window.electron.python.start()
          if (!result.success) throw new Error(result.error ?? 'Failed to start backend')
          const { apiUrl } = await window.electron.app.info()
          set({ backendStatus: 'ready', apiUrl })
          // The backend keeps the GPU policy in memory; restore the user's choice.
          void pushGpuPolicy(apiUrl, get().gpuPolicy)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ backendStatus: 'error', backendError: msg })
          get().showError(msg)
        }
      },

      setCurrentJob: (job) => set({ currentJob: job, meshStats: job === null ? null : get().meshStats }),

      updateCurrentJob: (patch) => {
        const current = get().currentJob
        if (!current) return
        set({ currentJob: { ...current, ...patch } })
      },

      setGenerationOptions: (patch) => {
        set((state) => ({ generationOptions: { ...state.generationOptions, ...patch } }))
      },
    }),
    {
      name: 'polypal-store',
      partialize: (state) => ({
        generationOptions: state.generationOptions,
        showRamIndicator: state.showRamIndicator,
        useAtkinsonFont: state.useAtkinsonFont,
        uiScale: state.uiScale,
        lightSettings: state.lightSettings,
        units: state.units,
        contactShadows: state.contactShadows,
        copilotToolPolicy: state.copilotToolPolicy,
        gpuPolicy: state.gpuPolicy,
        generationPriority: state.generationPriority,
        editorOpen: state.editorOpen,
        editPlanner: state.editPlanner,
        uiMode: state.uiMode,
        textureMode: state.textureMode,
      }),
    }
  )
)

async function pushGpuPolicy(apiUrl: string, policy: GpuPolicy): Promise<void> {
  if (!apiUrl) return
  try {
    await fetch(`${apiUrl}/gpu/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    })
  } catch {
    // Backend not reachable yet; initApp pushes it again once ready.
  }
}
