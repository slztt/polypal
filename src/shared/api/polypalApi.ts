// Typed client for the PolyPal backend routes added in 0.5: mesh editing,
// provenance, GPU management, the generation queue and copilot conversations.
import { useAppStore } from '@shared/stores/appStore'
import { readSseStream } from '@shared/utils/sse'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParamOption { value: string; label: string }

export interface ParamSchema {
  id: string
  label: string
  type: 'int' | 'float' | 'boolean' | 'select' | 'string'
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: ParamOption[]
  tooltip?: string
}

export interface MeshOperation {
  id: string
  label: string
  description: string
  category: string
  params_schema: ParamSchema[]
  destructive: boolean
  undoable: boolean
}

export interface MeshStats {
  vertices: number
  faces: number
  bounds: [number[], number[]] | null
  extents: [number, number, number]
  surface_area: number
  volume: number | null
  watertight: boolean
  components: number
  boundary_edges: number
  non_manifold_edges: number
  degenerate_faces: number
  units: 'm' | null
}

export interface PlanStep { op: string; label?: string; params: Record<string, unknown>; details?: Record<string, unknown> }

export interface EditPlan {
  steps: PlanStep[]
  summary: string
  source: 'rules' | 'llm' | 'none'
  warnings: string[]
}

export interface PlannerProvider {
  type: 'local' | 'external' | 'none'
  base_url?: string
  api_key?: string
  model?: string
}

export interface EditResult {
  path: string
  url?: string
  steps: PlanStep[]
  warnings: string[]
  stats: MeshStats
  summary: string
  duration_s: number
}

export interface GenerationRecord {
  model_id: string
  model_name: string
  model_version: string
  params: Record<string, unknown>
  deterministic: boolean
  input: { kind: string; sha256?: string; filename?: string | null; stored_path?: string | null } | null
  collection: string
  duration_s: number
  priority?: string | null
  regenerated_from?: string | null
}

export interface ProvenanceRecord {
  schema: number
  kind: 'generation' | 'edit'
  created_at: string
  app_version: string
  output: string
  parent: string | null
  units: 'm' | null
  real_world?: { dimension?: string; size?: number; unit?: string } | null
  generation?: GenerationRecord
  edit?: { source: string; instruction?: string | null; steps: PlanStep[] }
}

export interface Provenance {
  record: ProvenanceRecord | null
  lineage: ProvenanceRecord[]
  regenerable: boolean
  deterministic: boolean
  units: 'm' | null
}

export interface GpuInfo { index: number; name: string; vendor: string; total_mb: number; used_mb: number; free_mb: number }

export interface ResidentAllocation { kind: 'generator' | 'llm'; id: string; mb: number; is_target: boolean; busy: boolean; idle_seconds?: number | null }

export interface GpuPolicy { unload_before_launch: 'auto' | 'never'; idle_unload_minutes: number }

export interface GpuStatus { gpus: GpuInfo[]; resident: ResidentAllocation[]; policy: GpuPolicy }

export type FitVerdict = 'fits' | 'fits_after_unload' | 'tight' | 'exceeds' | 'unknown'

export interface LaunchPlan {
  model_id: string
  estimate_mb: number | null
  total_mb: number | null
  free_mb: number | null
  reclaimable_mb: number
  already_loaded: boolean
  verdict: FitVerdict
  unload: ResidentAllocation[]
  message: string
}

export type JobPriority = 'high' | 'normal' | 'low'

export interface QueueSnapshot {
  running: string | null
  running_since: number | null
  running_progress: number | null
  running_step: string | null
  queued: { job_id: string; priority: JobPriority; position: number; enqueued_at: number; step?: string | null }[]
}

export interface ConversationSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
  preview: string
}

export interface StoredConversation { id: string; title: string; messages: unknown[]; updated_at: string }

export interface CopilotAction {
  tool: string
  result: string
  payload?: Record<string, unknown> & { type?: string } | null
  status: 'ok' | 'error' | 'pending' | 'skipped'
  arguments: Record<string, unknown>
  risk: 'read' | 'write' | 'heavy'
  duration_ms: number
  call_id: string
}

export type CopilotEvent =
  | { type: 'start'; trimmed: number }
  | { type: 'round'; index: number }
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call_id: string; tool: string; arguments: Record<string, unknown>; risk: string }
  | { type: 'tool_result'; action: CopilotAction }
  | { type: 'done'; message: string; actions: CopilotAction[]; thinking?: string | null; trimmed?: number; error?: boolean }

