import { useEffect, useState } from 'react'
import { brandText } from '@shared/branding'
import { useAppStore } from '@shared/stores/appStore'
import { editApi, errorMessage, generationApi, type Provenance, type ProvenanceRecord } from '@shared/api/polypalApi'
import { trackGenerationJob, type CurrentMesh } from './useMeshEditing'

function formatParam(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toPrecision(4)
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function GenerationCard({ record }: { record: ProvenanceRecord }): JSX.Element | null {
  const [showAll, setShowAll] = useState(false)
  const g = record.generation
  if (!g) return null
  const params = Object.entries(g.params ?? {})
  const visible = showAll ? params : params.slice(0, 6)
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-zinc-200 font-medium truncate">{brandText(g.model_name)}</p>
        {g.model_version && <span className="text-[9px] text-zinc-500 font-mono">v{g.model_version}</span>}
      </div>
      <p className="text-[10px] text-zinc-500">
        {new Date(record.created_at).toLocaleString()} · {g.duration_s}s
        {g.input?.filename ? ` · ${g.input.filename}` : ''}
      </p>
      {params.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
          {visible.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="text-zinc-300 font-mono truncate text-right">{formatParam(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {params.length > 6 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="self-start text-[10px] text-zinc-500 hover:text-zinc-300">
          {showAll ? 'Show fewer' : `Show all ${params.length} settings`}
        </button>
      )}
      {!g.deterministic && (
        <p className="text-[10px] text-amber-300/90">This model exposes no seed, so a regeneration may differ.</p>
      )}
    </div>
  )
}

export default function ProvenanceSection({ mesh }: { mesh: CurrentMesh }): JSX.Element {
  const [data, setData] = useState<Provenance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const generationPriority = useAppStore((s) => s.generationPriority)
  const showToast = useAppStore((s) => s.showToast)

  useEffect(() => {
    if (!mesh.path || !mesh.workspace) { setData(null); return }
    let cancelled = false
    setError(null)
    editApi.provenance(mesh.path)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)) })
    return () => { cancelled = true }
  }, [mesh.path, mesh.workspace])

  async function regenerate(newSeed: boolean) {
    if (!mesh.path) return
    setStarting(true)
    try {
      const { job_id, seed } = await generationApi.regenerate(mesh.path, { priority: generationPriority, newSeed })
      showToast(newSeed ? `Regenerating with a new seed (${String(seed)})` : 'Regenerating with identical settings')
      void trackGenerationJob(job_id, newSeed ? 'Variation' : 'Regeneration')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }

  async function copySettings() {
    const root = data?.lineage.find((r) => r.kind === 'generation')
    if (!root?.generation) return
    await navigator.clipboard.writeText(JSON.stringify({ model_id: root.generation.model_id, params: root.generation.params }, null, 2))
    showToast('Generation settings copied')
  }

  if (!mesh.workspace) return <p className="text-[11px] text-zinc-600">Imported files have no generation history.</p>
  if (error) return <p className="text-[11px] text-amber-300">{error}</p>
  if (!data) return <p className="text-[11px] text-zinc-600">Loading…</p>
  if (data.lineage.length === 0) {
    return <p className="text-[11px] text-zinc-600">No history recorded for this mesh (created before provenance tracking, or imported).</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1.5 border-l border-zinc-800 pl-2.5">
        {data.lineage.map((record) => (
          <li key={record.output} className="relative">
            <span className={`absolute -left-[14px] top-1.5 w-1.5 h-1.5 rounded-full ${record.kind === 'generation' ? 'bg-accent' : 'bg-zinc-500'}`} />
            {record.kind === 'generation' ? (
              <GenerationCard record={record} />
            ) : (
              <div>
                <p className="text-[11px] text-zinc-300">
                  {(record.edit?.steps ?? []).map((s) => s.label ?? s.op).join(' → ') || 'Edit'}
                </p>
                <p className="text-[10px] text-zinc-600">
                  {record.edit?.source} · {new Date(record.created_at).toLocaleTimeString()}
                  {record.edit?.instruction ? ` · “${record.edit.instruction}”` : ''}
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      {data.regenerable ? (
        <div className="flex gap-1.5">
          <button type="button" onClick={() => void regenerate(false)} disabled={starting}
            title="Re-run the same model with the same input image, settings and seed"
            className="flex-1 py-1.5 rounded-lg bg-accent hover:bg-accent-dark disabled:opacity-40 text-white text-[11px] font-medium transition-colors">
            Regenerate
          </button>
          <button type="button" onClick={() => void regenerate(true)} disabled={starting}
            title="Same settings, new random seed"
            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] transition-colors">
            Variation
          </button>
          <button type="button" onClick={() => void copySettings()} title="Copy model and settings as JSON"
            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] transition-colors">
            Copy
          </button>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600">The original input isn't stored, so this model can't be regenerated.</p>
      )}
    </div>
  )
}
