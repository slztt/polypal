import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { ReferencePicker } from '@shared/components/ui/ImagePicker'
import { errorMessage, imagesApi, type GalleryImage, type ImageJob } from '@shared/api/polypalApi'
import { useCreateStore } from '@areas/create/createStore'
import { usePageActive } from '@shared/hooks/usePageActive'
import { ImageEngineSetup } from './ImageEngineSetup'
import { imageEngineReady, useImageEngine } from './useImageEngine'

const SIZES = [
  { id: 'square', label: 'Square', width: 1024, height: 1024 },
  { id: 'wide', label: 'Wide', width: 1216, height: 832 },
  { id: 'tall', label: 'Tall', width: 832, height: 1216 },
] as const

const IDEAS = ['a cosy cabin in a snowy forest at dusk', 'a robot barista, studio photo', 'a watercolour fox in autumn leaves', 'a neon city street in the rain']

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export default function ImagesPage(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const priority = useAppStore((s) => s.generationPriority)
  const navigate = useNavStore((s) => s.navigate)
  const setHandoff = useCreateStore((s) => s.setHandoff)
  const engine = useImageEngine()
  const refreshEngine = engine.refresh
  useEffect(() => { void refreshEngine() }, [refreshEngine])
  const ready = imageEngineReady(engine.status)
  const downloadedModels = engine.status?.models.filter((m) => m.downloaded) ?? []

  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [modelId, setModelId] = useState<string | null>(null)
  const [size, setSize] = useState<(typeof SIZES)[number]['id']>('square')
  const [job, setJob] = useState<ImageJob | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gallery, setGallery] = useState<GalleryImage[]>([])
  const [selected, setSelected] = useState<GalleryImage | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const model = downloadedModels.find((m) => m.id === modelId) ?? downloadedModels.find((m) => m.id === engine.status?.default_model) ?? downloadedModels[0]
  const maxRefs = model?.references === 'multi' ? (engine.status?.max_references ?? 5) : 1

  const loadGallery = useCallback(async () => {
    try { setGallery(await imagesApi.gallery()) } catch { /* backend not up yet */ }
  }, [])
  useEffect(() => { void loadGallery() }, [loadGallery])
  usePageActive('images', () => { void loadGallery(); void refreshEngine() })

  const generate = useCallback(async () => {
    if (!prompt.trim() || !model) return
    abortRef.current = new AbortController()
    setRunning(true)
    setError(null)
    setJob(null)
    const dims = SIZES.find((s) => s.id === size)!
    try {
      const done = await imagesApi.run(
        { prompt: prompt.trim(), references: references.slice(0, maxRefs), model_id: model.id, width: dims.width, height: dims.height, purpose: 'image', priority },
        setJob,
        abortRef.current.signal,
      )
      setJob(done)
      await loadGallery()
      setSelected({ url: done.url!, path: done.path ?? '', prompt: done.prompt, model_id: model.id })
    } catch (e) {
      const message = errorMessage(e)
      if (message !== 'Cancelled') setError(message)
    } finally {
      setRunning(false)
    }
  }, [prompt, model, size, references, maxRefs, priority, loadGallery])

  const makeModel = useCallback(async (image: GalleryImage) => {
    try {
      const res = await fetch(`${apiUrl}${image.url}`)
      setHandoff(await blobToDataUrl(await res.blob()))
      navigate('create')
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [apiUrl, setHandoff, navigate])

  const remove = useCallback(async (image: GalleryImage) => {
    await imagesApi.deleteImage(image.path).catch((e) => setError(errorMessage(e)))
    if (selected?.path === image.path) setSelected(null)
    await loadGallery()
  }, [selected, loadGallery])

  const shown = selected ?? gallery[0] ?? null

  return (
    <div className="flex flex-1 gap-4 overflow-hidden p-4">
      <section className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto pr-1" aria-label="Generate an image">
        <header>
          <h1 className="pp-title">Image Generator</h1>
          <p className="pp-subtitle mt-1">Describe a picture and PolyPal draws it — on your computer, no internet needed.</p>
        </header>

        {!engine.status ? (
          <p className="text-sm text-zinc-500">{engine.error ?? 'Checking the image generator…'}</p>
        ) : !ready ? (
          <ImageEngineSetup compact />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="image-prompt" className="pp-label">What should it look like?</label>
              <textarea id="image-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} required
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !running) void generate() }}
                className="pp-input resize-none" placeholder="A cosy cabin in a snowy forest at dusk" />
              {!prompt && (
                <div className="flex flex-wrap gap-1.5">
                  {IDEAS.map((idea) => (
                    <button key={idea} type="button" className="pp-chip hover:border-accent/40 hover:text-white" onClick={() => setPrompt(idea)}>{idea}</button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="pp-label">Reference pictures <span className="text-zinc-600">(optional, up to 5)</span></span>
              <ReferencePicker values={references} onChange={setReferences} onError={setError} />
              {references.length > maxRefs && (
                <p className="text-[11px] text-amber-300">
                  {model?.name} uses only the first reference. Download a multi-reference model in Settings → AI models to use them all.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="image-model" className="pp-label">Model</label>
                <select id="image-model" className="pp-input" value={model?.id ?? ''} onChange={(e) => setModelId(e.target.value)}>
                  {downloadedModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="image-size" className="pp-label">Shape</label>
                <select id="image-size" className="pp-input" value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
                  {SIZES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {running ? (
              <div className="pp-card flex flex-col gap-3 p-4" aria-live="polite">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-white">{job?.step || 'Starting…'}</p>
                  <span className="text-xs tabular-nums text-zinc-500">{job?.progress ?? 0}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all" style={{ width: `${job?.progress ?? 0}%` }} />
                </div>
                <button type="button" className="pp-btn-ghost" onClick={() => abortRef.current?.abort()}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="pp-btn-primary py-3 text-[15px]" disabled={!prompt.trim()} onClick={() => void generate()}>
                Generate image
              </button>
            )}
          </>
        )}

        {error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      </section>

      <section className="pp-panel flex flex-1 flex-col overflow-hidden" aria-label="Your images">
        <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
          {shown ? (
            <img key={shown.url} src={`${apiUrl}${shown.url}`} alt={shown.prompt} className="max-h-full max-w-full animate-pop rounded-xl object-contain shadow-card" />
          ) : (
            <p className="text-sm text-zinc-500">Your pictures will appear here</p>
          )}
        </div>
        {shown && (
          <div className="flex items-center gap-2 border-t border-white/[0.05] bg-surface-400/80 px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-xs text-zinc-400" title={shown.prompt}>{shown.prompt}</p>
            <button type="button" className="pp-btn-ghost hover:text-red-300" data-sfx="delete" onClick={() => void remove(shown)}>Delete</button>
            <a className="pp-btn-ghost" href={`${apiUrl}${shown.url}`} download>Download</a>
            <button type="button" className="pp-btn-primary" onClick={() => void makeModel(shown)}>Make a 3D model</button>
          </div>
        )}
        {gallery.length > 0 && (
          <div className="flex gap-2 overflow-x-auto border-t border-white/[0.05] p-3" role="list" aria-label="Recent images">
            {gallery.map((img) => (
              <button key={img.path} type="button" role="listitem" onClick={() => setSelected(img)} title={img.prompt}
                className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border transition-all duration-150 hover:-translate-y-0.5 active:scale-95 ${shown?.path === img.path ? 'border-accent ring-2 ring-accent/30' : 'border-white/[0.06] hover:border-white/20'}`}>
                <img src={`${apiUrl}${img.url}`} alt={img.prompt} className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
