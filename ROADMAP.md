# PolyPal 0.5 roadmap — delivered

PolyPal 0.5 is the first release after the rebrand from Modly 0.4.3. Every item below is
implemented, covered by tests where the logic is testable outside a GPU, and exercised end to end
in a browser smoke test of the built app.

## 01 · AI-powered mesh editing — describe edits in plain English and let AI apply them

| # | Task | Where |
|---|------|-------|
| 1 | New editing operations: remove floating pieces, fix normals, subdivide, rotate, mirror, scale, set real-world size, centre & ground (pure numpy topology — no scipy/networkx needed) | `api/services/mesh_ops/transforms.py`, `api/services/mesh_analysis.py` |
| 2 | Mesh statistics probe: size, pieces, holes, watertightness, non-manifold edges, area, volume, units | `GET /edit/stats` |
| 3 | Offline plain-English planner: phrase rules for counts ("5k", "30%"), sizes ("20 cm tall"), angles, axes and multi-step requests | `api/services/edit_planner.py` |
| 4 | AI planner: the copilot model proposes steps through a `propose_edit_plan` tool generated from the registry, falling back to the rules | `POST /edit/plan` |
| 5 | Plan validation: unknown operations rejected, unknown parameters dropped, values coerced and clamped to each schema | `validate_plan` |
| 6 | Atomic multi-step apply: steps run in a scratch directory, only the final mesh lands in the workspace | `POST /edit/apply` |
| 7 | Editable plan preview: review, tweak or remove steps before applying; labelled undo history | Mesh Editor → *AI edit*, *Versions* |
| 8 | Copilot integration: `edit_mesh`, `get_mesh_stats` and `list_mesh_operations` tools | `api/routers/agent.py` |

## 02 · Smarter AI copilot — streaming, safer tool execution, persistent conversations

| # | Task | Where |
|---|------|-------|
| 1 | Server-Sent-Events endpoint streaming tokens, reasoning, tool calls and results (one shared loop with the JSON endpoint) | `POST /agent/chat/stream` |
| 2 | Streaming chat UI with live tool cards and a stop button; `<think>` tags split correctly across chunks | `ChatPanel.tsx`, `services/copilot.py` |
| 3 | Risk-classified tools (read / write / heavy) with an approval policy and approval cards | `TOOL_RISK`, `POST /agent/tools/execute`, Settings → Agent |
| 4 | Argument validation and workspace-path containment; per-turn call budget, duplicate-call cut-off, per-tool timeouts | `validate_arguments` |
| 5 | Persistent conversations stored in the app data directory | `/agent/conversations` |
| 6 | Conversation history drawer (open, rename, delete) and context trimming for long chats | `ChatPanel.tsx`, `trim_history` |

## 03 · Extensible editor — a mesh editing panel and a plugin system

| # | Task | Where |
|---|------|-------|
| 1 | Dedicated Mesh Editor side panel (Editor button / `E`) | `src/areas/editor/MeshEditorPanel.tsx` |
| 2 | Schema-driven parameter forms shared by built-ins and plugins | `ParamForm.tsx` |
| 3 | Unified tool registry merging built-in operations and plugin tools | `src/areas/editor/editorTools.ts` |
| 4 | Plugin contract: process-extension nodes declare `"editor"` in their manifest | `electron/main/ipc-handlers.ts` |
| 5 | Authoring guide and a working example plugin (Flatten Base) | `docs/editor-plugins.md`, `docs/examples/flatten-base-plugin` |

## 04 · Visual diagnostics

| # | Task | Where |
|---|------|-------|
| 1 | Contact shadows | viewer toolbar, Settings → Application |
| 2 | Deviation heatmap against the previous version or the original (BVH closest-point, legend in real units) | `src/areas/generate/deviation.ts` |
| 3 | Before/after wipe with a draggable, screen-aligned split | `Viewer3D.tsx` |

## 05 · Generation provenance

