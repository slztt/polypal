import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { loadTsModule } from '../../../scripts/load-ts-module.mjs'

// Share one three.js instance with the module under test (instanceof checks).
const d = loadTsModule('src/areas/generate/deviation.ts', { external: ['three'] })
const THREE = createRequire(import.meta.url)('three')

function boxGroup(size, offset = [0, 0, 0], rootShift = [0, 0, 0]) {
  const root = new THREE.Group()
  root.position.set(...rootShift)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size, 4, 4, 4))
  mesh.position.set(...offset)
  root.add(mesh)
  return root
}

test('identical surfaces have zero deviation, regardless of viewer centring', () => {
  const result = d.computeDeviation(boxGroup(1, [0, 0, 0], [5, 0, 0]), boxGroup(1))
  assert.equal(result.colors.size, 1)
  assert.ok(result.stats.max < 1e-6, `max ${result.stats.max}`)
})

test('a uniformly grown box deviates by half the growth', () => {
  const result = d.computeDeviation(boxGroup(1.2), boxGroup(1))
  // Face vertices are 0.1 from the reference; corners are sqrt(3)*0.1.
  assert.ok(Math.abs(result.stats.max - 0.1 * Math.sqrt(3)) < 1e-5, `max ${result.stats.max}`)
  assert.ok(result.stats.mean >= 0.1 - 1e-6)
  const colors = [...result.colors.values()][0]
  assert.equal(colors.length % 3, 0)
})

test('colour ramp is clamped and runs from teal to red', () => {
  assert.deepEqual(d.deviationColor(-1), d.deviationColor(0))
  assert.deepEqual(d.deviationColor(5), [0.94, 0.27, 0.27])
  const [r0, , b0] = d.deviationColor(0)
  const [r1, , b1] = d.deviationColor(1)
  assert.ok(r1 > r0 && b0 > b1)
  assert.deepEqual(d.deviationColor(Number.NaN), d.deviationColor(0))
})

test('summary handles empty input', () => {
  assert.deepEqual(d.summarise([]), { max: 0, mean: 0, p95: 0 })
})
