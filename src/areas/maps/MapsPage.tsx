import { useCallback, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { ImageDropZone, Segmented } from '@shared/components/ui/ImagePicker'
import { SaveToLibraryDialog } from '@shared/components/ui/SaveToLibraryDialog'
import { playSfx } from '@shared/utils/sfx'
import { useMapStore } from './mapStore'
import { MapViewer } from './MapViewer'

type WallMode = 'auto' | 'dark' | 'light' | 'color'

/** Read the colour under a click on an <img>, in the image's own pixels. */
function pickColor(img: HTMLImageElement, clientX: number, clientY: number): string | null {
  const rect = img.getBoundingClientRect()
  // object-contain: work out where the picture actually sits inside the box.
  const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight)
  const drawnW = img.naturalWidth * scale
  const drawnH = img.naturalHeight * scale
  const x = (clientX - rect.left - (rect.width - drawnW) / 2) / scale
  const y = (clientY - rect.top - (rect.height - drawnH) / 2) / scale
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export default function MapsPage(): JSX.Element {
  const { image, options, building, error, result, openDoors, setImage, setOptions, build, toggleDoor, setAllDoors, deleteMap } = useMapStore()
  const apiUrl = useAppStore((s) => s.apiUrl)
  const showToast = useAppStore((s) => s.showToast)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const onPick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const color = pickColor(e.currentTarget, e.clientX, e.clientY)
    if (color) { setOptions({ wallColor: color }); playSfx('toggle') }
  }, [setOptions])

  const allOpen = !!result && result.doors.length > 0 && result.doors.every((d) => openDoors[d.name])

  return (
    <div className="flex flex-1 gap-4 overflow-hidden p-4">
      <section className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto pr-1" aria-label="Build a map">
        <header>
          <h1 className="pp-title">Map Builder</h1>
          <p className="pp-subtitle mt-1">Turn a top-down map or floor plan into a 3D level with working doors.</p>
        </header>

        {options.walls === 'color' && image ? (
          <div className="flex flex-col gap-1.5">
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-accent/40 bg-black/20">
              <img src={image} alt="Map picture — click a wall to pick its colour" onClick={onPick}
                className="h-full w-full cursor-crosshair object-contain p-3" />
            </div>
            <p className="text-[11px] text-zinc-400">Click a wall in the picture to pick its colour.</p>
          </div>
        ) : (
          <ImageDropZone value={image} onChange={setImage} onError={setLocalError} label="Drop a map or floor plan" className="aspect-square w-full" />
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="map-name" className="pp-label">Name <span className="text-zinc-600">(optional)</span></label>
          <input id="map-name" className="pp-input" value={options.name} placeholder="Ground floor"
            onChange={(e) => setOptions({ name: e.target.value })} />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="pp-label">Walls in the picture are</span>
          <Segmented<WallMode>
            ariaLabel="Walls in the picture are"
            size="sm"
            value={options.walls}
            onChange={(walls) => setOptions({ walls })}
            options={[
              { value: 'auto', label: 'Auto', hint: 'PolyPal decides' },
              { value: 'dark', label: 'Dark', hint: 'Dark walls on a light background' },
              { value: 'light', label: 'Light', hint: 'Light walls on a dark background' },
              { value: 'color', label: 'Pick colour', hint: 'Click a wall in the picture' },
            ]}
          />
          {options.walls === 'color' && (
            <div className="flex items-center gap-3 pt-1">
              <span className="h-7 w-7 shrink-0 rounded-lg border border-white/20" style={{ background: options.wallColor ?? 'transparent' }} aria-label={`Wall colour ${options.wallColor ?? 'not picked'}`} />
              <label htmlFor="map-tolerance" className="text-xs text-zinc-400">Match</label>
              <input id="map-tolerance" type="range" min={0.04} max={0.5} step={0.01} value={options.tolerance}
                onChange={(e) => setOptions({ tolerance: Number(e.target.value) })} className="flex-1 accent-green-500" />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="map-width" className="pp-label">Map width (m)</label>
            <input id="map-width" type="number" min={2} max={2000} step={0.5} className="pp-input" placeholder="Auto"
              value={options.widthM ?? ''} onChange={(e) => setOptions({ widthM: e.target.value ? Number(e.target.value) : null })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="map-height" className="pp-label">Wall height (m)</label>
            <input id="map-height" type="number" min={0.5} max={50} step={0.1} className="pp-input"
              value={options.wallHeight} onChange={(e) => setOptions({ wallHeight: Number(e.target.value) || 2.7 })} />
          </div>
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-xl border border-white/[0.06] bg-black/20 px-3.5 py-2.5">
          <span>
            <span className="block text-sm text-zinc-200">Find doors</span>
            <span className="block text-[11px] text-zinc-500">Gaps in walls become doors that open</span>
          </span>
          <input type="checkbox" checked={options.doors} onChange={(e) => setOptions({ doors: e.target.checked })} className="h-4 w-4 accent-green-500" />
        </label>

        {building ? (
          <div className="pp-card flex flex-col gap-2 p-4" aria-live="polite">
            <p className="text-sm font-medium text-white">Building your map…</p>
            <div className="pp-skeleton h-1.5 rounded-full" />
          </div>
        ) : (
          <button type="button" className="pp-btn-primary py-3 text-[15px]" onClick={() => void build()}
            disabled={!image || (options.walls === 'color' && !options.wallColor)}>
            {result ? 'Rebuild map' : 'Build map'}
          </button>
        )}

        {(error || localError) && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error ?? localError}</p>}

        <p className="text-[11px] leading-relaxed text-zinc-500">
          Works best with clear top-down pictures: floor plans, dungeon maps, level layouts. Walls are assumed to be about
          20 cm thick to work out the size — set the width if you know it.
        </p>
      </section>

      <section className="pp-panel relative flex flex-1 flex-col overflow-hidden" aria-label="3D map">
        <div className="relative flex-1">
          {result ? (
            <MapViewer key={result.url} url={`${apiUrl}${result.url}`} size={result.size_m} openDoors={openDoors} onToggle={toggleDoor} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-zinc-400">Your 3D map will appear here</p>
              <p className="max-w-xs text-xs text-zinc-600">Then click any door to swing it open.</p>
            </div>
          )}
          {result && (
            <div className="absolute left-4 top-4 animate-rise-in rounded-xl border border-white/[0.08] bg-black/60 px-3 py-2 text-[11px] text-zinc-300 backdrop-blur">
              <p>{result.size_m[0]} × {result.size_m[2]} m · {result.doors.length} door{result.doors.length === 1 ? '' : 's'} · {result.wall_count} wall pieces</p>
            </div>
          )}
        </div>

        {result && (
          <div className="flex items-center gap-2 border-t border-white/[0.05] bg-surface-400/80 px-4 py-3">
            {result.doors.length > 0 && (
              <button type="button" className="pp-btn-ghost" onClick={() => { playSfx(allOpen ? 'close' : 'open'); setAllDoors(!allOpen) }} data-sfx="none">
                {allOpen ? 'Close all doors' : 'Open all doors'}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {confirmDelete ? (
                <>
                  <button type="button" className="pp-btn-danger" data-sfx="delete" onClick={() => { setConfirmDelete(false); void deleteMap() }}>Delete map</button>
                  <button type="button" className="pp-btn-ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
                </>
              ) : (
                <button type="button" className="pp-btn-ghost text-red-300" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
              <a className="pp-btn-ghost" href={`${apiUrl}${result.url}`} download={`${options.name.trim() || 'map'}.glb`}
                title="GLB keeps the doors as separate, animated parts for Blender, Unity, Unreal and Godot">Export GLB</a>
              <button type="button" className="pp-btn-primary" onClick={() => setSaving(true)}>Save to Library</button>
            </div>
          </div>
        )}
      </section>

      {saving && result && (
        <SaveToLibraryDialog
          source={result.url}
          defaultName={options.name.trim() || 'Map'}
          onClose={() => setSaving(false)}
          onSaved={(item) => showToast(`Saved “${item.name}” to your library`)}
        />
      )}
    </div>
  )
}
