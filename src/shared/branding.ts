// PolyPal names for the third-party AI models and plugins it runs. The
// original projects are still credited in Settings → About → Open-source
// models (their licences require it); everywhere else the app shows these.

interface Brand { match: RegExp; name: string | ((found: string) => string); basedOn: string }

// Order matters: more specific patterns first.
export const BRANDS: Brand[] = [
  { match: /hunyuan\s*3d[\s-]*2?[\s-]*mini[\s-]*turbo/i, name: 'PolyPal 3D Detail Turbo', basedOn: 'Hunyuan3D 2 Mini Turbo (Tencent)' },
  { match: /hunyuan\s*3d[\s-]*2?[\s-]*mini[\s-]*fast/i, name: 'PolyPal 3D Detail Fast', basedOn: 'Hunyuan3D 2 Mini Fast (Tencent)' },
  { match: /hunyuan\s*3d[\w\s.-]*/i, name: 'PolyPal 3D Detail', basedOn: 'Hunyuan3D 2 (Tencent)' },
  { match: /triposg/i, name: 'PolyPal 3D Standard', basedOn: 'TripoSG (VAST AI)' },
  { match: /triposr/i, name: 'PolyPal 3D Lite', basedOn: 'TripoSR (Stability AI & Tripo)' },
  { match: /trellis[\s-]*2?([\s-]*gguf)?/i, name: 'PolyPal 3D Textured', basedOn: 'TRELLIS (Microsoft)' },
  { match: /stable[\s-]*fast[\s-]*3d|\bsf3d\b/i, name: 'PolyPal 3D Fast', basedOn: 'Stable Fast 3D (Stability AI)' },
  { match: /spar3d/i, name: 'PolyPal 3D Point', basedOn: 'SPAR3D (Stability AI)' },
  { match: /flux\.?1?[\s-]*kontext/i, name: 'PolyPal Image Pro', basedOn: 'FLUX.1 Kontext [dev] (Black Forest Labs)' },
  { match: /sdxl[\s-]*turbo/i, name: 'PolyPal Image', basedOn: 'SDXL Turbo (Stability AI)' },
  { match: /\bsd[\s-]*turbo/i, name: 'PolyPal Image Lite', basedOn: 'SD Turbo (Stability AI)' },
  { match: /stable[\s-]*diffusion\.cpp/i, name: 'PolyPal Image Engine', basedOn: 'stable-diffusion.cpp (leejet)' },
  { match: /llama\.cpp/i, name: 'PolyPal Assistant Engine', basedOn: 'llama.cpp (ggml-org)' },
  { match: /cadquery[\s-]*coder[\w\s().-]*/i, name: 'PolyPal CAD Assistant', basedOn: 'CadQuery Coder' },
  { match: /qwen[\s-]*3(\.5)?[\s-]*vl[\s-]*8b[\w\s(),.-]*/i, name: 'PolyPal Vision Assistant', basedOn: 'Qwen3-VL 8B (Alibaba)' },
  { match: /qwen[\s-]*3(\.5)?[\s-]*vl[\s-]*4b[\w\s(),.-]*/i, name: 'PolyPal Vision Assistant Lite', basedOn: 'Qwen3-VL 4B (Alibaba)' },
  { match: /gpt[\s-]*oss[\s-]*20b[\w\s().-]*/i, name: 'PolyPal Assistant Max', basedOn: 'gpt-oss-20b (OpenAI)' },
  { match: /qwen[\s-]*3(\.5)?[\s-]*\d+b[\w\s.-]*/i, name: (found) => `PolyPal Assistant${/qwen[\s-]*3\.5/i.test(found) ? ' 2' : ''} · ${/(\d+)\s*b/i.exec(found.replace(/qwen[\s-]*3(\.5)?/i, ''))?.[1] ?? ''}B${/instruct/i.test(found) ? ' Instruct' : ''}`, basedOn: 'Qwen3 (Alibaba)' },
  { match: /\bmodly\b/i, name: 'PolyPal', basedOn: 'Modly (Lightning Pixel)' },
]

/** Replace third-party model names inside any text with PolyPal names. */
export function brandText(text: string | null | undefined): string {
  if (!text) return text ?? ''
  let out = text
  for (const brand of BRANDS) {
    out = out.replace(new RegExp(brand.match.source, brand.match.flags.includes('g') ? brand.match.flags : `${brand.match.flags}g`),
      (found: string) => `${typeof brand.name === 'function' ? brand.name(found) : brand.name}${/\s$/.test(found) ? ' ' : ''}`)
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** PolyPal name for a model/plugin; unknown plugins become "PolyPal Model Plugin". */
export function brandName(name: string | null | undefined, fallbackIndex?: number): string {
  const branded = brandText(name)
  if (branded && branded !== (name ?? '').trim()) return branded
  if (/polypal/i.test(branded)) return branded
  return fallbackIndex !== undefined ? `PolyPal Model Plugin ${fallbackIndex + 1}` : 'PolyPal Model Plugin'
}

/** The original project a PolyPal name is built on, for credits. */
export function basedOn(name: string | null | undefined): string | null {
  if (!name) return null
  return BRANDS.find((b) => b.match.test(name))?.basedOn ?? null
}
