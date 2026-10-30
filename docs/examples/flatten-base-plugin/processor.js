// Example PolyPal Mesh Editor plugin: "Flatten Base".
//
// A process extension: PolyPal calls the exported function with the mesh to
// edit, the user's parameter values and a small context object, and expects a
// path to the edited mesh back. Because the manifest node declares
// `"editor"` (and takes and returns a mesh), it appears as a tool in the
// Generate page's Mesh Editor as well as a workflow node.
const path = require('path')
const fs = require('fs')
const { NodeIO } = require('@gltf-transform/core')
const { clearNodeTransform } = require('@gltf-transform/functions')

module.exports = async function flattenBase(input, params, context) {
  if (!input.filePath) throw new Error('Flatten Base needs a mesh')
  const share = Math.min(25, Math.max(0.5, Number(params.amount ?? 3))) / 100

  context.progress(10, 'Reading mesh…')
  const io = new NodeIO()
  const doc = await io.read(input.filePath)

  // Bake node transforms so "down" in the file is down in the viewer (Y-up).
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) clearNodeTransform(node)
  }

  const positions = doc.getRoot().listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .map((prim) => prim.getAttribute('POSITION'))
    .filter(Boolean)

  let minY = Infinity
  let maxY = -Infinity
  for (const accessor of positions) {
    for (let i = 0; i < accessor.getCount(); i++) {
      const y = accessor.getElement(i, [0, 0, 0])[1]
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minY) || maxY <= minY) throw new Error('The mesh has no height to flatten')

  const cut = minY + (maxY - minY) * share
  context.progress(50, `Flattening the bottom ${(share * 100).toFixed(1)}%…`)
  let moved = 0
  const v = [0, 0, 0]
  for (const accessor of positions) {
    for (let i = 0; i < accessor.getCount(); i++) {
      accessor.getElement(i, v)
      if (v[1] < cut) {
        v[1] = cut
        accessor.setElement(i, v)
        moved++
      }
    }
  }
  context.log(`Moved ${moved} vertices onto the base plane`)

  const outDir = path.join(context.workspaceDir, 'Edits')
  fs.mkdirSync(outDir, { recursive: true })
  const stem = path.basename(input.filePath).replace(/\.[^.]+$/, '')
  const outPath = path.join(outDir, `${stem}_flat_${Date.now()}.glb`)
  context.progress(85, 'Writing mesh…')
  await io.write(outPath, doc)
  context.progress(100, 'Done')
  return { filePath: outPath }
}
