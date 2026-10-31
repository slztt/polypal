import { useCallback, useEffect, useState } from 'react'
import Viewer3D from '@areas/generate/components/Viewer3D'
import GenerationHUD from '@areas/generate/components/GenerationHUD'
import ChatPanel from '@areas/generate/components/ChatPanel'
import { meshPathFromUrl } from '@areas/generate/meshPath'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { ImageDropZone, ReferencePicker, Segmented } from '@shared/components/ui/ImagePicker'
import { SaveToLibraryDialog } from '@shared/components/ui/SaveToLibraryDialog'
import { imageEngineReady, useImageEngine } from '@areas/images/useImageEngine'
import { ImageEngineSetup } from '@areas/images/ImageEngineSetup'
import { useCreateStore, type CreateMode } from './createStore'
import { RECOMMENDED_3D, useModelSetup } from './useModelSetup'
import { RecentModels } from './RecentModels'
import { meshesApi, errorMessage } from '@shared/api/polypalApi'
import { playSfx } from '@shared/utils/sfx'

const TEXTURE_OPTIONS = [
  { value: 'ask' as const, label: 'Ask me', hint: 'Ask after each model whether to add colour' },
  { value: 'yes' as const, label: 'Yes', hint: 'Always colour new models from the picture' },
  { value: 'no' as const, label: 'No', hint: 'Keep models plain' },
]

const PROMPT_IDEAS = ['a cute ceramic frog figurine', 'a low-poly treasure chest', 'a vintage brass desk lamp', 'a cartoon rocket ship']

