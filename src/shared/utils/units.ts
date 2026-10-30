// Real-world units. Meshes are stored in metres (the glTF convention); these
// helpers convert for display and input. Keep UNIT_TO_METRES in sync with
// api/services/mesh_ops/transforms.py.

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'

export const UNIT_TO_METRES: Record<LengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
}

export const UNIT_LABELS: Record<LengthUnit, string> = {
  mm: 'Millimetres',
  cm: 'Centimetres',
  m: 'Metres',
  in: 'Inches',
  ft: 'Feet',
}

export const LENGTH_UNITS = Object.keys(UNIT_TO_METRES) as LengthUnit[]

export function isLengthUnit(value: unknown): value is LengthUnit {
  return typeof value === 'string' && value in UNIT_TO_METRES
}

export function fromMetres(metres: number, unit: LengthUnit): number {
  return metres / UNIT_TO_METRES[unit]
}

export function toMetres(value: number, unit: LengthUnit): number {
  return value * UNIT_TO_METRES[unit]
}

/** Up to `significant` digits, never in exponent form, trailing zeros trimmed. */
export function formatNumber(value: number, significant = 3): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const decimals = Math.max(0, Math.min(6, significant - 1 - magnitude))
  return value.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

export function formatLength(metres: number, unit: LengthUnit, significant = 3): string {
  return `${formatNumber(fromMetres(metres, unit), significant)} ${unit}`
}

export function formatArea(squareMetres: number, unit: LengthUnit): string {
  const factor = UNIT_TO_METRES[unit] ** 2
  return `${formatNumber(squareMetres / factor)} ${unit}²`
}

/** Volumes read best in cm³ / ml for small parts, in³ for imperial. */
export function formatVolume(cubicMetres: number, unit: LengthUnit): string {
  const factor = UNIT_TO_METRES[unit] ** 3
  return `${formatNumber(cubicMetres / factor)} ${unit}³`
}

/** "W × H × D" in the chosen unit. */
export function formatDimensions(extents: [number, number, number] | number[], unit: LengthUnit): string {
  return extents.slice(0, 3).map((e) => formatNumber(fromMetres(e, unit))).join(' × ') + ` ${unit}`
}

/** Unitless meshes (no real-world size set) are shown in neutral "units". */
export function formatUnitless(extents: number[]): string {
  return extents.slice(0, 3).map((e) => formatNumber(e)).join(' × ') + ' units'
}
