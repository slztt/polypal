// Renders an editable form from a params_schema (the shape shared by mesh
// operations and extension manifests). Values are coerced to the schema's
// bounds as you edit, so what you see is what the backend will run.
import type { EditorParam } from '@areas/editor/editorTools'
import { coerceParam } from '@areas/editor/editorTools'

interface ParamFormProps {
  params:   EditorParam[]
  values:   Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  disabled?: boolean
  compact?: boolean
}

const inputClass =
  'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 ' +
  'focus:outline-none focus:border-accent disabled:opacity-50 transition-colors'

export function ParamForm({ params, values, onChange, disabled, compact }: ParamFormProps): JSX.Element {
  if (params.length === 0) {
    return <p className="text-[10px] text-zinc-600 italic">No settings — runs as is.</p>
  }
  const set = (id: string, value: unknown) => onChange({ ...values, [id]: value })

  return (
    <div className={`flex flex-col ${compact ? 'gap-2' : 'gap-3'}`}>
      {params.map((param) => {
        const type = param.type as string
        const value = values[param.id] ?? param.default
        const fieldId = `param-${param.id}`
        const label = (
          <label htmlFor={fieldId} className="text-[10px] text-zinc-400 flex items-center gap-1" title={param.tooltip}>
            {param.label}
            {param.tooltip && <span className="text-zinc-600 cursor-help" aria-hidden="true">ⓘ</span>}
          </label>
        )

        if (type === 'boolean') {
          return (
            <label key={param.id} className="flex items-center gap-2 cursor-pointer" title={param.tooltip}>
              <input
                id={fieldId}
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={(e) => set(param.id, e.target.checked)}
                className="accent-green-500"
              />
              <span className="text-[11px] text-zinc-300">{param.label}</span>
            </label>
          )
        }

        if (type === 'select') {
          return (
            <div key={param.id} className="flex flex-col gap-1">
              {label}
              <select
                id={fieldId}
                value={String(value ?? '')}
                disabled={disabled}
                onChange={(e) => {
                  const option = param.options?.find((o) => String(o.value) === e.target.value)
                  set(param.id, option ? option.value : e.target.value)
                }}
                className={inputClass}
              >
                {(param.options ?? []).map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            </div>
          )
        }

        if (type === 'int' || type === 'float') {
          const numeric = typeof value === 'number' ? value : Number(value)
          const hasRange = param.min !== undefined && param.max !== undefined
          const step = param.step ?? (type === 'int' ? 1 : 0.01)
          return (
            <div key={param.id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                {label}
                <input
                  id={fieldId}
                  type="number"
                  value={Number.isFinite(numeric) ? numeric : ''}
                  min={param.min}
                  max={param.max}
                  step={step}
                  disabled={disabled}
                  onChange={(e) => set(param.id, e.target.value === '' ? param.default : Number(e.target.value))}
                  onBlur={(e) => set(param.id, coerceParam(param, e.target.value))}
                  className="w-24 bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-[11px] text-zinc-200 text-right font-mono focus:outline-none focus:border-accent"
                />
              </div>
              {hasRange && (param.max! - param.min!) / step <= 2000 && (
                <input
                  type="range"
                  aria-label={param.label}
                  min={param.min}
                  max={param.max}
                  step={step}
                  value={Number.isFinite(numeric) ? numeric : Number(param.default)}
                  disabled={disabled}
                  onChange={(e) => set(param.id, coerceParam(param, e.target.value))}
                  className="w-full h-1.5 accent-green-500 cursor-pointer"
                />
              )}
            </div>
          )
        }

        return (
          <div key={param.id} className="flex flex-col gap-1">
            {label}
            <input
              id={fieldId}
              type="text"
              value={String(value ?? '')}
              disabled={disabled}
              onChange={(e) => set(param.id, e.target.value)}
              className={inputClass}
            />
          </div>
        )
      })}
    </div>
  )
}
