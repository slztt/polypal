// Picture inputs for the simplified pages: drop, paste (Ctrl/Cmd+V anywhere
// on the page) or browse. Values are data URLs.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { playSfx } from '@shared/utils/sfx'

const ACCEPT = 'image/png,image/jpeg,image/webp,image/bmp'
const MAX_BYTES = 25 * 1024 * 1024

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('That file is not a picture'))
    if (file.size > MAX_BYTES) return reject(new Error('Pictures must be under 25 MB'))
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read the picture'))
    reader.readAsDataURL(file)
  })
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/png'
  const bytes = Uint8Array.from(atob(body ?? ''), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

/**
 * Calls `onFiles` with pictures pasted anywhere on the page while mounted.
 * With `scope`, only while that element is on screen (pages stay mounted in
 * the background, and a hidden page must not grab the paste).
 */
export function usePastedImages(onFiles: (files: File[]) => void, enabled = true, scope?: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (e: ClipboardEvent) => {
      if (scope && (!scope.current || scope.current.offsetParent === null)) return
      const target = e.target as HTMLElement | null
      // Let text fields paste text normally unless the clipboard holds a picture.
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && e.clipboardData?.getData('text')) return
      e.preventDefault()
      onFiles(files)
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [onFiles, enabled, scope])
}

const UploadIcon = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" />
  </svg>
)

export function ImageDropZone({ value, onChange, onError, label = 'Drop a picture here', className = '' }: {
  value: string | null
  onChange: (dataUrl: string | null) => void
  onError?: (message: string) => void
  label?: string
  className?: string
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const accept = useCallback(async (files: File[]) => {
    const file = files.find((f) => f.type.startsWith('image/'))
    if (!file) return
    try {
      onChange(await readImageFile(file))
      playSfx('drop')
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }, [onChange, onError])

  usePastedImages(accept, true, root)

  return (
    <div
      ref={root}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void accept(Array.from(e.dataTransfer.files)) }}
      className={`group/drop relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-200 ${
        dragging ? 'scale-[1.01] border-accent bg-accent/[0.07]' : value ? 'border-white/[0.08] bg-black/20' : 'border-white/[0.10] bg-black/20 hover:border-white/20'
      } ${className}`}
    >
      <input ref={input} type="file" accept={ACCEPT} className="hidden"
        onChange={(e) => { void accept(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      {value ? (
        <>
          <img src={value} alt="Selected picture" className="h-full w-full animate-pop object-contain p-3" />
          <div className="absolute right-2 top-2 flex gap-1.5">
            <button type="button" onClick={() => input.current?.click()} className="rounded-lg bg-black/60 px-2.5 py-1 text-[11px] text-zinc-200 backdrop-blur hover:bg-black/80">Replace</button>
            <button type="button" onClick={() => onChange(null)} aria-label="Remove picture" className="rounded-lg bg-black/60 px-2 py-1 text-[11px] text-zinc-200 backdrop-blur hover:bg-red-500/70">✕</button>
          </div>
        </>
      ) : (
        <button type="button" onClick={() => input.current?.click()} className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent-light transition-transform duration-300 group-hover/drop:-translate-y-1 group-hover/drop:scale-110">{UploadIcon}</span>
          <span className="text-sm font-medium text-zinc-200">{label}</span>
          <span className="text-xs text-zinc-500">or <span className="text-accent-light">browse</span> · paste with Ctrl+V</span>
        </button>
      )}
    </div>
  )
}

export function ReferencePicker({ values, onChange, max = 5, onError }: {
  values: string[]
  onChange: (values: string[]) => void
  max?: number
  onError?: (message: string) => void
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const add = useCallback(async (files: File[]) => {
    const room = max - values.length
    if (room <= 0) { onError?.(`Up to ${max} reference pictures`); return }
    try {
      const urls = await Promise.all(files.filter((f) => f.type.startsWith('image/')).slice(0, room).map(readImageFile))
      onChange([...values, ...urls])
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }, [values, onChange, max, onError])

  return (
    <div
      className="flex flex-wrap gap-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void add(Array.from(e.dataTransfer.files)) }}
    >
      <input ref={input} type="file" accept={ACCEPT} multiple className="hidden"
        onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      {values.map((url, i) => (
        <div key={i} className="group relative h-16 w-16 animate-pop overflow-hidden rounded-xl border border-white/[0.08] bg-black/30 transition-transform hover:scale-105">
          <img src={url} alt={`Reference ${i + 1}`} className="h-full w-full object-cover" />
          <button type="button" aria-label={`Remove reference ${i + 1}`} onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[10px] text-white group-hover:flex">✕</button>
        </div>
      ))}
      {values.length < max && (
        <button type="button" onClick={() => input.current?.click()}
          className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-white/[0.12] text-zinc-500 transition-colors hover:border-accent/50 hover:text-accent-light">
          <span className="text-lg leading-none">+</span>
          <span className="text-[9.5px]">{values.length}/{max}</span>
        </button>
      )}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, size = 'md' }: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
}): JSX.Element {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="relative flex rounded-xl border border-white/[0.06] bg-black/30 p-1">
      {/* Sliding highlight behind the selected option */}
      <span
        aria-hidden
        className="absolute bottom-1 top-1 rounded-lg bg-white/[0.09] shadow-card transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ left: 4, width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          data-sfx="toggle"
          onClick={() => onChange(o.value)}
          className={`relative z-10 flex-1 rounded-lg font-medium transition-colors duration-200 active:scale-[0.97] ${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-2 text-[13px]'} ${
            value === o.value ? 'text-white' : 'text-zinc-400 hover:text-zinc-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
