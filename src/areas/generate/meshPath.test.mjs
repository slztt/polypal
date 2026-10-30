import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from '../../../scripts/load-ts-module.mjs'

const m = loadTsModule('src/areas/generate/meshPath.ts')

test('maps viewer URLs to API paths', () => {
  assert.equal(m.meshPathFromUrl('/workspace/Default/cat%20v2.glb'), 'Default/cat v2.glb')
  assert.equal(m.meshPathFromUrl('/optimize/serve-file?path=%2Ftmp%2Fa.glb'), '/tmp/a.glb')
  assert.equal(m.meshPathFromUrl(null), null)
})

test('classifies editable and workspace meshes', () => {
  assert.ok(m.isEditableMeshUrl('/workspace/Default/a.glb'))
  assert.ok(!m.isEditableMeshUrl('/workspace/Workflows/gs.ply'))
  assert.ok(!m.isEditableMeshUrl('/optimize/serve-file?path=%2Ftmp%2Fx%2Fsplat.splat'))
  assert.ok(m.isWorkspaceMeshUrl('/workspace/a.glb'))
  assert.ok(!m.isWorkspaceMeshUrl('/optimize/serve-file?path=x'))
})
