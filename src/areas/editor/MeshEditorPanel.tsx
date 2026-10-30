import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore, providerBaseUrl } from '@shared/stores/agentStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import {
  editApi, errorMessage,
  type EditPlan, type MeshOperation, type MeshStats, type PlanStep, type PlannerProvider,
} from '@shared/api/polypalApi'
import { ParamForm } from '@shared/components/ui/ParamForm'
import {
  LENGTH_UNITS, UNIT_LABELS, formatArea, formatDimensions, formatUnitless, formatVolume, type LengthUnit,
} from '@shared/utils/units'
import {
  buildEditorTools, defaultParams, filterEditorTools, groupEditorTools, type EditorTool,
} from './editorTools'
import {
  absoluteMeshPath, applyMeshResult, urlForFile, useCurrentMesh, useMeshStats, type CurrentMesh,
} from './useMeshEditing'
import ProvenanceSection from './ProvenanceSection'

// ─── Small building blocks ────────────────────────────────────────────────────

function SectionHeader({ title, open, onToggle, aside }: {
  title: string; open: boolean; onToggle: () => void; aside?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
          className={`transition-transform ${open ? '' : '-rotate-90'}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {title}
      </button>
      {aside}
    </div>
  )
}

function Spinner({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function describeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k.replace(/_$/, '').replace(/_/g, ' ')}: ${typeof v === 'number' ? +v.toFixed(4) : String(v)}`)
    .join(' · ')
}

function usePlannerProvider(): { provider: PlannerProvider; label: string } {
  const { provider, localModel, external } = useAgentStore()
  return useMemo(() => {
    if (provider === 'local') return { provider: { type: 'local', model: localModel }, label: localModel }
    const cfg = external[provider]
    return {
      provider: { type: 'external', base_url: providerBaseUrl(provider, cfg), api_key: cfg?.apiKey ?? '', model: cfg?.model ?? '' },
      label: cfg?.model || provider,
    }
  }, [provider, localModel, external])
}

// ─── Stats + real-world size ──────────────────────────────────────────────────

function StatsCard({ stats, loading, error, units }: {
  stats: MeshStats | null; loading: boolean; error: string | null; units: LengthUnit
}): JSX.Element {
  if (loading && !stats) return <p className="text-[11px] text-zinc-500 flex items-center gap-2"><Spinner /> Measuring…</p>
  if (error) return <p className="text-[11px] text-amber-300">{error}</p>
  if (!stats) return <p className="text-[11px] text-zinc-600">No statistics.</p>
  const real = stats.units === 'm'
  const rows: [string, React.ReactNode][] = [
    ['Triangles', stats.faces.toLocaleString()],
    ['Size (W×H×D)', real ? formatDimensions(stats.extents, units) : <span title="No real-world size set — values are in arbitrary model units">{formatUnitless(stats.extents)}</span>],
    ['Pieces', stats.components.toLocaleString()],
    ['Surface', real ? formatArea(stats.surface_area, units) : '—'],
    ['Volume', real && stats.volume !== null ? formatVolume(stats.volume, units) : '—'],
  ]
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-zinc-500">{k}</span>
            <span className="text-zinc-200 font-mono text-right truncate">{v}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={stats.watertight ? 'good' : 'warn'}>
          {stats.watertight ? 'Watertight' : `${stats.boundary_edges.toLocaleString()} open edges`}
        </Badge>
        {stats.components > 1 && <Badge tone="warn">{stats.components} pieces</Badge>}
        {stats.non_manifold_edges > 0 && <Badge tone="warn">{stats.non_manifold_edges} non-manifold</Badge>}
        <Badge tone={real ? 'good' : 'muted'}>{real ? 'Real-world size' : 'No size set'}</Badge>
      </div>
    </div>
  )
}

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'muted'; children: React.ReactNode }): JSX.Element {
  const cls = {
    good:  'border-accent/30 bg-accent/10 text-accent-light',
    warn:  'border-amber-500/30 bg-amber-500/10 text-amber-300',
    muted: 'border-zinc-700 bg-zinc-800 text-zinc-400',
  }[tone]
  return <span className={`px-1.5 py-0.5 rounded-md border text-[10px] ${cls}`}>{children}</span>
}

