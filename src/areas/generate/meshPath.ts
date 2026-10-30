// The viewer holds mesh *URLs*; the API's mesh routes want a path. Two URL
// shapes reach the viewer: workspace files (/workspace/<rel>) and imports from
// elsewhere on disk (/optimize/serve-file?path=<abs>).

const WORKSPACE_PREFIX = '/workspace/'
const SERVE_FILE_PREFIX = '/optimize/serve-file?path='

export function meshPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith(WORKSPACE_PREFIX)) return decodeURIComponent(url.slice(WORKSPACE_PREFIX.length))
  if (url.startsWith(SERVE_FILE_PREFIX)) return decodeURIComponent(url.slice(SERVE_FILE_PREFIX.length))
  return url
}

/** True for meshes PolyPal can edit (not Gaussian splats). */
export function isEditableMeshUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return !/\.(ply|splat)$/i.test(url.split('?')[0] ?? '') && !/\.splat$/i.test(url)
}

/** Workspace meshes carry provenance; imports from outside do not. */
export function isWorkspaceMeshUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith(WORKSPACE_PREFIX)
}
