# PolyPal architecture

PolyPal is an Electron desktop app with a React renderer and a local FastAPI backend.

```
┌───────────── Electron main (electron/main) ─────────────┐
│ window, IPC, extension install, process runner,         │
│ settings, GPU detection, starts the Python backend      │
└──────────────┬──────────────────────────┬───────────────┘
               │ preload bridge           │ spawns
┌──────────────▼───────────┐   HTTP   ┌───▼──────────────────────────────┐
│ Renderer (src/)          │ ───────▶ │ FastAPI backend (api/) :8765      │
│ React + zustand + R3F    │  SSE ◀── │ generation, mesh ops, copilot,    │
└──────────────────────────┘          │ provenance, GPU, LLM server pool  │
                                      └───┬──────────────────────────────┘
                                          │ subprocesses
                                  extension runners · llama.cpp servers
```

## Renderer (`src/`)

| Area | What lives there |
|------|------------------|
| `areas/generate` | Generate page: workflow panel, copilot chat, 3D viewer (`Viewer3D.tsx`) with diagnostics, queue/GPU menu |
| `areas/editor` | Mesh Editor panel, unified tool registry, provenance section, editing hooks |
| `areas/workflows` | Node-graph workflow editor and runner (`workflowRunStore.ts`) |
| `areas/models`, `areas/settings`, `areas/setup` | Extensions page, settings, first-run setup |
| `shared/api/polypalApi.ts` | Typed client for the editing, provenance, GPU, queue and copilot routes |
| `shared/stores` | zustand stores; `appStore` holds the current job, undo history and preferences |
| `shared/utils` | units, SSE parsing, formatting |

Pure logic modules (units, SSE, deviation, editor tools, mesh paths) have `*.test.mjs` tests that
bundle the TypeScript with esbuild (`scripts/load-ts-module.mjs`).

## Backend (`api/`)

| Module | Responsibility |
|--------|----------------|
| `routers/generation.py` | Image/artifact → 3D jobs, priority queue, regenerate |
| `routers/edit.py` | Operation catalogue, mesh stats, plan, atomic apply, provenance read |
| `routers/optimize.py`, `routers/export.py` | Single operations, import, format/slicer export |
| `routers/agent.py` | Copilot loop (JSON + SSE), tool registry, approvals, conversations |
| `routers/gpu.py` | VRAM status, launch estimates, unloading policy |
| `services/mesh_ops/` | Mesh-operation registry used by the API, the editor and workflow nodes |
| `services/mesh_analysis.py`, `services/mesh_io.py` | Numpy topology algorithms; scene flattening that keeps node transforms |
| `services/edit_planner.py` | Phrase-rule planner, plan validation, LLM planning tool |
| `services/provenance.py` | Sidecar records, seed pinning, input storage, lineage |
| `services/gpu.py`, `services/priority_queue.py` | VRAM planning and the single-worker priority queue |
| `services/copilot.py`, `services/conversations.py` | Tool risk/validation, streaming helpers, chat storage |
| `services/generator_registry.py`, `services/extension_process.py` | Model extensions and their subprocesses |
| `services/llm_server.py` | Managed llama.cpp server pool for the local copilot |

## Data on disk

- **Workspace** — generated and edited meshes, each with a `<mesh>.provenance.json` sidecar;
  input images are kept content-addressed under `.polypal/inputs/`.
- **App data** (`userData`) — settings, extensions, the agent directory (`agent/`: llama.cpp,
  GGUF models, `conversations/`).

Scene units are metres (the glTF convention). A mesh is "real-world sized" once
`scale_to_size` has run on it or an ancestor; the provenance `units` field records that and the
slicer export converts to millimetres.

## Compatibility with Modly

PolyPal is based on Modly 0.4.3. Extensions written for Modly keep working: the app still reads the
Modly extension registry, exports `MODLY_*` environment variables alongside `POLYPAL_*` ones, accepts
`MODLY_*` overrides, and keeps the `modly.scene-manifest.v1` scene schema id.
