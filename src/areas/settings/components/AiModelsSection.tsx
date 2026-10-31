import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { Section, Card } from '@shared/ui'
import { ImageEngineSetup } from '@areas/images/ImageEngineSetup'
import { RECOMMENDED_3D, useModelSetup } from '@areas/create/useModelSetup'

function ThreeDModels(): JSX.Element {
  const setup = useModelSetup()
  const uiMode = useAppStore((s) => s.uiMode)
  const navigate = useNavStore((s) => s.navigate)
  if (setup.loading) return <p className="text-sm text-zinc-500">Checking installed models…</p>

  return (
    <div className="flex flex-col gap-3">
      {setup.models.length === 0 && (
        <div className="pp-card flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-medium text-white">{RECOMMENDED_3D.name}</p>
            <p className="mt-0.5 text-xs text-zinc-400">Recommended picture-to-3D model · {RECOMMENDED_3D.sizeNote}</p>
          </div>
          <button type="button" className="pp-btn-primary" disabled={setup.installing} onClick={() => void setup.installRecommended()}>
            {setup.installing ? 'Installing…' : 'Install'}
          </button>
        </div>
      )}
      {setup.models.map((model) => (
        <div key={model.id} className="pp-card flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-white">{model.name}</p>
              {setup.ready?.id === model.id && <span className="pp-chip border-accent/30 text-accent-light">In use</span>}
            </div>
            <p className="mt-0.5 truncate text-xs text-zinc-400">{model.id}</p>
          </div>
          {model.downloaded
            ? <span className="pp-chip">Downloaded</span>
            : <button type="button" className="pp-btn-primary" disabled={setup.installing} onClick={() => void setup.download(model.id)}>Download</button>}
        </div>
      ))}
      {setup.progress !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${setup.progress}%` }} />
        </div>
      )}
      {setup.status && <p className="text-[11px] text-zinc-500">{setup.status}</p>}
      {setup.error && <p role="alert" className="text-xs text-red-400">{setup.error}</p>}
      <p className="text-[11px] text-zinc-500">
        More 3D models are available as extensions
        {uiMode === 'advanced'
          ? <> — <button type="button" className="text-accent-light underline" onClick={() => navigate('models')}>browse extensions</button>.</>
          : ' in Advanced mode.'}
      </p>
    </div>
  )
}

export function AiModelsSection(): JSX.Element {
  return (
    <Section title="AI models" subtitle="Everything runs on your computer. Download what you need once.">
      <div className="flex flex-col gap-4">
        <Card title="3D models" description="Turn pictures into 3D shapes. Text-to-model draws a picture first, then uses this.">
          <div className="p-4"><ThreeDModels /></div>
        </Card>
        <Card title="Image generator" description="Draws pictures from text for the Image Generator and Text to model.">
          <div className="p-4"><ImageEngineSetup /></div>
        </Card>
      </div>
    </Section>
  )
}
