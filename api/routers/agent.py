"""
Copilot endpoints — a tool-use loop against PolyPal's API, on the managed local
llama.cpp server or any OpenAI-compatible provider.

* ``POST /agent/chat``          — one JSON answer (kept for the MCP/CLI clients).
* ``POST /agent/chat/stream``   — the same loop as Server-Sent Events: tokens,
  reasoning, tool calls and results arrive as they happen.
* ``POST /agent/tools/execute`` — runs a tool the user approved in the UI.
* ``/agent/conversations``      — persistent chat history.

Every tool call is validated against its schema, classified by risk, and —
depending on the caller's approval policy — either executed or returned to the
UI as a pending action for the user to approve.
"""
import asyncio
import json
import re
import time
import uuid
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services import conversations, copilot, llm_server
from services.app_info import APP_NAME
from services.llm_server import llama_pool

router = APIRouter(prefix="/agent", tags=["agent"])

POLYPAL_API = "http://localhost:8765"

SYSTEM_PROMPT = f"""\
You are {APP_NAME} Copilot, the built-in assistant of {APP_NAME}, a desktop app for
AI image-to-3D generation, mesh editing and workflow automation. You act on the
user's scene through tools.

## Tools

Inspect (always allowed):
- **get_mesh_info** — path and triangle count of the mesh in the viewer.
- **get_mesh_stats** — dimensions, pieces, holes, watertightness, real-world units.
- **list_mesh_operations** — the mesh-editing operations and their parameters.
- **get_provenance** — how the current model was generated and edited.
- **list_models** / **list_workflows** / **get_generation_status** / **get_gpu_status**.

Change things (new mesh versions; the user can undo):
- **edit_mesh(steps | instruction)** — apply mesh operations. Prefer explicit
  `steps` using ids from list_mesh_operations, e.g.
  [{{"op": "remove_small_components"}}, {{"op": "scale_to_size", "params": {{"dimension": "height", "size": 20, "unit": "cm"}}}}].
- **decimate_mesh** / **smooth_mesh** — quick single operations.
- **create_workflow(name, input_type, steps, description?)** — build a workflow from
  extension ids listed under "Available extensions".

Heavy (use the GPU or discard loaded state):
- **run_workflow(workflow_id)** — an attached image is used as its input.
- **regenerate_model(new_seed?)** — re-run the current model's generation with its original settings.
- **unload_models** — free GPU memory.

## Rules

- Act with tools; never just describe what you would do.
- Some actions need the user's approval. If a tool result says it is awaiting
  approval, tell the user in one sentence what you proposed and stop.
- Use workspace-relative mesh paths exactly as get_mesh_info returns them.
- Sizes are real-world: use scale_to_size with an explicit unit.
- For create_workflow use ONLY extension ids from "Available extensions";
  `input_type` is exactly `image`, `text` or `mesh`.
- After acting, summarise what changed in one sentence.
- Reply in the user's language. Be concise.\
"""

MAX_ROUNDS = 10
TOOL_TIMEOUTS = {"edit_mesh": 600.0, "decimate_mesh": 300.0, "smooth_mesh": 300.0, "regenerate_model": 30.0}
DEFAULT_TOOL_TIMEOUT = 120.0

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "List all available 3D generation models that are downloaded and ready.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "unload_models",
            "description": "Unload all 3D generation models from VRAM to free GPU memory.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_mesh_info",
            "description": "Get information about the current mesh loaded in the 3D viewer (triangle count, path, etc.).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "decimate_mesh",
            "description": "Reduce the polygon count of the current mesh using quadric edge collapse.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file (e.g. 'Default/mesh.glb'). Use get_mesh_info to obtain it.",
                    },
                    "target_faces": {
                        "type": "integer",
                        "description": "Target number of faces after decimation.",
                    },
                },
                "required": ["path", "target_faces"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "smooth_mesh",
            "description": "Apply Laplacian smoothing to the current mesh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                    "iterations": {
                        "type": "integer",
                        "description": "Number of smoothing iterations (1–20). More = smoother but loses detail.",
                    },
                },
                "required": ["path", "iterations"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_generation_status",
            "description": "Poll the status of an ongoing 3D generation job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Job ID returned by a previous generation call."},
                },
                "required": ["job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_workflows",
            "description": "List all workflows available in PolyPal.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_workflow",
            "description": "Execute a PolyPal workflow by its ID. The workflow runs in the background; progress is shown in the app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "The workflow ID to execute. Use list_workflows to get available IDs."},
                },
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_workflow",
            "description": (
                "Create a new PolyPal workflow from an ordered list of steps. "
                "Each step references an extension by its exact id (see 'Available extensions' in context). "
                "Steps run in sequence; do not include the input itself as a step."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short human-readable name for the workflow."},
                    "description": {"type": "string", "description": "Optional one-line description of what the workflow does."},
                    "input_type": {
                        "type": "string",
                        "enum": ["image", "text", "mesh"],
                        "description": (
                            "The workflow's input source node. Exactly one of: "
                            "'image' (Image node), 'text' (Text node), "
                            "'mesh' (Load 3D Mesh node, uses the current scene mesh). "
                            "Never use any other value."
                        ),
                    },
                    "steps": {
                        "type": "array",
                        "description": "Ordered processing steps. Each runs after the previous one.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "extension_id": {
                                    "type": "string",
                                    "description": "Exact extension id from 'Available extensions' (e.g. 'mesh-optimizer/optimize').",
                                },
                                "params": {
                                    "type": "object",
                                    "description": "Optional param overrides, keyed by param id. Omit to use defaults.",
                                },
                            },
                            "required": ["extension_id"],
                        },
                    },
                },
                "required": ["name", "input_type", "steps"],
            },
        },
    },
]

