import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from '../../../scripts/load-ts-module.mjs'

const t = loadTsModule('src/areas/editor/editorTools.ts')

const ops = [
  { id: 'smooth', label: 'Smooth Mesh', description: 'Smooth', category: 'optimization', params_schema: [{ id: 'iterations', type: 'int', default: 5, min: 1, max: 50 }] },
  { id: 'rotate', label: 'Rotate', description: 'Rotate', category: 'transform', params_schema: [] },
  { id: 'remove_small_components', label: 'Remove Floating Pieces', description: 'Floaters', category: 'cleanup', params_schema: [] },
]

const extensions = [
  {
    type: 'process', id: 'retopo', name: 'Retopo', description: 'Quad retopology', trusted: true, builtin: false, entry: 'p.py',
    nodes: [
      { id: 'quad', name: 'Quad Remesh', input: 'mesh', output: 'mesh', paramsSchema: [], editor: { category: 'topology' } },
      { id: 'hidden', name: 'Not a tool', input: 'mesh', output: 'mesh', paramsSchema: [] },
      { id: 'img', name: 'Image node', input: 'image', output: 'mesh', paramsSchema: [], editor: {} },
    ],
  },
  { type: 'process', id: 'broken', name: 'Broken', corrupted: true, trusted: false, builtin: false, entry: 'p.py',
    nodes: [{ id: 'x', name: 'X', input: 'mesh', output: 'mesh', paramsSchema: [], editor: {} }] },
]

test('merges built-ins with opted-in mesh→mesh plugin nodes only', () => {
  const tools = t.buildEditorTools(ops, extensions)
  assert.deepEqual(tools.map((x) => x.key), [
    'builtin:smooth', 'builtin:rotate', 'builtin:remove_small_components', 'plugin:retopo/quad',
  ])
  const plugin = tools.at(-1)
  assert.equal(plugin.label, 'Quad Remesh')
  assert.equal(plugin.description, 'Quad retopology')
  assert.equal(plugin.category, 'topology')
})

test('groups in workflow order and filters by text', () => {
  const groups = t.groupEditorTools(t.buildEditorTools(ops, extensions))
  assert.deepEqual(groups.map((g) => g.category), ['cleanup', 'optimization', 'topology', 'transform'])
  assert.equal(groups[0].label, 'Clean up')
  assert.deepEqual(t.filterEditorTools(t.buildEditorTools(ops, []), 'float').map((x) => x.opId), ['remove_small_components'])
})

test('param defaults and coercion mirror the backend clamps', () => {
  const param = { id: 'iterations', type: 'int', default: 5, min: 1, max: 50 }
  assert.deepEqual(t.defaultParams([param]), { iterations: 5 })
  assert.equal(t.coerceParam(param, '120'), 50)
  assert.equal(t.coerceParam(param, '2.6'), 3)
  assert.equal(t.coerceParam(param, 'abc'), 5)
  assert.equal(t.coerceParam({ id: 'f', type: 'float', default: 1 }, '0,5'), 0.5)
  assert.equal(t.coerceParam({ id: 'b', type: 'boolean', default: false }, 'true'), true)
})
