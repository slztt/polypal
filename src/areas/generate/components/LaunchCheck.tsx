// Pre-launch VRAM estimate for the model nodes of a workflow, plus the job
// priority used when it is queued. Shown above the Generate button.
import { useEffect, useMemo, useState } from 'react'
import { gpuApi, type FitVerdict, type JobPriority, type LaunchPlan } from '@shared/api/polypalApi'
import { useAppStore } from '@shared/stores/appStore'
import type { WFNode } from '@shared/types/electron.d'
import type { WorkflowExtension } from '@areas/workflows/mockExtensions'
import { getWorkflowExtension } from '@areas/workflows/mockExtensions'

const VERDICT_RANK: Record<FitVerdict, number> = { fits: 0, unknown: 1, fits_after_unload: 2, tight: 3, exceeds: 4 }

const VERDICT_STYLE: Record<FitVerdict, { label: string; cls: string }> = {
  fits:              { label: 'Fits in VRAM',       cls: 'border-accent/30 bg-accent/10 text-accent-light' },
  fits_after_unload: { label: 'Fits after unload',  cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  tight:             { label: 'Tight on VRAM',      cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  exceeds:           { label: "Won't fit in VRAM",  cls: 'border-red-500/30 bg-red-500/10 text-red-300' },
  unknown:           { label: 'VRAM unknown',       cls: 'border-zinc-700 bg-zinc-800 text-zinc-400' },
}

/** The worst plan across a workflow's enabled model nodes. */
export function worstPlan(plans: LaunchPlan[]): LaunchPlan | null {
  return plans.reduce<LaunchPlan | null>(
    (worst, plan) => (!worst || VERDICT_RANK[plan.verdict] > VERDICT_RANK[worst.verdict] ? plan : worst),
    null,
  )
}

export default function LaunchCheck({ nodes, allExtensions, disabled }: {
  nodes: WFNode[]
  allExtensions: WorkflowExtension[]
  disabled?: boolean
}): JSX.Element | null {
  const priority = useAppStore((s) => s.generationPriority)
  const setPriority = useAppStore((s) => s.setGenerationPriority)
  const policy = useAppStore((s) => s.gpuPolicy)
  const [plans, setPlans] = useState<LaunchPlan[]>([])

  const models = useMemo(() => nodes
    .filter((n) => n.type === 'extensionNode' && n.data.enabled !== false)
    .map((n) => ({ node: n, ext: getWorkflowExtension(n.data.extensionId ?? '', allExtensions) }))
    .filter(({ ext }) => ext?.type === 'model')
    .map(({ node, ext }) => ({
      modelId: ext!.id,
      params: { ...Object.fromEntries(ext!.params.map((p) => [p.id, p.default])), ...(node.data.params ?? {}) },
    })), [nodes, allExtensions])

  const key = JSON.stringify(models)
  useEffect(() => {
    if (models.length === 0) { setPlans([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      Promise.all(models.map((m) => gpuApi.estimate(m.modelId, m.params).catch(() => null)))
        .then((results) => { if (!cancelled) setPlans(results.filter((r): r is LaunchPlan => r !== null)) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialised model list
  }, [key])

  if (models.length === 0) return null
  const plan = worstPlan(plans)
  const style = plan ? VERDICT_STYLE[plan.verdict] : null
  const autoUnloadNote = plan?.verdict === 'fits_after_unload'
    ? (policy.unload_before_launch === 'auto' ? ' PolyPal will unload them automatically.' : ' Automatic unloading is off.')
    : ''

  return (
    <div className="flex items-center gap-2">
      {plan && style && (
        <span
          className={`flex-1 min-w-0 truncate px-2 py-1 rounded-md border text-[10px] ${style.cls}`}
          title={plan.message + autoUnloadNote}
        >
          {style.label}
          {plan.estimate_mb ? ` · ~${(plan.estimate_mb / 1024).toFixed(1)} GB` : ''}
        </span>
      )}
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as JobPriority)}
        disabled={disabled}
        aria-label="Job priority"
        title="Queue priority for this generation"
        className="ml-auto bg-zinc-800 border border-zinc-700 rounded-md px-1.5 py-1 text-[10px] text-zinc-300 focus:outline-none focus:border-accent"
      >
        <option value="high">High priority</option>
        <option value="normal">Normal priority</option>
        <option value="low">Low priority</option>
      </select>
    </div>
  )
}
