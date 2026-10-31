// The simplified 3D Generate pipeline: picture → 3D model → (optional) texture.
// It lives in a store, not a component, so a generation keeps running and its
// progress stays visible when the user switches tabs.
import { create } from 'zustand'
import { useAppStore } from '@shared/stores/appStore'
import {
  errorMessage, imagesApi, modelsApi, textureApi,
  type GeneratorModel,
} from '@shared/api/polypalApi'
import { dataUrlToBlob } from '@shared/components/ui/ImagePicker'
import { meshPathFromUrl } from '@areas/generate/meshPath'
import { applyMeshResult } from '@areas/editor/useMeshEditing'
import { brandText } from '@shared/branding'
import { showCompletionNotification, showErrorNotification } from '@shared/utils/notification'

export type CreateMode = 'image' | 'text'
export type Stage = 'idle' | 'picture' | 'model' | 'texture' | 'done' | 'error'

export interface CreateInput {
  mode: CreateMode
  image: string | null      // data URL (image mode)
  details: string           // optional extra details (image mode)
  prompt: string            // text mode
  references: string[]      // text mode, data URLs
}

export interface CreateForm {
  mode: CreateMode
  image: string | null
  details: string
  prompt: string
  references: string[]
  notice: string | null
}

interface CreateState extends CreateForm {
  setForm: (patch: Partial<CreateForm>) => void
  stage: Stage
  progress: number
  message: string
  error: string | null
  pictureUrl: string | null       // the picture the model is built from
  askTexture: boolean             // show the "add colour?" prompt
  textured: boolean
  running: boolean
  handoff: string | null          // picture sent from another page to start from
  setHandoff: (image: string | null) => void
  run: (input: CreateInput, model: GeneratorModel, opts: { imageReady: boolean }) => Promise<void>
  cancel: () => void
  texture: () => Promise<void>
  dismissTexture: () => void
  reset: () => void
}

let abort: AbortController | null = null
let activeJob: string | null = null

function apiUrl(): string {
  return useAppStore.getState().apiUrl
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url.startsWith('http') ? url : `${apiUrl()}${url}`)
  if (!res.ok) throw new Error(`Could not load the picture (${res.status})`)
  return res.blob()
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * With a reference-following image model installed (PolyPal Image Pro), draw
 * the back of the object so texturing has real colours for the far side
 * instead of guessing. Returns null (and texturing guesses) when that model
 * isn't installed or the drawing fails.
 */
async function drawBackView(pictureUrl: string | null, onStep: (message: string) => void): Promise<string | null> {
  if (!pictureUrl) return null
  try {
    const status = await imagesApi.status()
    const pro = status.engine_installed && status.models.find((m) => m.downloaded && m.references === 'multi')
    if (!pro) return null
    const front = pictureUrl.startsWith('data:') ? pictureUrl : await blobToDataUrl(await fetchBlob(pictureUrl))
    onStep('Imagining the back of your model…')
    const job = await imagesApi.run({
      prompt: 'the same object seen from directly behind, back view, identical colours, materials and style, centred, plain white background, soft even lighting',
      references: [front], model_id: pro.id, purpose: '3d', priority: useAppStore.getState().generationPriority,
    }, (j) => onStep(j.step ? `Imagining the back: ${j.step}` : 'Imagining the back of your model…'))
    return job.url ? await blobToDataUrl(await fetchBlob(job.url)) : null
  } catch {
    return null
  }
}

