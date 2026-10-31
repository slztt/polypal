// Subtle interface sounds, synthesised with Web Audio so there are no sound
// files to ship. Every sound is short, quiet and soft-edged; the user can turn
// them off or change the volume in Settings → General.
import { useAppStore } from '@shared/stores/appStore'

export type Sfx = 'click' | 'toggle' | 'tab' | 'success' | 'error' | 'drop' | 'open' | 'close' | 'delete'

let ctx: AudioContext | null = null
let lastPlayed = 0

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** One soft enveloped tone. */
function tone(ac: AudioContext, out: AudioNode, freq: number, start: number, dur: number, peak: number, type: OscillatorType = 'sine', glideTo?: number): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain).connect(out)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

export function playSfx(name: Sfx): void {
  const { soundEnabled, soundVolume } = useAppStore.getState()
  if (!soundEnabled || soundVolume <= 0) return
  const ac = audio()
  if (!ac) return
  const now = ac.currentTime
  // Rapid repeats (double clicks, key repeat) would just buzz.
  if (name === 'click' && now - lastPlayed < 0.04) return
  lastPlayed = now

  const master = ac.createGain()
  master.gain.value = soundVolume * 0.6
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 5000
  master.connect(filter).connect(ac.destination)

  switch (name) {
    case 'click':   tone(ac, master, 1800, now, 0.035, 0.05, 'triangle', 1200); break
    case 'toggle':  tone(ac, master, 900, now, 0.06, 0.06, 'sine', 1300); break
    case 'tab':     tone(ac, master, 620, now, 0.07, 0.045, 'sine', 760); break
    case 'open':    tone(ac, master, 520, now, 0.09, 0.05, 'sine', 820); break
    case 'close':   tone(ac, master, 820, now, 0.09, 0.05, 'sine', 520); break
    case 'drop':    tone(ac, master, 300, now, 0.12, 0.09, 'sine', 160); tone(ac, master, 1200, now + 0.01, 0.05, 0.03, 'triangle'); break
    case 'delete':  tone(ac, master, 420, now, 0.14, 0.07, 'triangle', 180); break
    case 'success':
      tone(ac, master, 660, now, 0.18, 0.07)
      tone(ac, master, 880, now + 0.09, 0.22, 0.07)
      tone(ac, master, 1320, now + 0.18, 0.32, 0.05)
      break
    case 'error':
      tone(ac, master, 330, now, 0.16, 0.08, 'triangle')
      tone(ac, master, 247, now + 0.12, 0.22, 0.08, 'triangle')
      break
  }
}

/**
 * Click sounds for every button, switch and link in the app, installed once.
 * Elements opt out with `data-sfx="none"` or pick another sound with `data-sfx="<name>"`.
 */
export function installGlobalSfx(): () => void {
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const el = (e.target as Element | null)?.closest?.('button, [role="switch"], [role="tab"], a, summary, select, input[type="checkbox"], input[type="radio"]')
    if (!el || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return
    const custom = el.closest('[data-sfx]')?.getAttribute('data-sfx')
    if (custom === 'none') return
    const role = el.getAttribute('role')
    playSfx((custom as Sfx | null) ?? (role === 'switch' || el.matches('input[type="checkbox"]') ? 'toggle' : 'click'))
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  return () => window.removeEventListener('pointerdown', onPointerDown, true)
}