_MESH_PATH = {
    "type": "string",
    "description": "Workspace-relative mesh path (from get_mesh_info). Omit to use the current mesh.",
}

EXTRA_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_mesh_stats",
            "description": "Measure the mesh: triangle/vertex counts, size in metres (W×H×D), connected pieces, holes (boundary edges), watertightness, volume and whether a real-world size is set.",
            "parameters": {"type": "object", "properties": {"path": _MESH_PATH}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_mesh_operations",
            "description": "List the mesh-editing operations available to edit_mesh, with their parameters.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_mesh",
            "description": (
                "Apply one or more mesh operations to the current mesh as a new, undoable version. "
                "Pass explicit `steps` (preferred) or a plain-English `instruction`."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "Ordered operations: [{op, params}] with op ids from list_mesh_operations.",
                        "items": {
                            "type": "object",
                            "properties": {"op": {"type": "string"}, "params": {"type": "object"}},
                            "required": ["op"],
                        },
                    },
                    "instruction": {"type": "string", "description": "Plain-English edit, used when steps is omitted."},
                    "path": _MESH_PATH,
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_provenance",
            "description": "How the current model was made: generation model, settings, seed, and every edit since.",
            "parameters": {"type": "object", "properties": {"path": _MESH_PATH}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "regenerate_model",
            "description": "Re-run the generation the current model came from, with exactly the same model, settings and input image.",
            "parameters": {
                "type": "object",
                "properties": {
                    "new_seed": {"type": "boolean", "description": "Use a fresh random seed instead of the recorded one."},
                    "path": _MESH_PATH,
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_gpu_status",
            "description": "GPU memory in use and free, and which 3D models / local LLMs are loaded.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

# Bounds the backend enforces anyway; declaring them lets validation clamp early.
for _tool in TOOLS:
    _props = _tool["function"]["parameters"].get("properties", {})
    if _tool["function"]["name"] == "decimate_mesh":
        _props["target_faces"].update(minimum=100, maximum=500_000)
    if _tool["function"]["name"] == "smooth_mesh":
        _props["iterations"].update(minimum=1, maximum=20)

TOOLS = TOOLS + EXTRA_TOOLS
TOOL_SCHEMAS = copilot.extract_schemas(TOOLS)


# Input kinds the agent may pick, mapped to the real PolyPal source-node types.
# Keep this in sync with the node palette in WorkflowsPage.tsx.
INPUT_NODES = {
    "image": {"type": "imageNode", "data": {"enabled": True, "params": {}, "showInGenerate": True}},
    "text":  {"type": "textNode",  "data": {"enabled": True, "params": {}}},
    "mesh":  {"type": "meshNode",  "data": {"enabled": True, "params": {"source": "current"}}},
}


def _build_workflow_graph(name: str, description: str, input_type: str, steps: list[dict]) -> dict:
    """Assemble a PolyPal workflow graph (nodes + edges) from a simplified step spec.

    Layout: one source node (Image / Text / Load 3D Mesh), one extensionNode per
    step, then an Add-to-Scene output node, all wired in a single linear chain with
    workflowEdge edges. id/timestamps are left for the frontend to stamp
    (crypto.randomUUID + ISO date), matching how the Workflows tab creates workflows.
    """
    spec = INPUT_NODES.get(input_type, INPUT_NODES["image"])
    input_node = {
        "id": uuid.uuid4().hex[:8],
        "type": spec["type"],
        "position": {"x": 250, "y": 50},
        "data": {**spec["data"]},
    }

    ext_nodes = []
    for i, step in enumerate(steps):
        ext_nodes.append({
            "id": uuid.uuid4().hex[:8],
            "type": "extensionNode",
            "position": {"x": 250, "y": 150 + i * 200},
            "data": {
                "extensionId": step["extension_id"],
                "enabled": True,
                "params": step.get("params") or {},
            },
        })

    output_node = {
        "id": uuid.uuid4().hex[:8],
        "type": "outputNode",
        "position": {"x": 250, "y": 150 + len(steps) * 200},
        "data": {"enabled": True, "params": {}},
    }

    all_nodes = [input_node, *ext_nodes, output_node]
    edges = [
        {
            "id": f"e-{all_nodes[i]['id']}-{all_nodes[i + 1]['id']}",
            "source": all_nodes[i]["id"],
            "target": all_nodes[i + 1]["id"],
            "type": "workflowEdge",
        }
        for i in range(len(all_nodes) - 1)
    ]

    return {"name": name, "description": description, "nodes": all_nodes, "edges": edges}



# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------

class ToolOutcome:
    def __init__(self, text: str, payload: Optional[dict] = None, ok: bool = True) -> None:
        self.text, self.payload, self.ok = text, payload, ok


def _mesh_path(arguments: dict, context: dict) -> Optional[str]:
    return arguments.get("path") or context.get("currentMeshPath")


def _fmt_metres(value: float) -> str:
    if value >= 1:
        return f"{value:.3g} m"
    if value >= 0.01:
        return f"{value * 100:.3g} cm"
    return f"{value * 1000:.3g} mm"


async def _run_tool(name: str, arguments: dict, context: dict) -> ToolOutcome:
    timeout = TOOL_TIMEOUTS.get(name, DEFAULT_TOOL_TIMEOUT)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            if name == "list_models":
                r = await client.get(f"{POLYPAL_API}/model/all")
                r.raise_for_status()
                models = [m for m in r.json() if m.get("downloaded")]
                if not models:
                    return ToolOutcome("No models downloaded yet.")
                lines = "\n".join(f"- {m['id']}: {m.get('name', m['id'])}" for m in models)
                return ToolOutcome(f"Available models:\n{lines}")

            if name == "unload_models":
                r = await client.post(f"{POLYPAL_API}/model/unload-all")
                r.raise_for_status()
                return ToolOutcome("All 3D generation models have been unloaded from VRAM.")

            if name == "get_mesh_info":
                mesh_path = context.get("currentMeshPath")
                mesh_triangles = context.get("meshTriangles")
                if not mesh_path:
                    return ToolOutcome("No mesh currently loaded in the viewer.")
                info = f"Current mesh: {mesh_path}"
                if mesh_triangles:
                    info += f" ({mesh_triangles:,} triangles)"
                return ToolOutcome(info)

            if name == "get_mesh_stats":
                path = _mesh_path(arguments, context)
                if not path:
                    return ToolOutcome("No mesh currently loaded in the viewer.", ok=False)
                r = await client.get(f"{POLYPAL_API}/edit/stats", params={"path": path})
                r.raise_for_status()
                s = r.json()
                w, h, d = s.get("extents") or [0, 0, 0]
                text = (
                    f"{s['faces']:,} triangles, {s['vertices']:,} vertices. "
                    f"Size W×H×D: {_fmt_metres(w)} × {_fmt_metres(h)} × {_fmt_metres(d)}"
                    f"{' (real-world size set)' if s.get('units') == 'm' else ' (no real-world size set; units are arbitrary)'}. "
                    f"{s['components']} connected piece(s); "
                    + ("watertight" if s.get("watertight") else f"open with {s['boundary_edges']} boundary edges")
                    + (f"; {s['non_manifold_edges']} non-manifold edges" if s.get("non_manifold_edges") else "")
                    + "."
                )
                return ToolOutcome(text, {"type": "mesh_stats", "stats": s})

            if name == "list_mesh_operations":
                r = await client.get(f"{POLYPAL_API}/edit/ops")
                r.raise_for_status()
                lines = []
                for op in r.json():
                    params = ", ".join(
                        f"{p['id']}"
                        + (f"=[{'|'.join(str(o['value']) for o in p.get('options', []))}]" if p.get("type") == "select" else f":{p.get('type')}")
                        for p in op.get("params_schema", [])
                    )
                    lines.append(f"- {op['id']}: {op.get('description') or op['label']} ({params or 'no params'})")
                return ToolOutcome("Mesh operations:\n" + "\n".join(lines))

            if name == "edit_mesh":
                path = _mesh_path(arguments, context)
                if not path:
                    return ToolOutcome("No mesh currently loaded in the viewer.", ok=False)
                steps = arguments.get("steps") or []
                instruction = arguments.get("instruction")
                if not steps:
                    if not instruction:
                        return ToolOutcome("Provide steps or an instruction.", ok=False)
                    r = await client.post(f"{POLYPAL_API}/edit/plan", json={"instruction": instruction, "path": path, "mode": "rules"})
                    r.raise_for_status()
                    steps = r.json().get("steps") or []
                    if not steps:
                        return ToolOutcome(
                            "Could not map the instruction to mesh operations. Call list_mesh_operations and pass explicit steps.",
                            ok=False,
                        )
                r = await client.post(f"{POLYPAL_API}/edit/apply", json={
                    "path": path, "steps": [{"op": s.get("op"), "params": s.get("params") or {}} for s in steps],
                    "instruction": instruction, "source": "copilot",
                })
                r.raise_for_status()
                data = r.json()
                stats = data.get("stats") or {}
                payload = {
                    "type": "mesh_update", "url": data.get("url"), "face_count": stats.get("faces"),
                    "summary": data.get("summary"), "label": data.get("summary"),
                }
                return ToolOutcome(f"{data.get('summary', 'Edited the mesh.')} Result: {stats.get('faces', '?'):,} triangles.", payload)

            if name == "decimate_mesh":
                r = await client.post(
                    f"{POLYPAL_API}/optimize/mesh",
                    json={"path": arguments["path"], "target_faces": arguments["target_faces"]},
                )
                r.raise_for_status()
                data = r.json()
                payload = {"type": "mesh_update", "url": data["url"], "face_count": data.get("face_count")}
                return ToolOutcome(f"Decimated to {data.get('face_count', '?')} faces.", payload)

            if name == "smooth_mesh":
                r = await client.post(
                    f"{POLYPAL_API}/optimize/smooth",
                    json={"path": arguments["path"], "iterations": arguments["iterations"]},
                )
                r.raise_for_status()
                data = r.json()
                payload = {"type": "mesh_update", "url": data["url"]}
                return ToolOutcome(f"Smoothed mesh ({arguments['iterations']} iterations).", payload)

            if name == "get_provenance":
                path = _mesh_path(arguments, context)
                if not path:
                    return ToolOutcome("No mesh currently loaded in the viewer.", ok=False)
                r = await client.get(f"{POLYPAL_API}/edit/provenance", params={"path": path})
                r.raise_for_status()
                data = r.json()
                chain = data.get("lineage") or []
                if not chain:
                    return ToolOutcome("No generation history is recorded for this mesh (it may have been imported).")
                lines = []
                for record in chain:
                    if record.get("kind") == "generation":
                        g = record["generation"]
                        lines.append(
                            f"- Generated with {g.get('model_name')} {g.get('model_version', '')} "
                            f"(seed {g.get('params', {}).get('seed', 'n/a')}) in {g.get('duration_s', '?')} s"
                        )
                    else:
                        steps = (record.get("edit") or {}).get("steps") or []
                        lines.append("- Edited: " + ", ".join(str(s.get("label") or s.get("op")) for s in steps))
                tail = " It can be regenerated with identical settings." if data.get("regenerable") else ""
                return ToolOutcome("History:\n" + "\n".join(lines) + tail)

            if name == "regenerate_model":
                path = _mesh_path(arguments, context)
                if not path:
                    return ToolOutcome("No mesh currently loaded in the viewer.", ok=False)
                r = await client.post(f"{POLYPAL_API}/generate/regenerate", json={
                    "path": path, "new_seed": bool(arguments.get("new_seed")),
                })
                r.raise_for_status()
                data = r.json()
                return ToolOutcome(
                    f"Regeneration queued (job {data['job_id']}, seed {data.get('seed')}).",
                    {"type": "generation_started", "job_id": data["job_id"]},
                )

            if name == "get_gpu_status":
                r = await client.get(f"{POLYPAL_API}/gpu/status")
                r.raise_for_status()
                data = r.json()
                gpus = data.get("gpus") or []
                if not gpus:
                    head = "GPU memory can't be measured on this system."
                else:
                    g = gpus[0]
                    head = f"{g['name']}: {g['used_mb'] / 1024:.1f} GB used, {g['free_mb'] / 1024:.1f} GB free of {g['total_mb'] / 1024:.1f} GB."
                resident = data.get("resident") or []
                loaded = ", ".join(f"{r['id']} ({r['kind']})" for r in resident) or "nothing"
                return ToolOutcome(f"{head} Loaded by {APP_NAME}: {loaded}.")

            if name == "get_generation_status":
                r = await client.get(f"{POLYPAL_API}/generate/status/{arguments['job_id']}")
                r.raise_for_status()
                s = r.json()
                text = f"Status: {s['status']}, Progress: {s.get('progress', 0)}%"
                if s.get("step"):
                    text += f", Step: {s['step']}"
                if s.get("output_url"):
                    text += f", Output: {s['output_url']}"
                return ToolOutcome(text)

            if name == "list_workflows":
                workflows = context.get("workflows", [])
                if not workflows:
                    return ToolOutcome("No workflows found. Create one in the Workflows tab.")
                lines = "\n".join(f"- {w['id']}: {w['name']}" for w in workflows)
                return ToolOutcome(f"Available workflows:\n{lines}")

            if name == "run_workflow":
                workflow_id = arguments["workflow_id"]
                workflows = context.get("workflows", [])
                match = next((w for w in workflows if w["id"] == workflow_id), None)
                if not match:
                    return ToolOutcome(f"Workflow '{workflow_id}' not found. Use list_workflows to see available workflows.", ok=False)
                payload = {"type": "run_workflow", "workflow_id": workflow_id, "workflow_name": match["name"]}
                return ToolOutcome(f"Executing workflow '{match['name']}'…", payload)

            if name == "create_workflow":
                steps = arguments.get("steps") or []
                if not steps:
                    return ToolOutcome("A workflow needs at least one step. Specify the extensions to chain.", ok=False)

                input_type = arguments.get("input_type") or "image"
                if input_type not in INPUT_NODES:
                    return ToolOutcome(
                        f"Invalid input_type '{input_type}'. Use exactly one of: "
                        f"image (Image node), text (Text node), mesh (Load 3D Mesh node).",
                        ok=False,
                    )

                extensions = context.get("extensions", [])
                valid_ids = {e["id"] for e in extensions}
                if valid_ids:
                    unknown = [s.get("extension_id") for s in steps if s.get("extension_id") not in valid_ids]
                    if unknown:
                        avail = ", ".join(sorted(valid_ids)) or "(none installed)"
                        return ToolOutcome(
                            f"Unknown extension id(s): {', '.join(map(str, unknown))}. Use only these: {avail}.",
                            ok=False,
                        )

                wf = _build_workflow_graph(
                    name=arguments.get("name") or "New Workflow",
                    description=arguments.get("description") or "",
                    input_type=input_type,
                    steps=steps,
                )
                payload = {"type": "create_workflow", "workflow": wf}
                return ToolOutcome(f"Created workflow '{wf['name']}' with {len(steps)} step(s).", payload)

            return ToolOutcome(f"Unknown tool: {name}", ok=False)

        except httpx.HTTPStatusError as e:
            detail = e.response.text[:200]
            try:
                detail = str(e.response.json().get("detail", detail))[:200]
            except (ValueError, AttributeError):
                pass
            return ToolOutcome(f"API error {e.response.status_code}: {detail}", ok=False)
        except Exception as e:  # noqa: BLE001 — reported to the model, never raised
            return ToolOutcome(f"Error: {e}", ok=False)


async def execute_tool(name: str, arguments: dict, context: dict) -> tuple[str, dict | None]:
    """Validate and run one tool. Returns (result_text, action_payload).

    action_payload carries data the frontend needs to react (e.g. new mesh URL).
    """
    try:
        clean = copilot.validate_arguments(name, arguments, TOOL_SCHEMAS, context)
    except copilot.ArgumentError as exc:
        return f"Invalid arguments for {name}: {exc}", None
    outcome = await _run_tool(name, clean, context)
    return outcome.text, outcome.payload


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] = []  # data URLs


class ProviderConfig(BaseModel):
    type: str = "local"            # "local" | "external"
    base_url: Optional[str] = None  # external only, e.g. https://api.openai.com/v1
    api_key: Optional[str] = None


class AgentChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str = Field(default_factory=llm_server.default_model_id)  # local: catalog/custom id — external: provider model name
    provider: ProviderConfig = ProviderConfig()
    context: dict = {}
    thinking: str = "auto"  # "auto" | "on" | "off"
    # "auto" runs every tool (legacy behaviour for API clients); the app sends
    # "confirm_heavy" or "confirm_all" so risky calls wait for the user.
    tool_policy: str = "auto"
    max_history_chars: int = copilot.DEFAULT_HISTORY_CHARS


class ActionDone(BaseModel):
    tool: str
    result: str
    payload: dict | None = None
    status: str = "ok"            # ok | error | pending | skipped
    arguments: dict = {}
    risk: str = "read"
    duration_ms: int = 0
    call_id: str = ""


class AgentChatResponse(BaseModel):
    message: str
    actions: list[ActionDone] = []
    thinking: str | None = None
    trimmed: int = 0


def _extract_thinking(msg: dict) -> tuple[str, str | None]:
    """Return (clean_content, thinking_text). Handles llama-server's
    reasoning_content field and inline <think> tags."""
    content = msg.get("content") or ""
    thinking = msg.get("reasoning_content") or None
    if not thinking:
        match = re.search(r"<think>(.*?)</think>", content, re.DOTALL)
        if match:
            thinking = match.group(1).strip()
            content = (content[: match.start()] + content[match.end() :]).strip()
    return content, thinking


def _auth_headers(base_url: str, api_key: Optional[str]) -> dict:
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        if "anthropic" in base_url:
            # Anthropic's OpenAI-compat layer also accepts the native headers.
            headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
    return headers



class ResolvedProvider:
    """Where to send chat completions, and how. ``release()`` frees a held local slot."""

    def __init__(self, base_url: str, headers: dict, extra: dict, send_images: bool, slot=None) -> None:
        self.base_url = base_url
        self.headers = headers
        self.extra = extra
        self.send_images = send_images
        self._slot = slot

    def release(self) -> None:
        if self._slot is not None:
            self._slot.release()
            self._slot = None


class ProviderUnavailable(RuntimeError):
    pass


async def resolve_provider(
    provider_type: str,
    model: str,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    thinking: str = "auto",
) -> ResolvedProvider:
    """Shared by the copilot and the AI edit planner."""
    if provider_type == "local":
        model = model or llm_server.default_model_id()
        try:
            spec = llm_server.resolve_model(model)
            # hold=True: the slot stays claimed until release(), so neither the
            # idle reaper nor a model loading elsewhere can evict it mid-answer.
            slot = await asyncio.to_thread(llama_pool.ensure, model, spec, True)
        except Exception as e:  # noqa: BLE001
            raise ProviderUnavailable(f"Could not start the local LLM: {e}") from e
        extra: dict = dict(llm_server.sampling_for(model))
        if thinking == "off":
            extra["chat_template_kwargs"] = {"enable_thinking": False}
        return ResolvedProvider(slot.base_url, {}, extra, bool(spec.get("vision")), slot)
    if not base_url:
        raise ProviderUnavailable("No provider URL configured. Set one in Settings → Agent.")
    url = base_url.rstrip("/")
    return ResolvedProvider(url, _auth_headers(url, api_key), {}, True)


class ExternalModelsRequest(BaseModel):
    base_url: str
    api_key: str = ""


@router.post("/external/models")
async def list_external_models(req: ExternalModelsRequest):
    """Proxy the provider's /models listing (avoids CORS issues from the renderer).

    POST with the key in the body, never a GET query string: uvicorn's access log
    records the full request line, and that log ends up in runtime.log.
    """
    headers = _auth_headers(req.base_url, req.api_key)
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.get(f"{req.base_url.rstrip('/')}/models", headers=headers)
            r.raise_for_status()
            data = r.json().get("data", [])
            return {"models": sorted(m["id"] for m in data if isinstance(m, dict) and m.get("id"))}
        except Exception:
            return {"models": []}


def _error_detail(r: httpx.Response) -> str:
    """The provider's own message (OpenAI-style `{"error": {"message": …}}`), else the raw body."""
    try:
        err = r.json().get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:300]
        if isinstance(err, str):
            return err[:300]
    except (ValueError, AttributeError):
        pass
    return r.text[:300]


def _tool_arguments(raw) -> dict:
    """OpenAI-compatible servers send tool arguments as a JSON string."""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _user_entry(m: ChatMessage, send_images: bool) -> dict:
    if not (m.images and send_images):
        return {"role": m.role, "content": m.content}
    parts: list[dict] = [{"type": "text", "text": m.content}]
    for data_url in m.images:
        parts.append({"type": "image_url", "image_url": {"url": data_url}})
    return {"role": m.role, "content": parts}


def _drop_images(messages: list[dict]) -> bool:
    """Replace image parts with a text note, in place. True if any were dropped."""
    dropped = False
    for m in messages:
        if not isinstance(m.get("content"), list):
            continue
        texts = [p["text"] for p in m["content"] if p.get("type") == "text"]
        if any(p.get("type") == "image_url" for p in m["content"]):
            dropped = True
            texts.append("[An image was attached, but this model reads text only.]")
        m["content"] = "\n".join(texts)
    return dropped



# ---------------------------------------------------------------------------
# The tool-use loop (shared by /chat and /chat/stream)
# ---------------------------------------------------------------------------

def _build_messages(request: AgentChatRequest, send_images: bool) -> tuple[list[dict], int]:
    """System prompt (one message — see below) plus the trimmed history."""
    parts = [SYSTEM_PROMPT]
    ctx = request.context or {}
    ctx_lines = []
    if ctx.get("currentMeshPath"):
        ctx_lines.append(f"Current mesh path: {ctx['currentMeshPath']}")
    if ctx.get("meshTriangles"):
        ctx_lines.append(f"Current mesh triangles: {ctx['meshTriangles']:,}")
    if ctx.get("units"):
        ctx_lines.append(f"Display units preferred by the user: {ctx['units']}")
    if ctx_lines:
        parts.append("Scene context:\n" + "\n".join(ctx_lines))
    extensions = ctx.get("extensions") or []
    if extensions:
        ext_lines = [
            f"- {e['id']} ({e.get('input', '?')}→{e.get('output', '?')}): {e.get('name', e['id'])}"
            for e in extensions
        ]
        parts.append("Available extensions (use the exact id when creating workflows):\n" + "\n".join(ext_lines))

    history, dropped = copilot.trim_history([m.model_dump() for m in request.messages], request.max_history_chars)
    if dropped:
        parts.append(f"Note: {dropped} earlier message(s) of this conversation were omitted to fit the context window.")

    # ONE system message, first. Qwen3.5's chat template raises "System message
    # must be at the beginning", which llama-server returns as a flat HTTP 400;
    # other templates silently drop the extra ones.
    messages = [{"role": "system", "content": "\n\n".join(parts)}]
    messages.extend(_user_entry(ChatMessage(**m), send_images) for m in history)
    return messages, dropped


async def _completion(client: httpx.AsyncClient, url: str, headers: dict, body: dict) -> AsyncIterator[tuple[str, Any]]:
    """One chat-completions round. Yields ("content"|"reasoning", text) deltas
    while streaming, then ("message", assembled_message) — or ("http_error", response)."""
    if not body.get("stream"):
        r = await client.post(url, headers=headers, json=body)
        if r.status_code != 200:
            yield ("http_error", r)
            return
        yield ("message", r.json()["choices"][0]["message"])
        return

    async with client.stream("POST", url, headers=headers, json=body) as r:
        if r.status_code != 200:
            await r.aread()
            yield ("http_error", r)
            return
        if "text/event-stream" not in r.headers.get("content-type", ""):
            await r.aread()  # provider ignored stream=true
            yield ("message", r.json()["choices"][0]["message"])
            return
        content: list[str] = []
        reasoning: list[str] = []
        calls: dict[int, dict] = {}
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                continue
            delta = ((chunk.get("choices") or [{}])[0] or {}).get("delta") or {}
            if delta.get("content"):
                content.append(delta["content"])
                yield ("content", delta["content"])
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
                yield ("reasoning", delta["reasoning_content"])
            for tc in delta.get("tool_calls") or []:
                slot = calls.setdefault(int(tc.get("index", 0)), {
                    "id": "", "type": "function", "function": {"name": "", "arguments": ""},
                })
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name") and not slot["function"]["name"]:
                    slot["function"]["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["function"]["arguments"] += fn["arguments"]
        message: dict = {"role": "assistant", "content": "".join(content)}
        if reasoning:
            message["reasoning_content"] = "".join(reasoning)
        if calls:
            message["tool_calls"] = [calls[i] for i in sorted(calls)]
        yield ("message", message)


async def _execute_call(name: str, arguments: dict, context: dict) -> ToolOutcome:
    try:
        return await asyncio.wait_for(
            _run_tool(name, arguments, context),
            timeout=TOOL_TIMEOUTS.get(name, DEFAULT_TOOL_TIMEOUT) + 5,
        )
    except asyncio.TimeoutError:
        return ToolOutcome(f"{name} timed out.", ok=False)


async def _agent_events(request: AgentChatRequest, stream: bool) -> AsyncIterator[dict]:
    """The copilot loop as a sequence of events; ends with exactly one "done"."""
    try:
        provider = await resolve_provider(
            "local" if request.provider.type == "local" else "external",
            request.model, request.provider.base_url, request.provider.api_key, request.thinking,
        )
    except ProviderUnavailable as exc:
        yield {"type": "done", "message": str(exc), "actions": [], "thinking": None, "error": True}
        return

    messages, dropped = _build_messages(request, provider.send_images)
    yield {"type": "start", "trimmed": dropped}

    actions: list[ActionDone] = []
    thinking_parts: list[str] = []
    answer_parts: list[str] = []
    seen_calls: dict[str, int] = {}
    total_calls = 0
    final: Optional[dict] = None
    is_external = request.provider.type != "local"
    url = f"{provider.base_url}/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            for round_index in range(MAX_ROUNDS):
                yield {"type": "round", "index": round_index}
                body = {"model": request.model, "messages": messages, "tools": TOOLS, "stream": stream, **provider.extra}
                think_filter = copilot.ThinkFilter()
                message: Optional[dict] = None
                retried = False
                while message is None:
                    error_response = None
                    async for kind, value in _completion(client, url, provider.headers, body):
                        if kind == "content":
                            visible, hidden = think_filter.feed(value)
                            if visible:
                                yield {"type": "token", "text": visible}
                            if hidden:
                                yield {"type": "thinking", "text": hidden}
                        elif kind == "reasoning":
                            yield {"type": "thinking", "text": value}
                        elif kind == "http_error":
                            error_response = value
                        else:
                            message = value
                    if error_response is None:
                        break
                    # An external model's vision support is unknown up front, and a
                    # text-only one rejects image parts with a 400 that failed the
                    # whole turn. Retry once with the images described as omitted.
                    if error_response.status_code == 400 and is_external and not retried and _drop_images(messages):
                        retried = True
                        continue
                    detail = f"LLM error ({error_response.status_code}): {_error_detail(error_response)}"
                    yield {"type": "done", "message": detail, "actions": [a.model_dump() for a in actions],
                           "thinking": None, "error": True}
                    return
                visible, hidden = think_filter.flush()
                if visible:
                    yield {"type": "token", "text": visible}
                if hidden:
                    yield {"type": "thinking", "text": hidden}

                tool_calls = message.get("tool_calls") or []
                assistant: dict = {"role": "assistant", "content": message.get("content") or ""}
                if tool_calls:
                    assistant["tool_calls"] = tool_calls
                messages.append(assistant)

                clean_content, thinking_text = _extract_thinking(message)
                if thinking_text:
                    thinking_parts.append(thinking_text)
                if clean_content.strip():
                    answer_parts.append(clean_content.strip())

                if not tool_calls:
                    final = {"message": "\n\n".join(answer_parts)}
                    break

                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    name = fn.get("name") or ""
                    raw_args = _tool_arguments(fn.get("arguments"))
                    call_id = tc.get("id") or f"call_{uuid.uuid4().hex[:8]}"
                    risk = copilot.risk_of(name)
                    yield {"type": "tool_call", "call_id": call_id, "tool": name, "arguments": raw_args, "risk": risk}

                    started = time.monotonic()
                    total_calls += 1
                    signature = copilot.call_signature(name, raw_args)
                    seen_calls[signature] = seen_calls.get(signature, 0) + 1
                    clean_args: dict = raw_args
                    if total_calls > copilot.MAX_TOOL_CALLS_PER_TURN:
                        outcome, status = ToolOutcome("Tool budget for this turn is used up; answer with what you have."), "skipped"
                    elif seen_calls[signature] > copilot.MAX_IDENTICAL_CALLS:
                        outcome, status = ToolOutcome("Identical call already made this turn; use its earlier result."), "skipped"
                    else:
                        try:
                            clean_args = copilot.validate_arguments(name, raw_args, TOOL_SCHEMAS, request.context)
                        except copilot.ArgumentError as exc:
                            outcome, status = ToolOutcome(f"Invalid arguments for {name}: {exc}", ok=False), "error"
                        else:
                            if copilot.needs_approval(name, request.tool_policy):
                                summary = copilot.describe_call(name, clean_args)
                                outcome = ToolOutcome(
                                    "Not executed yet: this action is awaiting the user's approval in the app. "
                                    "Tell the user in one sentence what you proposed; do not call it again.",
                                    {"type": "confirmation_required", "tool": name, "arguments": clean_args,
                                     "risk": risk, "summary": summary},
                                )
                                status = "pending"
                            else:
                                outcome = await _execute_call(name, clean_args, request.context)
                                status = "ok" if outcome.ok else "error"

                    action = ActionDone(
                        tool=name, result=outcome.text, payload=outcome.payload, status=status,
                        arguments=clean_args, risk=risk, call_id=call_id,
                        duration_ms=int((time.monotonic() - started) * 1000),
                    )
                    actions.append(action)
                    yield {"type": "tool_result", "action": action.model_dump()}
                    messages.append({
                        "role": "tool", "tool_call_id": tc.get("id", ""),
                        "content": copilot.summarise_tool_result(outcome.text),
                    })
    except httpx.HTTPError as e:
        yield {"type": "done", "message": f"Could not reach the LLM at {provider.base_url}: {e}",
               "actions": [a.model_dump() for a in actions], "thinking": None, "error": True}
        return
    finally:
        provider.release()
        # After the release: unload_all() spares a held slot, so unloading while
        # still holding ours would keep the agent's own model on the GPU.
        await _unload_llm_after_workflow(request, actions)

    if final is None:
        final = {"message": "\n\n".join(answer_parts + ["Reached maximum tool iterations."])}
    yield {
        "type": "done",
        "message": final["message"],
        "actions": [a.model_dump() for a in actions],
        "thinking": "\n\n---\n\n".join(thinking_parts) if thinking_parts else None,
        "trimmed": dropped,
    }


async def _unload_llm_after_workflow(request: AgentChatRequest, actions_done: list[ActionDone]) -> None:
    """Free the local LLM's VRAM once a workflow has been dispatched, so the
    workflow gets the full GPU. Best-effort — never fail the chat over it."""
    if request.provider.type != "local":
        return
    if not any(a.tool in ("run_workflow", "regenerate_model") and a.status == "ok" for a in actions_done):
        return
    try:
        await asyncio.to_thread(llama_pool.unload_all)
    except Exception:
        pass


@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest):
    done: dict = {}
    async for event in _agent_events(request, stream=False):
        if event["type"] == "done":
            done = event
    return AgentChatResponse(
        message=done.get("message", ""),
        actions=[ActionDone(**a) for a in done.get("actions") or []],
        thinking=done.get("thinking"),
        trimmed=done.get("trimmed", 0),
    )


@router.post("/chat/stream")
async def agent_chat_stream(request: AgentChatRequest):
    """Server-Sent Events: start, round, token, thinking, tool_call, tool_result, done."""
    async def events():
        try:
            async for event in _agent_events(request, stream=True):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        except Exception as exc:  # noqa: BLE001 — surface as a terminal event, not a dropped socket
            yield f"data: {json.dumps({'type': 'done', 'message': f'Copilot error: {exc}', 'actions': [], 'error': True})}\n\n"

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ExecuteToolRequest(BaseModel):
    name: str
    arguments: dict = {}
    context: dict = {}


@router.post("/tools/execute", response_model=ActionDone)
async def execute_approved_tool(body: ExecuteToolRequest):
    """Run a tool the user approved from a pending action card. Re-validated here:
    the UI only relays what the model proposed."""
    started = time.monotonic()
    risk = copilot.risk_of(body.name)
    try:
        clean = copilot.validate_arguments(body.name, body.arguments, TOOL_SCHEMAS, body.context)
    except copilot.ArgumentError as exc:
        return ActionDone(tool=body.name, result=f"Invalid arguments: {exc}", status="error", risk=risk)
    outcome = await _execute_call(body.name, clean, body.context)
    return ActionDone(
        tool=body.name, result=outcome.text, payload=outcome.payload,
        status="ok" if outcome.ok else "error", arguments=clean, risk=risk,
        duration_ms=int((time.monotonic() - started) * 1000),
    )


@router.get("/tools")
async def list_tools():
    """Tool catalogue with risk levels, for the settings UI."""
    return [
        {"name": t["function"]["name"], "description": t["function"]["description"], "risk": copilot.risk_of(t["function"]["name"])}
        for t in TOOLS
    ]


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

class ConversationSave(BaseModel):
    messages: list[dict]
    title: Optional[str] = None


class ConversationRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)


def _conversation_call(fn, *args):
    try:
        return fn(*args)
    except KeyError as exc:
        raise HTTPException(404, "Conversation not found") from exc
    except conversations.ConversationError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/conversations")
async def list_conversations():
    return await asyncio.to_thread(conversations.list_all)


@router.post("/conversations")
async def create_conversation():
    return await asyncio.to_thread(conversations.create)


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    return await asyncio.to_thread(_conversation_call, conversations.load, conversation_id)


@router.put("/conversations/{conversation_id}")
async def save_conversation(conversation_id: str, body: ConversationSave):
    data = await asyncio.to_thread(_conversation_call, conversations.save, conversation_id, body.messages, body.title)
    return {k: v for k, v in data.items() if k != "messages"}


@router.post("/conversations/{conversation_id}/title")
async def rename_conversation(conversation_id: str, body: ConversationRename):
    data = await asyncio.to_thread(_conversation_call, conversations.rename, conversation_id, body.title)
    return {k: v for k, v in data.items() if k != "messages"}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    deleted = await asyncio.to_thread(_conversation_call, conversations.delete, conversation_id)
    return {"deleted": deleted}
