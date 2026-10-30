"""
PolyPal MCP Server
Exposes PolyPal's capabilities as MCP tools for external agents (Claude Desktop, Codex CLI, etc.).

Usage:
  python mcp_server.py

Configuration in Claude Desktop (~/.config/claude/claude_desktop_config.json):
  {
    "mcpServers": {
      "polypal": {
        "command": "python",
        "args": ["C:/path/to/polypal/desktop/api/mcp_server.py"]
      }
    }
  }

Requires PolyPal's FastAPI backend to be running on http://localhost:8765.
"""

import asyncio
import mimetypes
import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

API_BASE = "http://localhost:8765"

server = Server("polypal")


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="polypal_list_models",
            description="List all 3D generation models available in PolyPal (downloaded and ready to use).",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="polypal_switch_model",
            description="Switch the active 3D generation model in PolyPal.",
            inputSchema={
                "type": "object",
                "properties": {
                    "model_id": {"type": "string", "description": "The model ID to activate."},
                },
                "required": ["model_id"],
            },
        ),
        Tool(
            name="polypal_generate_from_image",
            description="Generate a 3D mesh from a 2D image file. Returns a job_id to track progress.",
            inputSchema={
                "type": "object",
                "properties": {
                    "image_path": {
                        "type": "string",
                        "description": "Absolute path to the image file on disk.",
                    },
                    "model_id": {
                        "type": "string",
                        "description": "Which model to use. If omitted, uses the currently active model.",
                    },
                    "remesh": {
                        "type": "string",
                        "enum": ["quad", "triangle", "none"],
                        "description": "Remesh strategy after generation. Default: quad.",
                    },
                },
                "required": ["image_path"],
            },
        ),
        Tool(
            name="polypal_get_generation_status",
            description="Poll the status of a 3D generation job. Call repeatedly until status is 'done' or 'error'.",
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Job ID returned by polypal_generate_from_image."},
                },
                "required": ["job_id"],
            },
        ),
        Tool(
            name="polypal_decimate_mesh",
            description="Reduce the polygon count of a mesh using quadric edge collapse decimation.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh (e.g. 'Default/mesh.glb').",
                    },
                    "target_faces": {
                        "type": "integer",
                        "description": "Target number of faces after decimation (minimum 100).",
                    },
                },
                "required": ["path", "target_faces"],
            },
        ),
        Tool(
            name="polypal_smooth_mesh",
            description="Apply Laplacian smoothing to a mesh. More iterations = smoother surface but less detail.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh (e.g. 'Default/mesh.glb').",
                    },
                    "iterations": {
                        "type": "integer",
                        "description": "Number of smoothing iterations (1–20).",
                    },
                },
                "required": ["path", "iterations"],
            },
        ),
        Tool(
            name="polypal_import_mesh",
            description="Import a mesh file from disk into PolyPal's workspace (.glb, .obj, .stl, .ply).",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the mesh file on disk.",
                    },
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="polypal_unload_models",
            description="Unload all 3D generation models from GPU VRAM. Useful before running VRAM-intensive tasks.",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="polypal_get_settings",
            description="Get the current PolyPal settings (models directory, workspace directory).",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="polypal_mesh_stats",
            description="Measure a workspace mesh: triangles, size in metres, pieces, holes, watertightness.",
            inputSchema={
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Workspace-relative mesh path."}},
                "required": ["path"],
            },
        ),
        Tool(
            name="polypal_edit_mesh",
            description=(
                "Edit a workspace mesh from a plain-English instruction (e.g. 'remove floaters, "
                "reduce to 20k triangles and make it 15 cm tall'). Writes a new mesh version."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative mesh path."},
                    "instruction": {"type": "string", "description": "What to change."},
                },
                "required": ["path", "instruction"],
            },
        ),
        Tool(
            name="polypal_get_provenance",
            description="How a workspace mesh was generated and edited (model, settings, seed, edit history).",
            inputSchema={
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Workspace-relative mesh path."}},
                "required": ["path"],
            },
        ),
        Tool(
            name="polypal_regenerate",
            description="Re-run the generation a mesh came from with exactly the same settings. Returns a job_id.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative mesh path."},
                    "new_seed": {"type": "boolean", "description": "Use a new random seed."},
                    "priority": {"type": "string", "enum": ["high", "normal", "low"]},
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="polypal_gpu_status",
            description="GPU memory usage, loaded models and the generation queue.",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            result = await _dispatch(client, name, arguments)
        except httpx.ConnectError:
            result = (
                "Cannot connect to PolyPal API at http://localhost:8765. "
                "Make sure PolyPal is running."
            )
        except httpx.HTTPStatusError as e:
            result = f"PolyPal API error {e.response.status_code}: {e.response.text[:300]}"
        except Exception as e:
            result = f"Error: {e}"

    return [TextContent(type="text", text=result)]


