import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore, PROVIDERS, providerBaseUrl } from '@shared/stores/agentStore'
import { useLlmModels } from '@shared/stores/llmModelsStore'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useWorkflowRunStore } from '@areas/workflows/workflowRunStore'
import { buildAllWorkflowExtensions } from '@areas/workflows/mockExtensions'
import {
  copilotApi, errorMessage,
  type ConversationSummary, type CopilotAction, type CopilotEvent,
} from '@shared/api/polypalApi'
import { meshPathFromUrl } from '../meshPath'
import { applyMeshResult, trackGenerationJob } from '@areas/editor/useMeshEditing'

import type { ThinkingMode } from '@shared/stores/agentStore'
import type { Workflow } from '@shared/types/electron.d'

// ─── Types ────────────────────────────────────────────────────────────────────

/** A tool call as shown in the transcript; `running` exists only while streaming. */
type ChatAction = Omit<CopilotAction, 'status'> & { status: CopilotAction['status'] | 'running' | 'denied' }

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  actions?: ChatAction[]
  streaming?: boolean
  error?: boolean
  trimmed?: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLAPSE_AFTER = 8

const TOOL_LABELS: Record<string, string> = {
  decimate_mesh:         'Decimate mesh',
  smooth_mesh:           'Smooth mesh',
  edit_mesh:             'Edit mesh',
  list_models:           'List models',
  unload_models:         'Unload models',
  get_mesh_info:         'Inspect mesh',
  get_mesh_stats:        'Measure mesh',
  list_mesh_operations:  'List mesh operations',
  get_provenance:        'Read history',
  regenerate_model:      'Regenerate model',
  get_gpu_status:        'Check GPU',
  get_generation_status: 'Check generation',
  list_workflows:        'List workflows',
  run_workflow:          'Run workflow',
  create_workflow:       'Create workflow',
}

const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ')

// ─── Prose renderer — paragraphs, lists, **bold** and `code` ────────────────