| # | Task | Where |
|---|------|-------|
| 1 | Provenance sidecar for every generated or edited mesh: model + version, exact settings with a pinned seed, stored input image, timings, edit lineage | `api/services/provenance.py` |
| 2 | Lineage API and one-click regeneration with identical settings (or a new seed) | `GET /edit/provenance`, `POST /generate/regenerate` |
| 3 | Provenance panel: history timeline, Regenerate, Variation, copy settings | `ProvenanceSection.tsx` |

## 06 · GPU management

| # | Task | Where |
|---|------|-------|
| 1 | VRAM estimate before launch with a fit verdict next to Generate | `POST /gpu/estimate`, `LaunchCheck.tsx` |
| 2 | Automatic unloading: free other models before a launch that would not fit, and unload idle 3D models | `services/gpu.py`, Settings → Performance |
| 3 | Prioritised generation queue with live reordering and cancellation | `services/priority_queue.py`, `/generate/queue`, header queue menu |

## 07 · Real-world scale

| # | Task | Where |
|---|------|-------|
| 1 | Units preference and live W×H×D readout (labelled unitless until a size is set) | Settings → Application, viewer overlay |
| 2 | Set real-world size; sized models export in millimetres for slicers instead of being normalised | `scale_to_size`, `/optimize/export?units=`, slicer export |
| 3 | Measure tool: click two surface points for a distance in real units; area and volume in the editor | viewer toolbar, Mesh Editor stats |

## Simplified mode and redesign

| Feature | Where |
|---|---|
| Simplified (default) / Advanced modes, persisted; mode switch in the sidebar and Settings → General | `appStore.uiMode`, `navStore` |
| 3D Generate: Image to model (drop/paste/browse + optional details) and Text to model (prompt + up to 5 references) | `src/areas/create` |
| Local text-to-image via stable-diffusion.cpp, downloaded on demand, sharing the GPU queue | `api/services/image_engine.py`, `/images/*`, `src/areas/images` |
| Projection texturing into vertex colours, with Ask me / Yes / No per generation | `api/services/texturing.py`, `/texture/project` |
| Library with categories, tags, notes, thumbnails, export and reopen | `api/services/library.py`, `/library/*`, `src/areas/library` |
| Claude-style skills (SKILL.md, progressive disclosure via `load_skill` / `read_skill_file`) | `api/services/skills.py`, `/skills/*`, `src/areas/skills` |
| New visual design: deeper green-black surfaces, labelled sidebar, shared `pp-*` components | `globals.css`, `tailwind.config.js` |

| Map Builder: walls, textured floor, hinged doors with glTF open animations | `api/services/map_builder.py`, `/maps/build`, `src/areas/maps` |
| Texturing v2: spherical-harmonics de-lighting, highlight removal, grazing-angle weights, diffusion fill, optional back view | `api/services/texturing.py` |
| Delete generated models; tabs stay mounted; motion and Web Audio sounds; PolyPal names for models (credited in About) | `api/services/meshes.py`, `Router.tsx`, `utils/sfx.ts`, `branding.ts` |

Limits: without a back view, sides the picture can't see are estimated from nearby colour;
the Map Builder reads clear top-down pictures (not perspective screenshots) and finds doors as wall gaps; image generation needs the engine and a model downloaded (2–12 GB).

## Fixed along the way

- Decimate, smooth and exports dropped baked gizmo transforms (scene-graph node transforms were
  ignored when flattening); all callers now share `services/mesh_io.py`.
- `mcp>=1.0.0` resolved to mcp 2.x, which removed the API `mcp_server.py` uses; pinned to `<2`.
- Unexpected exceptions from mesh libraries surfaced as an opaque 500 that the UI reported as
  "cannot reach the API".
- The Performance settings page showed controls that were not connected to anything; it now shows
  real GPU status and policy.

## Ideas for next

- Selection-based editing (apply an operation to a painted region).
- Persist the undo history and versions across app restarts.
- VRAM measurement for AMD (ROCm SMI) and Apple Silicon unified memory.
- Per-extension VRAM profiles measured from real runs instead of declared values.