function ModelSetupCard(): JSX.Element {
  const setup = useModelSetup()
  const notDownloaded = setup.models.find((m) => !m.downloaded)
  return (
    <div className="pp-card flex flex-col gap-3 p-4">
      <div>
        <p className="text-sm font-medium text-white">Get a 3D model first</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
          {notDownloaded
            ? `${notDownloaded.name} is installed but its files aren't downloaded yet.`
            : `PolyPal needs an AI model to build 3D shapes. We recommend ${RECOMMENDED_3D.name} (${RECOMMENDED_3D.sizeNote}).`}
        </p>
      </div>
      <button
        type="button"
        className="pp-btn-primary"
        disabled={setup.installing}
        onClick={() => void (notDownloaded ? setup.download(notDownloaded.id) : setup.installRecommended())}
      >
        {setup.installing ? 'Setting up…' : notDownloaded ? `Download ${notDownloaded.name}` : `Install ${RECOMMENDED_3D.name}`}
      </button>
      {setup.progress !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${setup.progress}%` }} />
        </div>
      )}
      {setup.status && <p className="text-[11px] text-zinc-500">{setup.status}</p>}
      {setup.error && <p role="alert" className="text-xs text-red-400">{setup.error}</p>}
    </div>
  )
}

function StageList({ mode, hasDetails }: { mode: CreateMode; hasDetails: boolean }): JSX.Element {
  const { stage, progress, message } = useCreateStore()
  const steps: { id: string; label: string }[] = [
    ...(mode === 'text' ? [{ id: 'picture', label: 'Draw a picture' }] : hasDetails ? [{ id: 'picture', label: 'Apply your details' }] : []),
    { id: 'model', label: 'Build the 3D model' },
    { id: 'texture', label: 'Add colour' },
  ]
  const order = ['picture', 'model', 'texture', 'done']
  const current = order.indexOf(stage)
  return (
    <div className="pp-card flex flex-col gap-3 p-4" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-white">{message || 'Working…'}</p>
        <span className="text-xs tabular-nums text-zinc-500">{progress}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-700" style={{ width: `${progress}%` }} />
      </div>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s) => {
          const index = order.indexOf(s.id)
          const done = current > index
          const active = current === index
          return (
            <li key={s.id} className={`flex items-center gap-2 text-xs ${done ? 'text-zinc-300' : active ? 'text-white' : 'text-zinc-600'}`}>
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${done ? 'bg-accent text-white' : active ? 'border border-accent text-accent-light' : 'border border-zinc-700'}`}>
                {done ? '✓' : ''}
              </span>
              {s.label}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ExportMenu({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const path = meshPathFromUrl(url) ?? ''
  const download = (format: 'glb' | 'obj' | 'stl') => {
    const link = document.createElement('a')
    link.href = format === 'glb' ? `${apiUrl}${url}` : `${apiUrl}/optimize/export?path=${encodeURIComponent(path)}&format=${format}&units=${format === 'stl' ? 'mm' : 'm'}`
    link.download = `polypal-model.${format}`
    link.click()
    onClose()
  }
  return (
    <div className="absolute bottom-full right-0 mb-2 w-56 origin-bottom-right animate-pop rounded-xl border border-white/[0.08] bg-surface-300 p-1.5 shadow-card">
      {([
        ['glb', 'GLB', 'Keeps colour · games, web, Blender'],
        ['obj', 'OBJ', 'Widely supported'],
        ['stl', 'STL', '3D printing (no colour)'],
      ] as const).map(([fmt, label, hint]) => (
        <button key={fmt} type="button" onClick={() => download(fmt)} className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]">
          <span className="text-sm text-white">{label}</span>
          <span className="text-[11px] text-zinc-500">{hint}</span>
        </button>
      ))}
    </div>
  )
}

export default function CreatePage(): JSX.Element {
  // The form lives in the store so it survives switching tabs.
  const { mode, image, details, prompt, references, notice, setForm } = useCreateStore()
  const setMode = (v: CreateMode) => setForm({ mode: v })
  const setImage = (v: string | null) => setForm({ image: v })
  const setDetails = (v: string) => setForm({ details: v })
  const setPrompt = (v: string) => setForm({ prompt: v })
  const setReferences = (v: string[]) => setForm({ references: v })
  const setNotice = useCallback((v: string | null) => setForm({ notice: v }), [setForm])
  const [saving, setSaving] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const textureMode = useAppStore((s) => s.textureMode)
  const setTextureMode = useAppStore((s) => s.setTextureMode)
  const currentJob = useAppStore((s) => s.currentJob)
  const showToast = useAppStore((s) => s.showToast)
  const setUiMode = useAppStore((s) => s.setUiMode)
  const navigate = useNavStore((s) => s.navigate)
  const pipeline = useCreateStore()
  const setup = useModelSetup()
  const engine = useImageEngine()
  const refreshEngine = engine.refresh
  useEffect(() => { void refreshEngine() }, [refreshEngine])
  const imageReady = imageEngineReady(engine.status)

  // A picture sent here from the Image Generator or Library.
  const handoff = pipeline.handoff
  const setHandoff = pipeline.setHandoff
  useEffect(() => {
    if (!handoff) return
    setForm({ mode: 'image', image: handoff })
    setHandoff(null)
  }, [handoff, setHandoff, setForm])

  const modelUrl = currentJob?.status === 'done' ? currentJob.outputUrl ?? null : null
  const meshHistory = useAppStore((s) => s.meshHistory)

  // Delete the model on screen and every version of it (edits, textured copy).
  const deleteCurrent = useCallback(async () => {
    setConfirmDelete(false)
    const urls = [...new Set([...meshHistory, modelUrl].filter((u): u is string =>
      !!u && u.startsWith('/workspace/') && !u.startsWith('/workspace/Library/')))]
    if (!urls.length) {
      setForm({ notice: 'This model lives in your Library — delete it from the Library tab.' })
      return
    }
    try {
      await meshesApi.remove(urls)
      playSfx('delete')
      useAppStore.getState().clearMeshHistory()
      useAppStore.getState().setCurrentJob(null)
      pipeline.reset()
      showToast('Model deleted')
    } catch (e) {
      setForm({ notice: `Could not delete: ${errorMessage(e)}` })
    }
  }, [meshHistory, modelUrl, pipeline, showToast, setForm])
  const canGenerate = !!setup.ready && !pipeline.running && (mode === 'image' ? !!image : prompt.trim().length > 0 && imageReady)

  const generate = useCallback(() => {
    if (!setup.ready) return
    setNotice(mode === 'image' && details.trim() && !imageReady
      ? 'Your extra details need the image generator, so the picture was used as-is. Set it up in Settings → AI models.'
      : null)
    void pipeline.run({ mode, image, details, prompt, references }, setup.ready, { imageReady })
  }, [setup.ready, mode, image, details, prompt, references, imageReady, pipeline, setNotice])

  return (
    <div className="flex flex-1 gap-4 overflow-hidden p-4">
      {/* ── Controls ── */}
      <section className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto pr-1" aria-label="Create a 3D model">
        <header>
          <h1 className="pp-title">3D Generate</h1>
          <p className="pp-subtitle mt-1">Turn a picture or a description into a 3D model.</p>
        </header>

        <Segmented<CreateMode>
          ariaLabel="Create from"
          value={mode}
          onChange={setMode}
          options={[{ value: 'image', label: 'Image to model' }, { value: 'text', label: 'Text to model' }]}
        />

        {mode === 'image' ? (
          <>
            <ImageDropZone value={image} onChange={setImage} onError={setNotice} className="aspect-square w-full" />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="details" className="pp-label">Extra details <span className="text-zinc-600">(optional)</span></label>
              <textarea id="details" value={details} onChange={(e) => setDetails(e.target.value)} rows={2}
                className="pp-input resize-none" placeholder="e.g. make it red, add a hat" />
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="prompt" className="pp-label">Describe your model</label>
              <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canGenerate) generate() }}
                className="pp-input resize-none" placeholder="A small wooden treasure chest with gold trim" />
              {!prompt && (
                <div className="flex flex-wrap gap-1.5">
                  {PROMPT_IDEAS.map((idea) => (
                    <button key={idea} type="button" className="pp-chip hover:border-accent/40 hover:text-white" onClick={() => setPrompt(idea)}>{idea}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="pp-label">Reference pictures <span className="text-zinc-600">(optional, up to 5)</span></span>
              <ReferencePicker values={references} onChange={setReferences} onError={setNotice} />
            </div>
            {!imageReady && <ImageEngineSetup compact />}
          </>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="pp-label">Add colour (texture)</span>
          <Segmented ariaLabel="Texture the model" size="sm" value={textureMode} onChange={setTextureMode} options={TEXTURE_OPTIONS} />
        </div>

        {!setup.loading && !setup.ready ? (
          <ModelSetupCard />
        ) : pipeline.running ? (
          <>
            <StageList mode={mode} hasDetails={!!details.trim() && imageReady} />
            <button type="button" className="pp-btn-ghost" onClick={pipeline.cancel}>Cancel</button>
          </>
        ) : (
          <button type="button" className="pp-btn-primary py-3 text-[15px]" disabled={!canGenerate} onClick={generate}>
            Generate 3D model
          </button>
        )}

        {pipeline.error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{pipeline.error}</p>}
        {notice && <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">{notice}</p>}
        {setup.ready && <p className="text-[11px] text-zinc-600">Using {setup.ready.name}. Change models in Settings → AI models.</p>}
      </section>

      {/* ── Viewer ── */}
      <section className="pp-panel relative flex flex-1 flex-col overflow-hidden" aria-label="3D preview">
        <div className="relative flex-1">
          <Viewer3D />
          <GenerationHUD />
          {!modelUrl && !pipeline.running && (
            <div className="pointer-events-none absolute inset-x-0 bottom-10 text-center text-sm text-zinc-500">
              Your model will appear here
            </div>
          )}

          {pipeline.pictureUrl && pipeline.stage !== 'idle' && (
            <figure className="absolute right-4 top-4 w-28 overflow-hidden rounded-xl border border-white/[0.08] bg-black/50 shadow-card">
              <img src={pipeline.pictureUrl.startsWith('data:') ? pipeline.pictureUrl : `${useAppStore.getState().apiUrl}${pipeline.pictureUrl}`} alt="Source picture" className="aspect-square w-full object-contain" />
              <figcaption className="px-2 py-1 text-[10px] text-zinc-400">Source picture</figcaption>
            </figure>
          )}

          {pipeline.askTexture && modelUrl && (
            <div role="dialog" aria-label="Add colour to your model" className="pp-card absolute left-1/2 top-6 w-[360px] -translate-x-1/2 p-4 animate-rise-in">
              <p className="text-sm font-medium text-white">Add colour to your model?</p>
              <p className="mt-1 text-xs text-zinc-400">PolyPal paints it from the picture it was made from and removes the photo's own lighting and shine, so it looks right under any light.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" className="pp-btn-primary flex-1" onClick={() => void pipeline.texture()}>Yes, add colour</button>
                <button type="button" className="pp-btn-ghost" onClick={pipeline.dismissTexture}>No thanks</button>
              </div>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 border-t border-white/[0.05] bg-surface-400/80 px-4 py-3">
          <button type="button" className="pp-btn-ghost" onClick={() => setAssistantOpen((v) => !v)} aria-pressed={assistantOpen}>
            Ask the assistant
          </button>
          <button type="button" className="pp-btn-ghost" onClick={() => setModelsOpen((v) => !v)} aria-pressed={modelsOpen} data-sfx={modelsOpen ? 'close' : 'open'}>
            Your models
          </button>
          <div className="ml-auto flex items-center gap-2">
            {modelUrl && !pipeline.textured && !pipeline.running && (
              <button type="button" className="pp-btn-ghost" onClick={() => void pipeline.texture()}>Add colour</button>
            )}
            {modelUrl && (
              <>
                <button type="button" className="pp-btn-ghost" onClick={() => { setUiMode('advanced'); navigate('generate') }}>Edit in Studio</button>
                <div className="relative">
                  <button type="button" className="pp-btn-ghost" onClick={() => setExportOpen((v) => !v)} aria-expanded={exportOpen}>Export</button>
                  {exportOpen && <ExportMenu url={modelUrl} onClose={() => setExportOpen(false)} />}
                </div>
                {confirmDelete ? (
                  <span className="flex animate-pop items-center gap-1.5">
                    <button type="button" className="pp-btn-danger" data-sfx="none" onClick={() => void deleteCurrent()}>Delete model</button>
                    <button type="button" className="pp-btn-ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
                  </span>
                ) : (
                  <button type="button" className="pp-btn-ghost hover:text-red-300" aria-label="Delete this model" title="Delete this model and its versions" onClick={() => setConfirmDelete(true)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
                  </button>
                )}
                <button type="button" className="pp-btn-primary" onClick={() => setSaving(true)}>Save to Library</button>
              </>
            )}
          </div>
        </div>

        <RecentModels open={modelsOpen} onClose={() => setModelsOpen(false)} refreshKey={modelUrl} />

        {assistantOpen && (
          <div className="absolute bottom-[64px] left-4 top-4 flex w-[340px] animate-rise-in flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-surface-400 shadow-card">
            <div className="flex items-center justify-between border-b border-white/[0.05] px-3 py-2">
              <span className="text-sm font-medium text-white">Assistant</span>
              <button type="button" aria-label="Close assistant" className="text-zinc-500 hover:text-white" onClick={() => setAssistantOpen(false)}>✕</button>
            </div>
            <ChatPanel />
          </div>
        )}
      </section>

      {saving && modelUrl && (
        <SaveToLibraryDialog
          source={modelUrl}
          defaultName={(mode === 'text' ? prompt : details).trim().slice(0, 60)}
          onClose={() => setSaving(false)}
          onSaved={(item) => showToast(`Saved “${item.name}” to your library`)}
        />
      )}
    </div>
  )
}
