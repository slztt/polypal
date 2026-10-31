---
name: print-ready
description: Prepare a model for 3D printing. Use when the user mentions 3D printing, a printer, a slicer, STL files or making a model printable.
---
# Print-ready models

Follow these steps in order, using edit_mesh. Check the result with get_mesh_stats after each change.

1. **Clean up.** Remove floating pieces (`remove_small_components`), then `repair` to close holes, then `fix_normals`.
2. **Check it is watertight.** If get_mesh_stats still reports open edges, run `repair` once more and tell the user if holes remain — slicers can usually fix small ones.
3. **Set a real size.** If no real-world size is set, ask the user how tall the print should be. Never guess a size silently. Use `scale_to_size` with their unit.
4. **Stand it on the build plate.** Run `recenter` so the model rests on the ground.
5. **Keep the triangle count sensible.** If it has more than 300,000 triangles, decimate to about 200,000 — slicers get slow above that and printers can't show the difference.
6. Tell the user to export as **STL** (exports are in millimetres once a size is set) and mention that STL has no colour.

See `checklist.md` if the user asks what makes a model printable.