function Inline({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={i} className="px-1 py-px rounded bg-zinc-800 text-[11.5px] font-mono text-zinc-100">{part.slice(1, -1)}</code>
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={i} className="font-semibold text-zinc-100">{part.slice(2, -2)}</strong>
        }
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

function ProseMessage({ content }: { content: string }): JSX.Element {
  const blocks = content.split(/\n\n+/)
  return (
    <div className="flex flex-col gap-2.5 text-[12.5px] leading-relaxed text-zinc-200 select-text">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const isList = lines.every((l) => /^\s*([-•*]|\d+\.)\s/.test(l) || l.trim() === '')
        if (isList) {
          return (
            <ul key={i} className="flex flex-col gap-1 pl-3">
              {lines.filter((l) => l.trim()).map((l, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-zinc-500 shrink-0 mt-px">•</span>
                  <span><Inline text={l.replace(/^\s*([-•*]|\d+\.)\s/, '')} /></span>
                </li>
              ))}
            </ul>
          )
        }
        return <p key={i} className="whitespace-pre-wrap"><Inline text={block} /></p>
      })}
    </div>
  )
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: ChatAction['status'] }): JSX.Element {
  if (status === 'running') {
    return (
      <svg className="animate-spin text-accent-light" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    )
  }
  if (status === 'ok') {
    return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-accent-light"><polyline points="20 6 9 17 4 12" /></svg>
  }
  if (status === 'pending') return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
      className={status === 'error' ? 'text-red-400' : 'text-zinc-600'}>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function ActionsCard({ actions, onUndo }: { actions: ChatAction[]; onUndo?: () => void }): JSX.Element | null {
  const attention = actions.some((a) => a.status === 'error' || a.status === 'running')
  const [expanded, setExpanded] = useState(attention)
  useEffect(() => { if (attention) setExpanded(true) }, [attention])
  const canUndo = !!onUndo && actions.some((a) => a.status === 'ok' && a.payload?.type === 'mesh_update')
  const visible = actions.filter((a) => a.status !== 'pending')
  if (visible.length === 0) return null

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 overflow-hidden text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700/40">
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex items-center gap-1.5 text-zinc-300 font-medium">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`transition-transform ${expanded ? '' : '-rotate-90'}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {visible.length} tool call{visible.length > 1 ? 's' : ''}
        </button>
        {canUndo && (
          <button type="button" onClick={onUndo} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 2.28-5.93" />
            </svg>
            Undo
          </button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col divide-y divide-zinc-700/30">
          {visible.map((a, i) => (
            <div key={a.call_id || i} className="px-3 py-1.5 flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <StatusIcon status={a.status} />
                <span className="text-zinc-300 flex-1 truncate">{toolLabel(a.tool)}</span>
                {a.payload?.type === 'mesh_update' && typeof a.payload.face_count === 'number' && (
                  <span className="text-accent-light font-mono">{a.payload.face_count.toLocaleString()} tri</span>
                )}
                {a.status === 'denied' && <span className="text-zinc-500">declined</span>}
                {a.duration_ms > 0 && <span className="text-zinc-600 font-mono">{(a.duration_ms / 1000).toFixed(1)}s</span>}
              </div>
              {a.status === 'error' && <p className="pl-[18px] text-red-400/90 break-words">{a.result}</p>}
              {a.status === 'ok' && a.risk !== 'read' && a.result && (
                <p className="pl-[18px] text-zinc-500 truncate" title={a.result}>{a.result}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ApprovalCard({ action, onApprove, onDeny, busy }: {
  action: ChatAction
  onApprove: () => void
  onDeny: () => void
  busy: boolean
}): JSX.Element {
  const summary = String(action.payload?.summary ?? toolLabel(action.tool))
  return (
    <div role="group" aria-label="Action awaiting approval" className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-300 mt-0.5 shrink-0">
          <path d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] text-zinc-200">{summary}</p>
          <p className={`text-[10px] ${action.risk === 'heavy' ? 'text-amber-300' : 'text-sky-300'}`}>
            {action.risk === 'heavy' ? 'Uses the GPU or unloads models' : 'Creates a new version (undoable)'} · needs your approval
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onDeny} disabled={busy}
          className="flex-1 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] transition-colors disabled:opacity-40">
          Decline
        </button>
        <button type="button" onClick={onApprove} disabled={busy}
          className="flex-1 py-1 rounded-lg bg-accent hover:bg-accent-dark text-white text-[11px] font-medium transition-colors disabled:opacity-40">
          Approve
        </button>
      </div>
    </div>
  )
}

function CopyButton({ content }: { content: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      title="Copy"
      aria-label="Copy message"
      className="self-start text-zinc-600 hover:text-zinc-400 transition-colors"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function ThinkingBlock({ content, live }: { content: string; live?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[11px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-400 transition-colors">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
        </svg>
        <span className={live ? 'animate-pulse' : ''}>{live ? 'Thinking…' : 'Reasoning'}</span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 pl-3 border-l-2 border-zinc-700">
          <p className="text-zinc-500 italic leading-relaxed whitespace-pre-wrap select-text">{content}</p>
        </div>
      )}
    </div>
  )
}

function WorkflowProgressCard({ name }: { name: string }): JSX.Element {
  const runState = useWorkflowRunStore((s) => s.runState)
  const pct = runState.blockProgress
  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
          <span className="text-zinc-300 font-medium truncate">{name}</span>
        </div>
        <span className="text-zinc-500 shrink-0">{pct}%</span>
      </div>
      <div className="h-0.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {runState.blockStep && <p className="text-[10px] text-zinc-500 truncate">{runState.blockStep}</p>}
    </div>
  )
}

// ─── Conversation history drawer ──────────────────────────────────────────────

function HistoryDrawer({ conversations, activeId, onOpen, onDelete, onRename, onClose }: {
  conversations: ConversationSummary[]
  activeId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onClose: () => void
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  return (
    <div className="absolute inset-0 z-40 bg-surface-400 flex flex-col">
      <div className="h-9 px-3 flex items-center justify-between border-b border-zinc-800 shrink-0">
        <span className="text-[11px] font-semibold text-zinc-300">Conversations</span>
        <button type="button" onClick={onClose} aria-label="Close history" className="p-1 text-zinc-500 hover:text-zinc-200">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {conversations.length === 0 && <p className="px-2 py-6 text-center text-[11px] text-zinc-600">No saved conversations yet.</p>}
        {conversations.map((c) => (
          <div key={c.id} className={`group rounded-lg px-2.5 py-2 flex items-start gap-2 ${c.id === activeId ? 'bg-accent/10' : 'hover:bg-zinc-800/60'}`}>
            {editing === c.id ? (
              <input
                autoFocus
                aria-label="Conversation title"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => { if (draft.trim()) onRename(c.id, draft.trim()); setEditing(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-200"
              />
            ) : (
              <button type="button" onClick={() => onOpen(c.id)} className="flex-1 min-w-0 text-left">
                <p className={`text-[11.5px] truncate ${c.id === activeId ? 'text-accent-light' : 'text-zinc-200'}`}>{c.title}</p>
                <p className="text-[10px] text-zinc-600 truncate">
                  {new Date(c.updated_at).toLocaleDateString()} · {c.message_count} msg{c.preview ? ` · ${c.preview}` : ''}
                </p>
              </button>
            )}
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button type="button" aria-label="Rename conversation" onClick={() => { setEditing(c.id); setDraft(c.title) }} className="p-0.5 text-zinc-500 hover:text-zinc-200">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
              </button>
              <button type="button" aria-label="Delete conversation" onClick={() => onDelete(c.id)} className="p-0.5 text-zinc-500 hover:text-red-400">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

/** What the transcript stores (no transient streaming flags). */
function persistable(messages: Message[]): Message[] {
  return messages.map(({ streaming: _streaming, ...m }) => ({
    ...m,
    actions: m.actions?.map((a) => (a.status === 'running' ? { ...a, status: 'error' as const, result: 'Interrupted' } : a)),
  }))
}

export default function ChatPanel(): JSX.Element {
  const { provider, localModel, external, defaultThinking } = useAgentStore()
  const { models: llmModels } = useLlmModels()
  const isLocal        = provider === 'local'
  const externalConfig = external[provider]

  const [messages, setMessages]               = useState<Message[]>([])
  const [conversationId, setConversationId]   = useState<string | null>(null)
  const [conversations, setConversations]     = useState<ConversationSummary[]>([])
  const [showHistory, setShowHistory]         = useState(false)
  const [input, setInput]                     = useState('')
  const [isLoading, setIsLoading]             = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [showAll, setShowAll]                 = useState(false)
  // null = follow the default from Settings, which hydrates asynchronously.
  const [localPick, setLocalPick]             = useState<string | null>(null)
  const model                                 = isLocal ? (localPick ?? localModel) : (externalConfig?.model ?? '')
  // code/cad models are node tools, not chat models.
  const localModels                           = llmModels.filter((m) => m.downloaded && !(m.tags ?? []).some((t) => t === 'code' || t === 'cad'))
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [pendingWorkflow, setPendingWorkflow]  = useState<{ id: string; name: string } | null>(null)
  const [approving, setApproving]             = useState<string | null>(null)
  const [attachments, setAttachments]         = useState<string[]>([]) // data URLs
  const [isDragging, setIsDragging]           = useState(false)
  const [thinkingMode, setThinkingMode]       = useState<ThinkingMode>(defaultThinking)
  const endRef                                = useRef<HTMLDivElement>(null)
  const textareaRef                           = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef                        = useRef<HTMLDivElement>(null)
  const fileInputRef                          = useRef<HTMLInputElement>(null)
  const abortRef                              = useRef<AbortController | null>(null)
  const messagesRef                           = useRef<Message[]>([])
  const conversationRef                       = useRef<string | null>(null)
  const creatingRef                           = useRef<Promise<string> | null>(null)
  messagesRef.current = messages
  conversationRef.current = conversationId

  const currentJob       = useAppStore((s) => s.currentJob)
  const meshStats        = useAppStore((s) => s.meshStats)
  const units            = useAppStore((s) => s.units)
  const toolPolicy       = useAppStore((s) => s.copilotToolPolicy)
  const undoMesh         = useAppStore((s) => s.undoMesh)

  const workflows     = useWorkflowsStore((s) => s.workflows)
  const saveWorkflow  = useWorkflowsStore((s) => s.save)
  const setActiveWorkflow = useWorkflowsStore((s) => s.setActive)
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const runWorkflow   = useWorkflowRunStore((s) => s.run)
  const runState      = useWorkflowRunStore((s) => s.runState)
  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  const refreshConversations = useCallback(() => {
    copilotApi.conversations.list().then(setConversations).catch(() => {})
  }, [])
  useEffect(() => { refreshConversations() }, [refreshConversations])

  // Close model picker on outside click
  useEffect(() => {
    if (!showModelPicker) return
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node))
        setShowModelPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showModelPicker])

  // Stop a running stream when the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Watch workflow completion → send follow-up to agent
  useEffect(() => {
    if (!pendingWorkflow) return
    if (runState.status !== 'done' && runState.status !== 'error') return

    const wf = pendingWorkflow
    setPendingWorkflow(null)

    if (runState.status === 'error') {
      setMessages((prev) => [...prev, {
        id: `sys-${Date.now()}`,
        role: 'assistant',
        content: `The workflow '${wf.name}' failed: ${runState.error ?? 'Unknown error'}`,
        error: true,
      }])
      return
    }

    if (runState.outputUrl) applyMeshResult(runState.outputUrl, `Workflow: ${wf.name}`)

    const completionCtx = `Workflow '${wf.name}' just completed.${runState.outputUrl ? ` Output mesh: ${runState.outputUrl}` : ''} Ask the user what they'd like to do next.`
    void callAgent(messagesRef.current, completionCtx)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on run-status transition; error/outputUrl read atomically
  }, [runState.status, pendingWorkflow])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isLoading, pendingWorkflow])

  function buildContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = { units }
    const meshPath = meshPathFromUrl(currentJob?.outputUrl)
    if (meshPath) ctx.currentMeshPath = meshPath
    if (meshStats?.triangles)  ctx.meshTriangles   = meshStats.triangles
    if (workflows.length > 0)  ctx.workflows       = workflows.map((w) => ({ id: w.id, name: w.name }))
    if (allExtensions.length > 0) ctx.extensions   = allExtensions.map((e) => ({
      id: e.id, name: e.name, input: e.input, output: e.output,
    }))
    return ctx
  }

  async function persist(next: Message[]) {
    try {
      let id = conversationRef.current
      if (!id) {
        // One shared creation, even if persist() fires twice before it resolves.
        creatingRef.current ??= copilotApi.conversations.create().then((c) => c.id)
        id = await creatingRef.current
        creatingRef.current = null
        setConversationId(id)
        conversationRef.current = id
      }
      await copilotApi.conversations.save(id, persistable(next))
      refreshConversations()
    } catch {
      // History is a convenience; a failed save must not break the chat.
    }
  }

  /** React to a successful tool action in the app (viewer, workflows, jobs). */
  async function applyAction(action: ChatAction, imageOverride?: string) {
    const payload = action.payload
    if (!payload || action.status !== 'ok') return
    if (payload.type === 'mesh_update' && typeof payload.url === 'string') {
      applyMeshResult(payload.url, `Copilot: ${String(payload.label ?? toolLabel(action.tool))}`)
    }
    if (payload.type === 'run_workflow' && typeof payload.workflow_id === 'string') {
      const wf = workflows.find((w) => w.id === payload.workflow_id)
      if (wf) { void runWorkflow(wf, allExtensions, imageOverride); setPendingWorkflow({ id: wf.id, name: wf.name }) }
    }
    if (payload.type === 'create_workflow' && payload.workflow) {
      const draft = payload.workflow as Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>
      const now = new Date().toISOString()
      const wf: Workflow = { ...draft, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      const res = await saveWorkflow(wf)
      if (res.success) setActiveWorkflow(wf.id)
    }
    if (payload.type === 'generation_started' && typeof payload.job_id === 'string') {
      void trackGenerationJob(payload.job_id, 'Regeneration')
    }
  }

  function latestImageOverride(msgs: Message[]): string | undefined {
    const dataUrl = [...msgs].reverse().find((m) => m.role === 'user' && m.imageDataUrls?.length)?.imageDataUrls?.[0]
    return dataUrl ? dataUrl.split(',')[1] : undefined
  }

  async function callAgent(msgs: Message[], systemNote?: string) {
    setIsLoading(true)
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    const assistantId = `a-${Date.now()}`
    const patch = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)))
    setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', streaming: true, actions: [] }])

    const apiMessages = msgs
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content, ...(m.imageDataUrls?.length ? { images: m.imageDataUrls } : {}) }))
    if (systemNote) apiMessages.push({ role: 'user', content: `[System] ${systemNote}` })
    const imageOverride = latestImageOverride(msgs)

    let finished = false
    try {
      await copilotApi.stream({
        messages: apiMessages,
        model,
        provider: isLocal
          ? { type: 'local' }
          : { type: 'external', base_url: providerBaseUrl(provider, externalConfig), api_key: externalConfig?.apiKey ?? '' },
        context: buildContext(),
        thinking: thinkingMode,
        tool_policy: toolPolicy,
      }, (event: CopilotEvent) => {
        switch (event.type) {
          case 'start':
            if (event.trimmed) patch((m) => ({ ...m, trimmed: event.trimmed }))
            break
          case 'token':
            patch((m) => ({ ...m, content: m.content + event.text }))
            break
          case 'thinking':
            patch((m) => ({ ...m, thinking: (m.thinking ?? '') + event.text }))
            break
          case 'round':
            // Separate narration from successive tool rounds.
            if (event.index > 0) patch((m) => (m.content && !m.content.endsWith('\n\n') ? { ...m, content: `${m.content}\n\n` } : m))
            break
          case 'tool_call':
            patch((m) => ({
              ...m,
              actions: [...(m.actions ?? []), {
                tool: event.tool, call_id: event.call_id, arguments: event.arguments,
                risk: event.risk as ChatAction['risk'], status: 'running', result: '', duration_ms: 0,
              }],
            }))
            break
          case 'tool_result':
            patch((m) => ({
              ...m,
              actions: (m.actions ?? []).map((a) => (a.call_id === event.action.call_id ? event.action : a)),
            }))
            void applyAction(event.action, imageOverride)
            break
          case 'done': {
            finished = true
            const doneActions = event.actions as ChatAction[]
            setMessages((prev) => {
              const next = prev.map((m) => (m.id === assistantId ? {
                ...m,
                content: event.message || m.content.trim(),
                thinking: event.thinking ?? m.thinking,
                actions: doneActions.length ? doneActions : undefined,
                streaming: false,
                error: event.error,
              } : m))
              void persist(next)
              return next
            })
            break
          }
        }
      }, controller.signal)
      if (!finished && !controller.signal.aborted) throw new Error('The copilot stream ended unexpectedly')
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        setMessages((prev) => {
          const next = prev.map((m) => (m.id === assistantId
            ? { ...m, streaming: false, content: m.content ? `${m.content.trim()}\n\n(stopped)` : '(stopped)' }
            : m))
          void persist(next)
          return next
        })
      } else {
        setMessages((prev) => prev
          .filter((m) => m.id !== assistantId || m.content || m.actions?.length)
          .map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)))
        setError(errorMessage(e))
      }
    } finally {
      abortRef.current = null
      setIsLoading(false)
    }
  }

  async function resolvePending(messageId: string, action: ChatAction, approve: boolean) {
    const update = (next: ChatAction) => setMessages((prev) => {
      const updated = prev.map((m) => (m.id === messageId
        ? { ...m, actions: m.actions?.map((a) => (a.call_id === action.call_id ? next : a)) }
        : m))
      void persist(updated)
      return updated
    })
    if (!approve) {
      update({ ...action, status: 'denied', result: 'Declined by the user' })
      return
    }
    setApproving(action.call_id)
    try {
      const result = await copilotApi.executeTool(action.tool, action.arguments, buildContext())
      const done: ChatAction = { ...result, call_id: action.call_id }
      update(done)
      await applyAction(done, latestImageOverride(messagesRef.current))
      if (done.status === 'ok' && action.tool !== 'run_workflow') {
        // Let the copilot react to the outcome (workflows report back on completion).
        void callAgent(messagesRef.current, `The user approved "${toolLabel(action.tool)}". Result: ${done.result}`)
      }
    } catch (e) {
      update({ ...action, status: 'error', result: errorMessage(e) })
    } finally {
      setApproving(null)
    }
  }

  async function openConversation(id: string) {
    abortRef.current?.abort()
    try {
      const data = await copilotApi.conversations.load(id)
      setMessages((data.messages as Message[]).map((m) => ({ ...m, streaming: false })))
      setConversationId(id)
      setShowAll(false)
      setShowHistory(false)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function newConversation() {
    abortRef.current?.abort()
    setMessages([])
    setConversationId(null)
    setError(null)
    setShowHistory(false)
    setPendingWorkflow(null)
  }

  async function deleteConversation(id: string) {
    await copilotApi.conversations.remove(id).catch(() => {})
    if (id === conversationId) newConversation()
    refreshConversations()
  }

  async function renameConversation(id: string, title: string) {
    await copilotApi.conversations.rename(id, title).catch(() => {})
    refreshConversations()
  }

  function handleFiles(files: File[]) {
    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        setAttachments((prev) => [...prev, dataUrl])
      }
      reader.readAsDataURL(file)
    })
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  function adjustHeight() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || isLoading || pendingWorkflow) return

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      ...(attachments.length ? { imageDataUrls: [...attachments] } : {}),
    }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await callAgent(nextMessages)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() }
  }

  // Collapsed history
  const collapsed = !showAll && messages.length > COLLAPSE_AFTER
  const hidden    = collapsed ? messages.length - COLLAPSE_AFTER : 0
  const visible   = collapsed ? messages.slice(-COLLAPSE_AFTER) : messages
  const activeTitle = conversations.find((c) => c.id === conversationId)?.title

  return (
    <div
      className="flex flex-col flex-1 min-h-0 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none">
          <p className="text-[12px] text-accent font-medium">Drop image here</p>
        </div>
      )}

      {showHistory && (
        <HistoryDrawer
          conversations={conversations}
          activeId={conversationId}
          onOpen={(id) => void openConversation(id)}
          onDelete={(id) => void deleteConversation(id)}
          onRename={(id, title) => void renameConversation(id, title)}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Conversation bar */}
      <div className="shrink-0 h-8 px-3 flex items-center gap-2 border-b border-zinc-800/80">
        <button type="button" onClick={() => { refreshConversations(); setShowHistory(true) }} title="Conversation history"
          aria-label="Conversation history" className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" />
          </svg>
        </button>
        <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-400">{activeTitle ?? 'New conversation'}</span>
        <button type="button" onClick={newConversation} title="New conversation" aria-label="New conversation"
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">

        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-5 py-10">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
              </svg>
            </div>
            <p className="text-[11px] text-zinc-500 text-center leading-relaxed">
              Ask me to edit the mesh, explain how it was made,<br />run a workflow or check the GPU.
            </p>
            <div className="flex flex-col gap-1 w-full max-w-[240px]">
              {['Clean up floaters and make it 12 cm tall', 'How was this model generated?', 'Is there enough VRAM to regenerate it?'].map((s) => (
                <button key={s} type="button" onClick={() => { setInput(s); textareaRef.current?.focus() }}
                  className="px-2.5 py-1.5 rounded-lg border border-zinc-800 text-[10.5px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 text-left transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {collapsed && (
          <button
            onClick={() => setShowAll(true)}
            className="mx-4 mt-4 mb-1 flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors self-start"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {hidden} previous message{hidden > 1 ? 's' : ''}
          </button>
        )}

        <div className="flex flex-col px-4 py-3 gap-5" aria-live="polite">
          {visible.map((msg) => (
            <div key={msg.id}>
              {msg.role === 'user' ? (
                <div className="flex flex-col items-end gap-1.5">
                  {msg.imageDataUrls && msg.imageDataUrls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 justify-end max-w-[80%]">
                      {msg.imageDataUrls.map((url, i) => (
                        <img key={i} src={url} alt="" className="max-h-36 max-w-full rounded-xl object-cover border border-zinc-700/50" />
                      ))}
                    </div>
                  )}
                  <div className="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm bg-zinc-800 border border-zinc-700/50 text-[12px] text-zinc-200 leading-relaxed select-text whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {msg.trimmed ? (
                    <p className="text-[10px] text-zinc-600">{msg.trimmed} older message{msg.trimmed > 1 ? 's were' : ' was'} left out to fit the model's context.</p>
                  ) : null}
                  {msg.thinking && <ThinkingBlock content={msg.thinking} live={msg.streaming && !msg.content} />}
                  {msg.content ? (
                    <div className={msg.error ? 'text-red-300' : ''}>
                      <ProseMessage content={msg.content} />
                      {msg.streaming && <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-accent-light/80 animate-pulse align-middle" />}
                    </div>
                  ) : msg.streaming && !(msg.actions?.length) ? (
                    <div className="flex gap-1 items-center py-1">
                      {[0, 1, 2].map((i) => (
                        <span key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: `${i * 130}ms` }} />
                      ))}
                    </div>
                  ) : null}
                  {msg.actions && msg.actions.length > 0 && <ActionsCard actions={msg.actions} onUndo={undoMesh} />}
                  {msg.actions?.filter((a) => a.status === 'pending').map((a) => (
                    <ApprovalCard
                      key={a.call_id}
                      action={a}
                      busy={approving === a.call_id || isLoading}
                      onApprove={() => void resolvePending(msg.id, a, true)}
                      onDeny={() => void resolvePending(msg.id, a, false)}
                    />
                  ))}
                  {!msg.streaming && msg.content && <CopyButton content={msg.content} />}
                </div>
              )}
            </div>
          ))}

          {pendingWorkflow && <WorkflowProgressCard name={pendingWorkflow.name} />}

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-950/40 border border-red-800/40">
              <p className="text-[11px] text-red-400">{error}</p>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-zinc-800">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) handleFiles(Array.from(e.target.files)); e.target.value = '' }}
        />
        <div className="flex flex-col gap-1.5 bg-zinc-900 border border-zinc-700/60 rounded-2xl px-3 py-2.5">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((url, i) => (
                <div key={i} className="relative group">
                  <img src={url} alt="" className="h-14 w-14 object-cover rounded-lg border border-zinc-700/50" />
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="Remove attachment"
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 border border-zinc-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustHeight() }}
            onKeyDown={handleKeyDown}
            placeholder="Ask PolyPal…"
            aria-label="Message the copilot"
            rows={1}
            spellCheck={false}
            className="w-full bg-transparent text-[12.5px] text-zinc-200 placeholder-zinc-600 focus:outline-none resize-none leading-relaxed overflow-hidden"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                aria-label="Attach image"
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </button>
              <button
                onClick={() => setThinkingMode((m) => m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto')}
                title={`Thinking: ${thinkingMode}`}
                aria-label={`Thinking: ${thinkingMode}`}
                className={`transition-colors ${thinkingMode === 'on' ? 'text-accent' : thinkingMode === 'off' ? 'text-zinc-700' : 'text-zinc-600 hover:text-zinc-400'}`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                  {thinkingMode === 'off' && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="2" />}
                </svg>
              </button>
              <div className="relative" ref={modelPickerRef}>
                <button
                  onClick={() => setShowModelPicker((v) => !v)}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {isLocal ? (localModels.find((m) => m.id === model)?.name ?? model) : (model || PROVIDERS[provider].label)}
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {showModelPicker && (
                  <div className="absolute bottom-full mb-2 left-0 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl overflow-hidden min-w-[180px]">
                    {!isLocal ? (
                      <p className="px-3 py-2.5 text-[11px] text-zinc-500">{PROVIDERS[provider].label} — change the model in Settings → Agent.</p>
                    ) : localModels.length === 0 ? (
                      <p className="px-3 py-2.5 text-[11px] text-zinc-500">No local model downloaded — open Settings → Agent.</p>
                    ) : (
                      localModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => { setLocalPick(m.id); setShowModelPicker(false) }}
                          className={`w-full px-3 py-2 text-left text-[11px] hover:bg-zinc-800 transition-colors flex items-center justify-between gap-3 ${m.id === model ? 'text-zinc-100' : 'text-zinc-400'}`}
                        >
                          <span className="truncate">{m.name}</span>
                          {m.id === model && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-accent">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            {isLoading ? (
              <button
                onClick={() => abortRef.current?.abort()}
                title="Stop"
                aria-label="Stop generating"
                className="w-6 h-6 rounded-full bg-zinc-700 hover:bg-zinc-600 text-white flex items-center justify-center transition-colors shrink-0"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
              </button>
            ) : (
              <button
                onClick={() => void handleSend()}
                disabled={!input.trim() || !!pendingWorkflow}
                aria-label="Send"
                className="w-6 h-6 rounded-full bg-accent hover:bg-accent-dark disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shrink-0"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[10px] text-zinc-700 text-center">
          Shift+Enter for new line · {toolPolicy === 'auto' ? 'tools run automatically' : toolPolicy === 'confirm_all' ? 'all changes need approval' : 'heavy actions need approval'}
        </p>
      </div>
    </div>
  )
}
