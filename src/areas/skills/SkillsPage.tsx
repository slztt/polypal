import { useCallback, useEffect, useState } from 'react'
import { errorMessage, skillsApi, type Skill } from '@shared/api/polypalApi'

function sourceLabel(source: string): string {
  if (source === 'built-in') return 'Built-in'
  if (source.startsWith('http') || source.startsWith('github')) return 'GitHub'
  if (source.startsWith('folder:')) return 'From folder'
  return 'Yours'
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-zinc-700'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

/** SKILL.md editor — same format as Claude skills: YAML front matter (name, description) + instructions. */
function SkillEditor({ original, onClose, onSaved }: {
  original: Skill | null
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const load = original ? skillsApi.get(original.name).then((s) => s.content ?? '') : skillsApi.template().then((t) => t.content)
    load.then(setContent, (e) => setError(errorMessage(e)))
  }, [original])

  const save = async () => {
    if (content === null) return
    setSaving(true)
    setError(null)
    try {
      await skillsApi.save(content, original?.name)
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label="Edit skill">
      <div className="pp-panel flex h-full max-h-[760px] w-full max-w-3xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <div>
            <p className="text-sm font-medium text-white">{original ? `Edit ${original.name}` : 'New skill'}</p>
            <p className="text-[11px] text-zinc-500">SKILL.md — the <code>name</code> and <code>description</code> at the top tell the assistant when to use it.</p>
          </div>
          <button type="button" aria-label="Close" className="text-zinc-500 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {content === null && !error ? (
          <p className="p-5 text-sm text-zinc-500">Loading…</p>
        ) : (
          <textarea aria-label="SKILL.md" value={content ?? ''} onChange={(e) => setContent(e.target.value)} spellCheck={false}
            className="flex-1 resize-none bg-surface-500 p-5 font-mono text-[12.5px] leading-relaxed text-zinc-200 outline-none" />
        )}
        <div className="flex items-center gap-2 border-t border-white/[0.05] px-5 py-3">
          {error && <p role="alert" className="min-w-0 flex-1 truncate text-xs text-red-400" title={error}>{error}</p>}
          <div className="ml-auto flex gap-2">
            <button type="button" className="pp-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="pp-btn-primary" disabled={saving || !content?.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save skill'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SkillsPage(): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSkills(await skillsApi.list())
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const install = async (body: { url?: string; path?: string }) => {
    setInstalling(true)
    setError(null)
    setNotice(null)
    try {
      const { installed } = await skillsApi.install(body)
      setNotice(installed.length ? `Added ${installed.join(', ')}` : 'No SKILL.md found there')
      setUrl('')
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setInstalling(false)
    }
  }

  const addFromFolder = async () => {
    const path = await window.electron.fs.selectDirectory()
    if (path) await install({ path })
  }

  const toggle = async (skill: Skill, enabled: boolean) => {
    setSkills((list) => list.map((s) => (s.name === skill.name ? { ...s, enabled } : s)))
    try { await skillsApi.setEnabled(skill.name, enabled) } catch (e) { setError(errorMessage(e)); await load() }
  }

  const remove = async (name: string) => {
    setConfirmDelete(null)
    try { await skillsApi.remove(name); await load() } catch (e) { setError(errorMessage(e)) }
  }

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="pp-title">Skills</h1>
          <p className="pp-subtitle mt-1">
            Skills teach the assistant your rules — like “always make models print-ready”. Each skill is a folder with a
            SKILL.md file, the same format Claude uses. The assistant reads a skill only when it's relevant.
          </p>
        </div>
        <button type="button" className="pp-btn-primary" onClick={() => setEditing('new')}>New skill</button>
      </header>

      <div className="pp-card flex flex-wrap items-center gap-2 p-3">
        <form className="flex min-w-[280px] flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void install({ url: url.trim() }) }}>
          <input className="pp-input flex-1" placeholder="https://github.com/owner/repo (or …/tree/main/skills/name)" value={url}
            onChange={(e) => setUrl(e.target.value)} aria-label="GitHub address of a skill" />
          <button type="submit" className="pp-btn-ghost" disabled={installing || !url.trim()}>{installing ? 'Adding…' : 'Add from GitHub'}</button>
        </form>
        <button type="button" className="pp-btn-ghost" disabled={installing} onClick={() => void addFromFolder()}>Add from folder</button>
      </div>

      {notice && <p className="text-sm text-accent-light">{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-sm text-zinc-500">No skills yet. Create one or add one from GitHub.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {skills.map((skill) => (
            <li key={skill.name} className={`pp-card flex flex-col gap-3 p-4 ${skill.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-light" aria-hidden>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{skill.name}</p>
                  <span className="pp-chip mt-1">{sourceLabel(skill.source)}</span>
                </div>
                <Toggle checked={skill.enabled} onChange={(v) => void toggle(skill, v)} label={`Use ${skill.name}`} />
              </div>
              <p className="line-clamp-3 text-xs leading-relaxed text-zinc-400">{skill.description || 'No description'}</p>
              {!skill.valid && <p className="text-[11px] text-amber-300">{skill.error ?? 'This SKILL.md has a problem'}</p>}
              {skill.files.length > 1 && (
                <p className="truncate text-[11px] text-zinc-600" title={skill.files.join(', ')}>
                  {skill.files.length} files · {skill.files.filter((f) => f !== 'SKILL.md').join(', ')}
                </p>
              )}
              <div className="mt-auto flex gap-2">
                <button type="button" className="pp-btn-ghost flex-1" onClick={() => setEditing(skill)}>Edit</button>
                {confirmDelete === skill.name ? (
                  <>
                    <button type="button" className="pp-btn-danger" onClick={() => void remove(skill.name)}>Delete</button>
                    <button type="button" className="pp-btn-ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <button type="button" className="pp-btn-ghost text-red-300" onClick={() => setConfirmDelete(skill.name)}>Remove</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <SkillEditor
          original={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }}
        />
      )}
    </div>
  )
}
