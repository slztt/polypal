// One list of Mesh Editor tools from two sources:
//  - built-in operations served by the API's mesh-op registry (/edit/ops);
//  - plugin tools: process-extension nodes that opt in with an "editor" key
//    in their manifest (mesh in, mesh out — see docs/editor-plugins.md).
// The editor panel renders both identically; only how they run differs.
import type { MeshOperation, ParamSchema as ApiParam } from '@shared/api/polypalApi'
import type { ProcessExtension, ParamSchema as ManifestParam } from '@shared/types/electron.d'

export type EditorParam = ApiParam | ManifestParam

export interface EditorTool {
  /** Stable key: "builtin:<op>" or "plugin:<extension>/<node>". */
  key:          string
  source:       'builtin' | 'plugin'
  label:        string
  description:  string
  category:     string
  params:       EditorParam[]
  opId?:        string
  extensionId?: string
  nodeId?:      string
  author?:      string
  trusted?:     boolean
}

export const CATEGORY_ORDER = ['cleanup', 'repair', 'optimization', 'topology', 'transform'] as const

export const CATEGORY_LABELS: Record<string, string> = {
  cleanup:      'Clean up',
  repair:       'Repair',
  optimization: 'Optimize',
  topology:     'Topology',
  transform:    'Transform & size',
  plugins:      'Plugins',
}

export function buildEditorTools(ops: MeshOperation[], processExtensions: ProcessExtension[]): EditorTool[] {
  const builtin: EditorTool[] = ops.map((op) => ({
    key:         `builtin:${op.id}`,
    source:      'builtin',
    label:       op.label,
    description: op.description,
    category:    op.category,
    params:      op.params_schema,
    opId:        op.id,
  }))
  const plugins: EditorTool[] = processExtensions
    .filter((ext) => !ext.corrupted)
    .flatMap((ext) => ext.nodes
      .filter((node) => node.editor && node.input === 'mesh' && node.output === 'mesh')
      .map((node): EditorTool => ({
        key:         `plugin:${ext.id}/${node.id}`,
        source:      'plugin',
        label:       node.editor?.label ?? node.name,
        description: node.editor?.description ?? ext.description ?? '',
        category:    node.editor?.category ?? 'plugins',
        params:      node.paramsSchema ?? [],
        extensionId: ext.id,
        nodeId:      node.id,
        author:      ext.author,
        trusted:     ext.trusted,
      })))
  return [...builtin, ...plugins]
}

export interface ToolGroup { category: string; label: string; tools: EditorTool[] }

export function groupEditorTools(tools: EditorTool[]): ToolGroup[] {
  const byCategory = new Map<string, EditorTool[]>()
  for (const tool of tools) {
    const list = byCategory.get(tool.category) ?? []
    list.push(tool)
    byCategory.set(tool.category, list)
  }
  const rank = (category: string) => {
    const index = (CATEGORY_ORDER as readonly string[]).indexOf(category)
    return index === -1 ? CATEGORY_ORDER.length + (category === 'plugins' ? 1 : 0) : index
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1),
      tools: list,
    }))
}

export function filterEditorTools(tools: EditorTool[], query: string): EditorTool[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return tools
  return tools.filter((t) => `${t.label} ${t.description} ${t.category} ${t.opId ?? ''}`.toLowerCase().includes(needle))
}

/** Initial form values: each param's declared default. */
export function defaultParams(params: EditorParam[]): Record<string, unknown> {
  return Object.fromEntries(params.filter((p) => p.default !== undefined).map((p) => [p.id, p.default]))
}

/** Clamp/coerce a form value the way the backend will, so the form shows the truth. */
export function coerceParam(param: EditorParam, raw: unknown): unknown {
  const type = param.type as string
  if (type === 'boolean') return raw === true || raw === 'true'
  if (type === 'int' || type === 'float') {
    let n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'))
    if (!Number.isFinite(n)) return param.default
    if (param.min !== undefined) n = Math.max(param.min, n)
    if (param.max !== undefined) n = Math.min(param.max, n)
    return type === 'int' ? Math.round(n) : n
  }
  return raw
}
