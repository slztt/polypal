---
name: game-ready-asset
description: Optimise a model for a game engine (Unity, Unreal, Godot, Roblox) or real-time use. Use when the user mentions games, game engines, low poly, real-time, VR or performance budgets.
---
# Game-ready assets

1. Ask which use the asset has if it is unclear: **hero** (close-up, ~20k–50k triangles), **prop** (~2k–10k), or **background** (under 2k). Mobile and VR: halve those.
2. Clean up first: `remove_small_components`, then `fix_normals`.
3. Decimate to the budget with `decimate`. If the shape breaks down badly, suggest a less aggressive target instead of going lower.
4. Centre it and put it on the ground (`recenter`) so it imports with a sensible pivot.
5. Most engines use metres: if the user gives a real size, apply it with `scale_to_size` in metres or centimetres.
6. Recommend **GLB** export (keeps textures and works in Godot, Unity with glTFast, Unreal 5 and Blender).