async def _dispatch(client: httpx.AsyncClient, name: str, args: dict) -> str:
    if name == "polypal_list_models":
        r = await client.get(f"{API_BASE}/model/all")
        r.raise_for_status()
        models = [m for m in r.json() if m.get("downloaded")]
        if not models:
            return "No models downloaded yet. Download one from the Models tab in PolyPal."
        return "\n".join(f"- {m['id']}: {m.get('name', m['id'])}" for m in models)

    elif name == "polypal_switch_model":
        r = await client.post(f"{API_BASE}/model/switch", params={"model_id": args["model_id"]})
        r.raise_for_status()
        return f"Switched active model to: {args['model_id']}"

    elif name == "polypal_generate_from_image":
        image_path: str = args["image_path"]
        with open(image_path, "rb") as f:
            img_bytes = f.read()
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        filename = image_path.replace("\\", "/").split("/")[-1]

        form_data = {
            "remesh": args.get("remesh", "quad"),
        }
        if args.get("model_id"):
            form_data["model_id"] = args["model_id"]

        r = await client.post(
            f"{API_BASE}/generate/from-image",
            files={"image": (filename, img_bytes, mime)},
            data=form_data,
            timeout=30.0,
        )
        r.raise_for_status()
        job_id = r.json()["job_id"]
        return (
            f"Generation started. Job ID: {job_id}\n"
            f"Use polypal_get_generation_status with this ID to track progress."
        )

    elif name == "polypal_get_generation_status":
        r = await client.get(f"{API_BASE}/generate/status/{args['job_id']}")
        r.raise_for_status()
        s = r.json()
        parts = [f"Status: {s['status']}", f"Progress: {s.get('progress', 0)}%"]
        if s.get("step"):
            parts.append(f"Step: {s['step']}")
        if s.get("output_url"):
            parts.append(f"Output: {s['output_url']}")
        if s.get("error"):
            parts.append(f"Error: {s['error']}")
        return " | ".join(parts)

    elif name == "polypal_decimate_mesh":
        r = await client.post(
            f"{API_BASE}/optimize/mesh",
            json={"path": args["path"], "target_faces": args["target_faces"]},
        )
        r.raise_for_status()
        data = r.json()
        return f"Decimated mesh to {data.get('face_count', '?')} faces. New file: {data.get('url', '')}"

    elif name == "polypal_smooth_mesh":
        r = await client.post(
            f"{API_BASE}/optimize/smooth",
            json={"path": args["path"], "iterations": args["iterations"]},
        )
        r.raise_for_status()
        data = r.json()
        return f"Smoothed mesh ({args['iterations']} iterations). New file: {data.get('url', '')}"

    elif name == "polypal_import_mesh":
        r = await client.post(f"{API_BASE}/optimize/import-by-path", json={"path": args["path"]})
        r.raise_for_status()
        data = r.json()
        return f"Mesh imported. URL: {data.get('url', '')}"

    elif name == "polypal_unload_models":
        r = await client.post(f"{API_BASE}/model/unload-all")
        r.raise_for_status()
        return "All 3D generation models unloaded from VRAM."

    elif name == "polypal_get_settings":
        r = await client.get(f"{API_BASE}/settings/paths")
        r.raise_for_status()
        data = r.json()
        return f"Models directory: {data.get('models_dir')}\nWorkspace directory: {data.get('workspace_dir')}"

    elif name == "polypal_mesh_stats":
        r = await client.get(f"{API_BASE}/edit/stats", params={"path": args["path"]})
        r.raise_for_status()
        s = r.json()
        w, h, d = s.get("extents") or [0, 0, 0]
        return (
            f"{s['faces']:,} triangles, {s['vertices']:,} vertices | size {w:.4g} × {h:.4g} × {d:.4g} m"
            f"{' (real-world)' if s.get('units') == 'm' else ' (unitless)'} | {s['components']} piece(s) | "
            + ("watertight" if s.get("watertight") else f"{s['boundary_edges']} boundary edges")
        )

    elif name == "polypal_edit_mesh":
        r = await client.post(f"{API_BASE}/edit/plan", json={"instruction": args["instruction"], "path": args["path"], "mode": "rules"})
        r.raise_for_status()
        plan = r.json()
        if not plan.get("steps"):
            return plan.get("summary") or "No matching mesh operations."
        r = await client.post(
            f"{API_BASE}/edit/apply",
            json={"path": args["path"], "steps": plan["steps"], "instruction": args["instruction"], "source": "mcp"},
            timeout=600.0,
        )
        r.raise_for_status()
        data = r.json()
        return f"{data.get('summary')} New file: {data.get('url', data.get('path'))}"

    elif name == "polypal_get_provenance":
        r = await client.get(f"{API_BASE}/edit/provenance", params={"path": args["path"]})
        r.raise_for_status()
        import json as _json
        return _json.dumps(r.json().get("lineage") or [], indent=2)[:8000] or "No history recorded."

    elif name == "polypal_regenerate":
        r = await client.post(f"{API_BASE}/generate/regenerate", json={
            "path": args["path"], "new_seed": bool(args.get("new_seed")), "priority": args.get("priority", "normal"),
        })
        r.raise_for_status()
        data = r.json()
        return f"Regeneration queued. Job ID: {data['job_id']} (seed {data.get('seed')})"

    elif name == "polypal_gpu_status":
        status = (await client.get(f"{API_BASE}/gpu/status")).json()
        queue = (await client.get(f"{API_BASE}/generate/queue")).json()
        gpus = status.get("gpus") or []
        head = (
            f"{gpus[0]['name']}: {gpus[0]['free_mb']} MB free of {gpus[0]['total_mb']} MB"
            if gpus else "VRAM not measurable on this system"
        )
        loaded = ", ".join(r["id"] for r in status.get("resident") or []) or "none"
        waiting = ", ".join(f"{q['job_id']} ({q['priority']})" for q in queue.get("queued") or []) or "empty"
        return f"{head} | loaded: {loaded} | running: {queue.get('running') or 'nothing'} | queue: {waiting}"

    else:
        return f"Unknown tool: {name}"


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