export type ToolPolicy = 'auto' | 'confirm_heavy' | 'confirm_all'

// ─── HTTP plumbing ────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function base(): string {
  return useAppStore.getState().apiUrl
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

// ─── Mesh editing ─────────────────────────────────────────────────────────────

export const editApi = {
  operations: () => request<MeshOperation[]>('/edit/ops'),
  stats: (path: string) => request<MeshStats>(`/edit/stats?${q({ path })}`),
  plan: (instruction: string, path: string | null, provider: PlannerProvider, mode: 'auto' | 'rules' | 'llm' = 'auto') =>
    request<EditPlan>('/edit/plan', json({ instruction, path, provider, mode })),
  apply: (path: string, steps: PlanStep[], instruction?: string, source = 'editor') =>
    request<EditResult>('/edit/apply', json({
      path, instruction, source,
      steps: steps.map((s) => ({ op: s.op, params: s.params })),
    })),
  provenance: (path: string) => request<Provenance>(`/edit/provenance?${q({ path })}`),
}

// ─── Generation ───────────────────────────────────────────────────────────────

export const generationApi = {
  regenerate: (path: string, opts: { priority?: JobPriority; newSeed?: boolean } = {}) =>
    request<{ job_id: string; priority: JobPriority; seed: unknown }>('/generate/regenerate', json({
      path, priority: opts.priority ?? 'normal', new_seed: opts.newSeed ?? false,
    })),
  queue: () => request<QueueSnapshot>('/generate/queue'),
  setPriority: (jobId: string, priority: JobPriority) =>
    request<{ position: number | null }>(`/generate/queue/${encodeURIComponent(jobId)}/priority`, json({ priority })),
  cancel: (jobId: string) => request<{ cancelled: boolean }>(`/generate/cancel/${encodeURIComponent(jobId)}`, { method: 'POST' }),
  status: (jobId: string) => request<{
    status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
    progress: number; step?: string; output_url?: string; error?: string; queue_position?: number | null
  }>(`/generate/status/${encodeURIComponent(jobId)}`),
}

// ─── GPU ──────────────────────────────────────────────────────────────────────

export const gpuApi = {
  status: () => request<GpuStatus>('/gpu/status'),
  estimate: (modelId: string, params: Record<string, unknown>) =>
    request<LaunchPlan>('/gpu/estimate', json({ model_id: modelId, params })),
  setPolicy: (policy: Partial<GpuPolicy>) => request<GpuPolicy>('/gpu/policy', json(policy)),
  unloadIdle: () => request<{ released: string[] }>('/gpu/unload-idle', { method: 'POST' }),
}

// ─── Copilot ──────────────────────────────────────────────────────────────────

export interface CopilotRequest {
  messages: { role: string; content: string; images?: string[] }[]
  model: string
  provider: { type: 'local' | 'external'; base_url?: string; api_key?: string }
  context: Record<string, unknown>
  thinking: string
  tool_policy: ToolPolicy
}

export const copilotApi = {
  async stream(body: CopilotRequest, onEvent: (event: CopilotEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${base()}/agent/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) throw new ApiError(res.status, `Copilot error ${res.status}`)
    await readSseStream<CopilotEvent>(res.body, onEvent, signal)
  },
  executeTool: (name: string, args: Record<string, unknown>, context: Record<string, unknown>) =>
    request<CopilotAction>('/agent/tools/execute', json({ name, arguments: args, context })),
  conversations: {
    list: () => request<ConversationSummary[]>('/agent/conversations'),
    create: () => request<StoredConversation>('/agent/conversations', { method: 'POST' }),
    load: (id: string) => request<StoredConversation>(`/agent/conversations/${id}`),
    save: (id: string, messages: unknown[]) =>
      request<ConversationSummary>(`/agent/conversations/${id}`, { method: 'PUT', body: JSON.stringify({ messages }) }),
    rename: (id: string, title: string) => request<ConversationSummary>(`/agent/conversations/${id}/title`, json({ title })),
    remove: (id: string) => request<{ deleted: boolean }>(`/agent/conversations/${id}`, { method: 'DELETE' }),
  },
}

/** User-facing message for any thrown value. */
export function errorMessage(err: unknown): string {
  // axios errors carry the backend's explanation in response.data.detail;
  // its own message ("Request failed with status code 503") says nothing.
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  if (err instanceof Error) return err.message.includes('Failed to fetch') ? 'Cannot reach the PolyPal API. Is the backend running?' : err.message
  return String(err)
}