function RealWorldSizeForm({ stats, busy, onApply }: {
  stats: MeshStats | null; busy: boolean; onApply: (step: PlanStep) => void
}): JSX.Element {
  const units = useAppStore((s) => s.units)
  const [dimension, setDimension] = useState<'height' | 'width' | 'depth' | 'longest'>('height')
  const [unit, setUnit] = useState<LengthUnit>(units)
  const [size, setSize] = useState('10')
  useEffect(() => setUnit(units), [units])

  const value = Number(size.replace(',', '.'))
  const valid = Number.isFinite(value) && value > 0
  const ratio = stats && stats.extents.every((e) => e > 0) ? stats.extents : null
  const preview = valid && ratio
    ? (() => {
        const index = dimension === 'width' ? 0 : dimension === 'height' ? 1 : dimension === 'depth' ? 2 : ratio.indexOf(Math.max(...ratio))
        const factor = value / ratio[index]
        return ratio.map((e) => +(e * factor).toPrecision(3)).join(' × ') + ` ${unit}`
      })()
    : null

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_auto_auto] gap-1.5">
        <select value={dimension} onChange={(e) => setDimension(e.target.value as typeof dimension)} aria-label="Dimension"
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-accent">
          <option value="height">Height</option>
          <option value="width">Width</option>
          <option value="depth">Depth</option>
          <option value="longest">Longest side</option>
        </select>
        <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" aria-label="Size"
          className="w-16 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 text-right font-mono focus:outline-none focus:border-accent" />
        <select value={unit} onChange={(e) => setUnit(e.target.value as LengthUnit)} aria-label="Unit"
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-1.5 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-accent">
          {LENGTH_UNITS.map((u) => <option key={u} value={u} title={UNIT_LABELS[u]}>{u}</option>)}
        </select>
      </div>
      {preview && <p className="text-[10px] text-zinc-500">Result: <span className="text-zinc-300 font-mono">{preview}</span> (proportions kept)</p>}
      <button
        type="button"
        disabled={!valid || busy}
        onClick={() => onApply({ op: 'scale_to_size', label: 'Set real-world size', params: { dimension, size: value, unit } })}
        className="py-1.5 rounded-lg bg-accent hover:bg-accent-dark disabled:opacity-40 text-white text-[11px] font-medium transition-colors"
      >
        Set size
      </button>
    </div>
  )
}

// ─── AI edit ──────────────────────────────────────────────────────────────────

const EXAMPLES = [
  'Remove floaters and fill holes',
  'Reduce to 20k triangles and smooth slightly',
  'Make it 15 cm tall and centre it',
  'Rotate 90° around Y',
]

