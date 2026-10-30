import { useEffect, useState } from 'react'
import { Section, Card, Row, Select, Toggle } from '@shared/ui'
import { useAppStore } from '@shared/stores/appStore'
import { errorMessage, gpuApi, type GpuStatus, type JobPriority } from '@shared/api/polypalApi'

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`
}

export function PerformanceSection(): JSX.Element {
  const gpuPolicy = useAppStore((s) => s.gpuPolicy)
  const setGpuPolicy = useAppStore((s) => s.setGpuPolicy)
  const priority = useAppStore((s) => s.generationPriority)
  const setPriority = useAppStore((s) => s.setGenerationPriority)
  const [status, setStatus] = useState<GpuStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = () => gpuApi.status()
      .then((s) => { if (!cancelled) { setStatus(s); setError(null) } })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)) })
    void tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const card = status?.gpus[0]

  return (
    <Section title="Performance" subtitle="GPU memory, automatic unloading and the generation queue.">
      <div className="grid grid-cols-2 gap-4">

        <Card title="GPU" description="Live video memory, refreshed every few seconds.">
          {card ? (
            <>
              <Row label={card.name} description={`${gb(card.free_mb)} free`}>
                <span className="text-xs font-mono text-zinc-400">{gb(card.used_mb)} / {gb(card.total_mb)}</span>
              </Row>
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.round((card.used_mb / card.total_mb) * 100)}%` }} />
              </div>
            </>
          ) : (
            <p className="text-xs text-zinc-500">
              {error ?? (status ? 'VRAM can’t be measured on this GPU (NVIDIA only). Estimates still use each model’s declared needs.' : 'Loading…')}
            </p>
          )}
          {status && status.resident.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {status.resident.map((r) => (
                <li key={`${r.kind}-${r.id}`} className="flex justify-between text-[11px]">
                  <span className="text-zinc-400">{r.id} <span className="text-zinc-600">({r.kind === 'llm' ? 'LLM' : '3D model'})</span></span>
                  <span className="text-zinc-500 font-mono">{r.mb ? `~${gb(r.mb)}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Automatic unloading" description="Free VRAM without thinking about it.">
          <Row label="Make room before a launch" description="If a generation wouldn't fit, unload other 3D models and local LLMs first.">
            <Toggle
              value={gpuPolicy.unload_before_launch === 'auto'}
              onChange={(v) => setGpuPolicy({ unload_before_launch: v ? 'auto' : 'never' })}
            />
          </Row>
          <Row label="Unload idle 3D models" description="Release a generator nobody has used for a while.">
            <Select
              value={String(gpuPolicy.idle_unload_minutes)}
              onChange={(v) => setGpuPolicy({ idle_unload_minutes: Number(v) })}
              options={[
                { value: '5', label: 'After 5 min' },
                { value: '15', label: 'After 15 min' },
                { value: '30', label: 'After 30 min' },
                { value: '60', label: 'After 1 hour' },
                { value: '0', label: 'Never' },
              ]}
            />
          </Row>
        </Card>

        <Card title="Queue" description="Generations run one at a time, highest priority first.">
          <Row label="Default priority" description="Applied to new generations; change waiting jobs from the queue menu.">
            <Select
              value={priority}
              onChange={(v) => setPriority(v as JobPriority)}
              options={[
                { value: 'high', label: 'High' },
                { value: 'normal', label: 'Normal' },
                { value: 'low', label: 'Low' },
              ]}
            />
          </Row>
        </Card>

      </div>
    </Section>
  )
}