export const useCreateStore = create<CreateState>((set, get) => ({
  stage: 'idle',
  progress: 0,
  message: '',
  error: null,
  pictureUrl: null,
  askTexture: false,
  textured: false,
  running: false,
  handoff: null,
  mode: 'image',
  image: null,
  details: '',
  prompt: '',
  references: [],
  notice: null,
  setForm: (patch) => set(patch),
  setHandoff: (image) => set({ handoff: image }),

  async run(input, model, { imageReady }) {
    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal
    const app = useAppStore.getState()
    set({ running: true, error: null, askTexture: false, textured: false, stage: 'picture', progress: 0, message: 'Preparing your picture…' })

    try {
      // 1 ── Picture
      let picture: Blob
      let pictureUrl: string | null = null
      const needsImageModel = input.mode === 'text' || (input.mode === 'image' && input.details.trim().length > 0)
      if (needsImageModel && imageReady) {
        const job = await imagesApi.run(
          input.mode === 'text'
            ? { prompt: input.prompt.trim(), references: input.references, purpose: '3d', priority: app.generationPriority }
            : { prompt: input.details.trim(), references: [input.image!], purpose: '3d', strength: 0.45, priority: app.generationPriority },
          (j) => set({ progress: Math.round(j.progress * 0.3), message: j.step || 'Drawing your picture…' }),
          signal,
        )
        pictureUrl = job.url
        picture = await fetchBlob(job.url!)
      } else if (input.mode === 'image' && input.image) {
        picture = dataUrlToBlob(input.image)
        pictureUrl = input.image
      } else {
        throw new Error('Set up the image generator to create models from text')
      }
      set({ pictureUrl })

      // 2 ── 3D model
      set({ stage: 'model', progress: 30, message: `Building the 3D model with ${model.name}…` })
      const { job_id } = await modelsApi.generateFromImage(picture, model.id, { priority: app.generationPriority, filename: 'picture.png' })
      activeJob = job_id
      app.clearMeshHistory()
      app.setCurrentJob({ id: job_id, imageFile: '', status: 'generating', progress: 0, step: 'Queued…', createdAt: Date.now(), modelId: model.id })
      let outputUrl: string | null = null
      while (!outputUrl) {
        await new Promise((r) => setTimeout(r, 1000))
        if (signal.aborted) {
          await modelsApi.cancel(job_id).catch(() => {})
          throw new Error('Cancelled')
        }
        const s = await modelsApi.status(job_id)
        const step = s.status === 'pending' && s.queue_position ? `Waiting in queue (position ${s.queue_position})` : brandText(s.step) || 'Building…'
        useAppStore.getState().updateCurrentJob({ progress: s.progress, step })
        set({ progress: 30 + Math.round(s.progress * 0.6), message: step })
        if (s.status === 'done' && s.output_url) outputUrl = s.output_url
        if (s.status === 'error') throw new Error(brandText(s.error?.split('\n').filter(Boolean).slice(-1)[0]) || 'The 3D model failed')
        if (s.status === 'cancelled') throw new Error('Cancelled')
      }
      activeJob = null
      useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl, originalOutputUrl: outputUrl })
      useAppStore.getState().pushMeshUrl(outputUrl, 'Generated')

      // 3 ── Texture
      const mode = useAppStore.getState().textureMode
      if (mode === 'yes') {
        await get().texture()
      } else {
        set({ stage: 'done', progress: 100, message: 'Your model is ready', askTexture: mode === 'ask' })
      }
      void showCompletionNotification('Your 3D model is ready')
    } catch (e) {
      const cancelled = signal.aborted || (e instanceof Error && e.message === 'Cancelled')
      const message = cancelled ? 'Cancelled' : errorMessage(e)
      set({ stage: cancelled ? 'idle' : 'error', error: cancelled ? null : message, message })
      if (!cancelled) {
        useAppStore.getState().updateCurrentJob({ status: 'error', error: message })
        void showErrorNotification(message, 'Generation failed')
      } else {
        useAppStore.getState().setCurrentJob(null)
      }
    } finally {
      activeJob = null
      set({ running: false })
    }
  },

  cancel() {
    abort?.abort()
    if (activeJob) void modelsApi.cancel(activeJob).catch(() => {})
  },

  async texture() {
    const url = useAppStore.getState().currentJob?.outputUrl
    const path = meshPathFromUrl(url)
    if (!path) return
    set({ stage: 'texture', progress: 92, message: 'Painting your model…', askTexture: false, running: true, error: null })
    try {
      const backImage = await drawBackView(get().pictureUrl, (message) => set({ message }))
      set({ message: 'Painting your model…' })
      const result = await textureApi.project(path, { backImage: backImage ?? undefined })
      applyMeshResult(result.url, 'Textured')
      set({ stage: 'done', progress: 100, message: 'Your model is ready', textured: true })
    } catch (e) {
      set({ stage: 'error', error: `Texturing failed: ${errorMessage(e)}` })
    } finally {
      set({ running: false })
    }
  },

  dismissTexture() {
    set({ askTexture: false })
  },

  reset() {
    set({ stage: 'idle', progress: 0, message: '', error: null, pictureUrl: null, askTexture: false, textured: false })
  },
}))
