// Surface deviation between two versions of a mesh: for every vertex of the
// edited mesh, the distance to the closest point on the reference surface.
// Coordinates are the file's own (scene-graph transforms applied, viewer
// centring ignored), so the numbers are in model units — metres when the
// model has a real-world size.
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

export interface DeviationStats {
  max: number
  mean: number
  p95: number
}

/** Positions of every mesh under `root`, in root-local space, merged into one geometry. */
export function bakeLocalGeometry(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true)
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const positions: number[] = []
  const indices: number[] = []
  const v = new THREE.Vector3()
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const geometry = child.geometry as THREE.BufferGeometry
    const position = geometry.attributes.position
    if (!position) return
    const matrix = new THREE.Matrix4().multiplyMatrices(toLocal, child.matrixWorld)
    const offset = positions.length / 3
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(matrix)
      positions.push(v.x, v.y, v.z)
    }
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) indices.push(offset + geometry.index.getX(i))
    } else {
      for (let i = 0; i < position.count; i++) indices.push(offset + i)
    }
  })
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  merged.setIndex(indices)
  return merged
}

/**
 * Distance from each vertex of `mesh` (positions transformed by `matrix` into
 * the reference's space) to the closest point of `reference`.
 */
export function vertexDeviation(
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  matrix: THREE.Matrix4,
  bvh: MeshBVH,
): Float32Array {
  const distances = new Float32Array(positions.count)
  const point = new THREE.Vector3()
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i).applyMatrix4(matrix)
    const result = bvh.closestPointToPoint(point, hit)
    distances[i] = result ? result.distance : 0
  }
  return distances
}

export function summarise(all: Float32Array[]): DeviationStats {
  let count = 0
  let sum = 0
  let max = 0
  for (const d of all) {
    for (let i = 0; i < d.length; i++) {
      sum += d[i]
      if (d[i] > max) max = d[i]
    }
    count += d.length
  }
  if (count === 0) return { max: 0, mean: 0, p95: 0 }
  // p95 from a strided sample keeps this cheap on million-vertex meshes.
  const stride = Math.max(1, Math.floor(count / 50_000))
  const sample: number[] = []
  let k = 0
  for (const d of all) for (let i = 0; i < d.length; i++, k++) if (k % stride === 0) sample.push(d[i])
  sample.sort((a, b) => a - b)
  return { max, mean: sum / count, p95: sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.95))] }
}

/** Colour ramp: 0 → deep teal, mid → amber, ≥ 1 → red. Returns linear RGB in [0,1]. */
export function deviationColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.07, 0.36, 0.33]],
    [0.25, [0.13, 0.77, 0.37]],
    [0.55, [0.98, 0.75, 0.14]],
    [1.0, [0.94, 0.27, 0.27]],
  ]
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]
    const [p0, c0] = stops[i - 1]
    if (x <= p1) {
      const f = (x - p0) / (p1 - p0)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return stops[stops.length - 1][1]
}

export interface DeviationResult {
  stats: DeviationStats
  /** Per-mesh vertex colours, keyed by mesh uuid. */
  colors: Map<string, Float32Array>
  /** Scale used for the colour ramp (the p95, so outliers don't wash it out). */
  scale: number
}

/** Deviation of every mesh under `edited` from the surface under `reference`. */
export function computeDeviation(edited: THREE.Object3D, reference: THREE.Object3D): DeviationResult {
  const referenceGeometry = bakeLocalGeometry(reference)
  const bvh = new MeshBVH(referenceGeometry)
  edited.updateMatrixWorld(true)
  const toLocal = new THREE.Matrix4().copy(edited.matrixWorld).invert()
  const perMesh: { uuid: string; distances: Float32Array }[] = []
  edited.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry.attributes.position) return
    const matrix = new THREE.Matrix4().multiplyMatrices(toLocal, child.matrixWorld)
    perMesh.push({ uuid: child.uuid, distances: vertexDeviation(child.geometry.attributes.position, matrix, bvh) })
  })
  referenceGeometry.dispose()
  const stats = summarise(perMesh.map((m) => m.distances))
  const scale = stats.p95 > 0 ? stats.p95 : stats.max || 1
  const colors = new Map<string, Float32Array>()
  for (const { uuid, distances } of perMesh) {
    const rgb = new Float32Array(distances.length * 3)
    for (let i = 0; i < distances.length; i++) {
      const [r, g, b] = deviationColor(distances[i] / scale)
      rgb[i * 3] = r
      rgb[i * 3 + 1] = g
      rgb[i * 3 + 2] = b
    }
    colors.set(uuid, rgb)
  }
  return { stats, colors, scale }
}
