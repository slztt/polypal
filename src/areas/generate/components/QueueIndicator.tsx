// Header button showing the generation queue and GPU memory, with a popover to
// reprioritise or cancel waiting jobs and release idle VRAM.
import { useEffect, useRef, useState } from 'react'
import {
  errorMessage, generationApi, gpuApi,
  type GpuStatus, type JobPriority, type QueueSnapshot,
} from '@shared/api/polypalApi'
import { useAppStore } from '@shared/stores/appStore'

const PRIORITIES: JobPriority[] = ['high', 'normal', 'low']

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`
}

export default function QueueIndicator(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const [gpu, setGpu] = useState<GpuStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const showToast = useAppStore((s) => s.showToast)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const [q, g] = await Promise.all([generationApi.queue(), open ? gpuApi.status() : Promise.resolve(null)])
        if (cancelled) return
        setQueue(q)
        if (g) setGpu(g)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
      }
    }
    void tick()
    const id = setInterval(tick, open ? 1500 : 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const waiting = queue?.queued.length ?? 0
  const running = !!queue?.running

  async function setPriority(jobId: string, priority: JobPriority) {
    try {
      await generationApi.setPriority(jobId, priority)
      setQueue(await generationApi.queue())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function cancel(jobId: string) {
    try {
      await generationApi.cancel(jobId)
      setQueue(await generationApi.queue())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function unloadIdle() {
    try {
      const { released } = await gpuApi.unloadIdle()
      showToast(released.length ? `Unloaded ${released.join(', ')}` : 'No idle models to unload')
      setGpu(await gpuApi.status())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const card = gpu?.gpus[0]
  const usedPct = card ? Math.round((card.used_mb / card.total_mb) * 100) : 0

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Generation queue & GPU"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
          open ? 'bg-zinc-700 border-zinc-600 text-zinc-200' : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-accent animate-pulse' : 'bg-zinc-600'}`} />
        {waiting > 0 ? `Queue · ${waiting}` : 'GPU'}
      </button>

      {open && (
        <div role="dialog" aria-label="Generation queue and GPU"
          className="absolute top-full right-0 mt-1 z-50 w-[300px] bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 shadow-xl">
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">GPU memory</p>
            {card ? (
              <>
                <div className="flex justify-between text-[11px]">
                  <span className="text-zinc-300 truncate">{card.name}</span>
                  <span className="text-zinc-400 font-mono">{gb(card.used_mb)} / {gb(card.total_mb)}</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full ${usedPct > 90 ? 'bg-red-500' : usedPct > 75 ? 'bg-amber-500' : 'bg-accent'}`} style={{ width: `${usedPct}%` }} />
                </div>
              </>
            ) : (
              <p className="text-[11px] text-zinc-500">{gpu ? 'VRAM can’t be measured on this GPU.' : 'Loading…'}</p>
            )}
            {gpu && gpu.resident.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {gpu.resident.map((r) => (
                  <li key={`${r.kind}-${r.id}`} className="flex justify-between text-[10px]">
                    <span className="text-zinc-400 truncate">{r.id} <span className="text-zinc-600">({r.kind === 'llm' ? 'LLM' : '3D'})</span></span>
                    <span className="text-zinc-500 font-mono">
                      {r.mb ? `~${gb(r.mb)}` : ''}{r.idle_seconds != null ? ` · idle ${Math.round(r.idle_seconds / 60)}m` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={() => void unloadIdle()}
              className="self-start text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors">
              Unload idle models now
            </button>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-zinc-800 pt-2.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Queue</p>
            {queue?.running ? (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
                <span className="text-zinc-300 truncate flex-1">{queue.running_step ?? 'Running'}</span>
                <span className="text-zinc-500 font-mono">{queue.running_progress ?? 0}%</span>
              </div>
            ) : (
              <p className="text-[11px] text-zinc-600">Nothing running.</p>
            )}
            {queue?.queued.map((job) => (
              <div key={job.job_id} className="flex items-center gap-2 text-[11px]">
                <span className="w-4 text-zinc-600 font-mono">{job.position}</span>
                <span className="flex-1 text-zinc-400 truncate font-mono" title={job.job_id}>{job.job_id.slice(0, 8)}</span>
                <select
                  value={job.priority}
                  onChange={(e) => void setPriority(job.job_id, e.target.value as JobPriority)}
                  aria-label="Priority"
                  className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300"
                >
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <button type="button" onClick={() => void cancel(job.job_id)} aria-label="Cancel job"
                  className="text-zinc-600 hover:text-red-400 transition-colors">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          {error && <p className="text-[10px] text-amber-300">{error}</p>}
        </div>
      )}
    </div>
  )
}