function AiEditBox({ mesh, busy, setBusy, operations }: {
  mesh: CurrentMesh; busy: boolean; setBusy: (b: boolean) => void; operations: MeshOperation[]
}): JSX.Element {
  const editPlanner = useAppStore((s) => s.editPlanner)
  const setEditPlanner = useAppStore((s) => s.setEditPlanner)
  const { provider, label: providerLabel } = usePlannerProvider()
  const [instruction, setInstruction] = useState('')
  const [plan, setPlan] = useState<EditPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const showToast = useAppStore((s) => s.showToast)

  useEffect(() => { setPlan(null); setError(null) }, [mesh.path])

  async function handlePlan() {
    if (!instruction.trim() || !mesh.path) return
    setPlanning(true)
    setError(null)
    setPlan(null)
    try {
      const result = await editApi.plan(
        instruction.trim(), mesh.path,
        editPlanner === 'ai' ? provider : { type: 'none' },
        editPlanner === 'ai' ? 'auto' : 'rules',
      )
      setPlan(result)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPlanning(false)
    }
  }

  async function handleApply() {
    if (!plan || !mesh.path || plan.steps.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await editApi.apply(mesh.path, plan.steps, instruction.trim(), 'ai-edit')
      if (!result.url) throw new Error('The edited mesh was written outside the workspace')
      applyMeshResult(result.url, `AI edit: ${instruction.trim().slice(0, 40)}`)
      showToast(result.summary)
      setPlan(null)
      setInstruction('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const opById = useMemo(() => new Map(operations.map((o) => [o.id, o])), [operations])

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handlePlan() } }}
        placeholder="Describe an edit in plain English…"
        rows={2}
        disabled={!mesh.editable || busy}
        className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-accent disabled:opacity-50"
      />
      {!plan && !instruction && (
        <div className="flex flex-wrap gap-1">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => setInstruction(ex)} disabled={!mesh.editable}
              className="px-2 py-0.5 rounded-full border border-zinc-700/70 text-[10px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-40">
              {ex}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <select
          value={editPlanner}
          onChange={(e) => setEditPlanner(e.target.value as 'rules' | 'ai')}
          aria-label="Planner"
          title={editPlanner === 'ai' ? `Plans with the copilot model (${providerLabel}); falls back to built-in rules` : 'Instant, offline phrase rules'}
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-[10px] text-zinc-300 focus:outline-none focus:border-accent"
        >
          <option value="rules">Built-in planner (offline)</option>
          <option value="ai">AI planner ({providerLabel})</option>
        </select>
        <button
          type="button"
          onClick={() => void handlePlan()}
          disabled={!instruction.trim() || !mesh.editable || planning || busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-100 text-[11px] font-medium transition-colors"
        >
          {planning && <Spinner />}
          Plan
        </button>
      </div>

      {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}

      {plan && (
        <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/60 overflow-hidden">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between gap-2">
            <p className="text-[11px] text-zinc-200">{plan.summary}</p>
            <span className="shrink-0 text-[9px] uppercase tracking-wider text-zinc-500">
              {plan.source === 'llm' ? 'AI' : plan.source === 'rules' ? 'Rules' : ''}
            </span>
          </div>
          {plan.steps.length > 0 && (
            <ol className="flex flex-col divide-y divide-zinc-800">
              {plan.steps.map((step, i) => {
                const op = opById.get(step.op)
                return (
                  <li key={i} className="px-3 py-2 flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 w-4 h-4 shrink-0 rounded-full bg-accent/15 text-accent-light text-[9px] flex items-center justify-center font-semibold">{i + 1}</span>
                      <button type="button" onClick={() => setExpanded(expanded === i ? null : i)} className="flex-1 min-w-0 text-left">
                        <p className="text-[11px] text-zinc-200">{step.label ?? op?.label ?? step.op}</p>
                        {Object.keys(step.params).length > 0 && (
                          <p className="text-[10px] text-zinc-500 truncate">{describeParams(step.params)}</p>
                        )}
                      </button>
                      <button type="button" aria-label={`Remove step ${i + 1}`}
                        onClick={() => setPlan({ ...plan, steps: plan.steps.filter((_, j) => j !== i) })}
                        className="text-zinc-600 hover:text-red-400 transition-colors">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                    {expanded === i && op && (
                      <div className="pl-6">
                        <ParamForm
                          compact
                          params={op.params_schema}
                          values={{ ...defaultParams(op.params_schema), ...step.params }}
                          onChange={(values) => setPlan({
                            ...plan, steps: plan.steps.map((s, j) => (j === i ? { ...s, params: values } : s)),
                          })}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          {plan.warnings.length > 0 && (
            <ul className="px-3 py-2 border-t border-zinc-800 flex flex-col gap-0.5">
              {plan.warnings.map((w) => <li key={w} className="text-[10px] text-amber-300/90">{w}</li>)}
            </ul>
          )}
          <div className="px-3 py-2 border-t border-zinc-800 flex gap-2">
            <button type="button" onClick={() => setPlan(null)}
              className="flex-1 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] transition-colors">
              Discard
            </button>
            <button type="button" onClick={() => void handleApply()} disabled={busy || plan.steps.length === 0}
              className="flex-1 py-1.5 rounded-lg bg-accent hover:bg-accent-dark disabled:opacity-40 text-white text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5">
              {busy && <Spinner />}
              Apply {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tools ────────────────────────────────────────────────────────────────────

function ToolRow({ tool, open, onToggle, busy, disabled, onRun }: {
  tool: EditorTool; open: boolean; onToggle: () => void; busy: boolean; disabled: boolean
  onRun: (tool: EditorTool, params: Record<string, unknown>) => void
}): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultParams(tool.params))
  return (
    <div className={`rounded-lg border transition-colors ${open ? 'border-zinc-700 bg-zinc-900/60' : 'border-transparent hover:bg-zinc-800/40'}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left">
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] text-zinc-200 truncate">{tool.label}</span>
          {!open && tool.description && <span className="block text-[10px] text-zinc-500 truncate">{tool.description}</span>}
        </span>
        {tool.source === 'plugin' && (
          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] border ${tool.trusted ? 'border-zinc-700 text-zinc-400' : 'border-amber-500/40 text-amber-300'}`}
            title={tool.trusted ? `Plugin by ${tool.author ?? 'unknown'}` : 'Plugin from an unverified source'}>
            Plugin
          </span>
        )}
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-2.5">
          {tool.description && <p className="text-[10px] text-zinc-500 leading-relaxed">{tool.description}</p>}
          <ParamForm compact params={tool.params} values={values} onChange={setValues} disabled={busy} />
          <button
            type="button"
            onClick={() => onRun(tool, values)}
            disabled={busy || disabled}
            className="py-1.5 rounded-lg bg-accent hover:bg-accent-dark disabled:opacity-40 text-white text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            {busy && <Spinner />}
            Apply
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function MeshEditorPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const mesh = useCurrentMesh()
  const units = useAppStore((s) => s.units)
  const showError = useAppStore((s) => s.showError)
  const showToast = useAppStore((s) => s.showToast)
  const meshHistory = useAppStore((s) => s.meshHistory)
  const meshHistoryLabels = useAppStore((s) => s.meshHistoryLabels)
  const historyIndex = useAppStore((s) => s.historyIndex)
  const jumpToHistory = useAppStore((s) => s.jumpToHistory)
  const processExtensions = useExtensionsStore((s) => s.processExtensions)

  const [operations, setOperations] = useState<MeshOperation[]>([])
  const [opsError, setOpsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [openTool, setOpenTool] = useState<string | null>(null)
  const [sections, setSections] = useState({ stats: true, ai: true, size: false, tools: true, history: false, provenance: false })
  const toggle = (key: keyof typeof sections) => setSections((s) => ({ ...s, [key]: !s[key] }))

  const { stats, loading, error, refresh } = useMeshStats(mesh.path, mesh.editable)

  useEffect(() => {
    editApi.operations().then(setOperations).catch((e) => setOpsError(errorMessage(e)))
  }, [])

  const tools = useMemo(() => buildEditorTools(operations, processExtensions), [operations, processExtensions])
  const groups = useMemo(() => groupEditorTools(filterEditorTools(tools, query)), [tools, query])

  async function runSteps(steps: PlanStep[], label: string) {
    if (!mesh.path) return
    setBusy(true)
    try {
      const result = await editApi.apply(mesh.path, steps, undefined, 'editor')
      if (!result.url) throw new Error('The edited mesh was written outside the workspace')
      applyMeshResult(result.url, label)
      showToast(result.summary)
    } catch (e) {
      showError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function runTool(tool: EditorTool, params: Record<string, unknown>) {
    if (tool.source === 'builtin' && tool.opId) {
      await runSteps([{ op: tool.opId, params }], tool.label)
      return
    }
    // Plugin tools run in the extension's own runtime via the process runner.
    setBusy(true)
    try {
      const filePath = await absoluteMeshPath(mesh)
      if (!filePath || !tool.extensionId) throw new Error('No mesh to edit')
      const result = await window.electron.extensions.runProcess(tool.extensionId, { filePath, nodeId: tool.nodeId }, params)
      if (!result.success || !result.result?.filePath) throw new Error(result.error ?? `${tool.label} returned no mesh`)
      const { workspaceDir } = await window.electron.settings.get()
      applyMeshResult(urlForFile(result.result.filePath, workspaceDir), tool.label)
      showToast(`${tool.label} applied`)
    } catch (e) {
      showError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="w-[320px] shrink-0 border-l border-zinc-800 bg-surface-400 flex flex-col min-h-0" aria-label="Mesh editor">
      <div className="h-10 px-3 flex items-center justify-between border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-200">Mesh Editor</span>
          {busy && <span className="text-accent-light"><Spinner /></span>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close mesh editor" className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {!mesh.url ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-[11px] text-zinc-600 text-center leading-relaxed">Generate or import a mesh to start editing.</p>
        </div>
      ) : !mesh.editable ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-[11px] text-zinc-600 text-center leading-relaxed">Gaussian splats can't be edited as meshes.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 px-3 py-3 flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <SectionHeader title="Mesh" open={sections.stats} onToggle={() => toggle('stats')}
              aside={<button type="button" onClick={refresh} className="text-[10px] text-zinc-600 hover:text-zinc-300">Refresh</button>} />
            {sections.stats && <StatsCard stats={stats} loading={loading} error={error} units={units} />}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeader title="AI edit" open={sections.ai} onToggle={() => toggle('ai')} />
            {sections.ai && <AiEditBox mesh={mesh} busy={busy} setBusy={setBusy} operations={operations} />}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeader title="Real-world size" open={sections.size} onToggle={() => toggle('size')} />
            {sections.size && (
              <RealWorldSizeForm stats={stats} busy={busy} onApply={(step) => void runSteps([step], 'Set real-world size')} />
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeader title="Tools" open={sections.tools} onToggle={() => toggle('tools')} />
            {sections.tools && (
              <>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tools"
                  aria-label="Search tools"
                  className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-accent"
                />
                {opsError && <p className="text-[11px] text-amber-300">{opsError}</p>}
                {groups.map((group) => (
                  <div key={group.category} className="flex flex-col gap-0.5">
                    <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-600">{group.label}</p>
                    {group.tools.map((tool) => (
                      <ToolRow
                        key={tool.key}
                        tool={tool}
                        open={openTool === tool.key}
                        onToggle={() => setOpenTool(openTool === tool.key ? null : tool.key)}
                        busy={busy}
                        disabled={!mesh.path}
                        onRun={(t, params) => void runTool(t, params)}
                      />
                    ))}
                  </div>
                ))}
                {groups.length === 0 && !opsError && <p className="text-[11px] text-zinc-600">No tools match.</p>}
              </>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeader title={`Versions (${meshHistory.length})`} open={sections.history} onToggle={() => toggle('history')} />
            {sections.history && (
              <ol className="flex flex-col gap-0.5">
                {meshHistory.map((url, i) => (
                  <li key={`${url}-${i}`}>
                    <button
                      type="button"
                      onClick={() => jumpToHistory(i)}
                      aria-current={i === historyIndex}
                      className={`w-full px-2 py-1 rounded-md text-left text-[11px] flex items-center gap-2 transition-colors ${
                        i === historyIndex ? 'bg-accent/15 text-accent-light' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      <span className="w-4 text-[9px] text-zinc-600 font-mono">{i + 1}</span>
                      <span className="truncate">{meshHistoryLabels[i] ?? 'Version'}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeader title="Provenance" open={sections.provenance} onToggle={() => toggle('provenance')} />
            {sections.provenance && <ProvenanceSection mesh={mesh} />}
          </section>
        </div>
      )}
    </aside>
  )
}
