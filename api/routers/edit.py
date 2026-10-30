"""Mesh editor API: statistics, AI edit planning and atomic multi-step apply.

* ``GET  /edit/ops``    — the operation catalogue (built-ins from the registry).
* ``GET  /edit/stats``  — geometry/topology probe of one mesh.
* ``POST /edit/plan``   — plain English → validated steps (rules or LLM).
* ``POST /edit/apply``  — run steps in order; only the final mesh is written to
  the workspace, so a failing step leaves nothing half-done behind.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import services.generator_registry as registry
from services import provenance
from services.edit_planner import (
    PLANNER_SYSTEM_PROMPT,
    PlanError,
    describe_mesh_for_prompt,
    parse_instruction,
    planner_tool,
    summarise_plan,
    validate_plan,
)
from services.mesh_analysis import mesh_statistics
from services.mesh_io import load_flat_mesh
from services.mesh_ops import (
    MeshOpContext,
    MeshOpExecutionError,
    MeshOpNotFoundError,
    MeshOpUnavailableError,
    mesh_ops_registry,
)

router = APIRouter(prefix="/edit", tags=["edit"])


# ---------------------------------------------------------------------------
# Path handling (mirrors /optimize: workspace-relative, or an imported file)
# ---------------------------------------------------------------------------

def resolve_mesh_path(raw_path: str) -> Path:
    raw_path = (raw_path or "").strip()
    if raw_path.startswith("/workspace/"):
        raw_path = raw_path[len("/workspace/"):]
    if raw_path.startswith("/optimize/serve-file?path="):
        from urllib.parse import unquote
        raw_path = unquote(raw_path.split("path=", 1)[1])
    if not raw_path:
        raise HTTPException(400, "path is required")
    candidate = Path(raw_path)
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (registry.WORKSPACE_DIR / raw_path).resolve()
        if not registry.is_within_workspace(resolved):
            raise HTTPException(400, "Invalid path")
    if not resolved.is_file():
        raise HTTPException(404, f"File not found: {raw_path}")
    return resolved


def _output_dir_for(input_path: Path) -> Path:
    if registry.is_within_workspace(input_path.resolve()):
        return input_path.parent
    target = registry.WORKSPACE_DIR / "Edits"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _workspace_payload(path: Path) -> dict[str, Any]:
    relative = provenance.relative_to_workspace(path)
    if relative is None:
        return {"path": str(path)}
    return {"path": relative, "url": f"/workspace/{relative}"}


def compute_stats(path: Path) -> dict[str, Any]:
    try:
        mesh = load_flat_mesh(path)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    stats = mesh_statistics(mesh)
    stats["units"] = provenance.units_for(path)
    return stats


# ---------------------------------------------------------------------------
# Catalogue & stats
# ---------------------------------------------------------------------------

@router.get("/ops")
def list_operations():
    return mesh_ops_registry.describe()


@router.get("/stats")
async def mesh_stats(path: str):
    resolved = resolve_mesh_path(path)
    return await asyncio.to_thread(compute_stats, resolved)


@router.get("/provenance")
def mesh_provenance(path: str):
    """The mesh's own record plus its lineage back to the generation."""
    resolved = resolve_mesh_path(path)
    chain = provenance.lineage(resolved)
    root = next((r for r in chain if r.get("kind") == "generation"), None)
    regenerable = bool(
        root and ((root.get("generation") or {}).get("input") or {}).get("stored_path")
    )
    return {
        "record": chain[-1] if chain else None,
        "lineage": chain,
        "regenerable": regenerable,
        "deterministic": bool(root and root["generation"].get("deterministic")),
        "units": provenance.units_for(resolved),
    }


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------

class PlannerProvider(BaseModel):
    type: Literal["local", "external", "none"] = "none"
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None


class PlanRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=2000)
    path: Optional[str] = None
    mode: Literal["auto", "rules", "llm"] = "auto"
    provider: PlannerProvider = PlannerProvider()


class PlanStep(BaseModel):
    op: str
    params: dict[str, Any] = Field(default_factory=dict)


class PlanResponse(BaseModel):
    steps: list[dict[str, Any]]
    summary: str
    source: Literal["rules", "llm", "none"]
    warnings: list[str] = []


async def _plan_with_llm(instruction: str, stats: dict[str, Any], provider: PlannerProvider) -> tuple[list[dict], str]:
    """Ask the configured LLM for a plan through the propose_edit_plan tool."""
    from routers.agent import resolve_provider  # shared provider plumbing

    operations = mesh_ops_registry.describe()
    tool = planner_tool(operations)
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT + "\n\n" + describe_mesh_for_prompt(stats)},
        {"role": "user", "content": instruction},
    ]
    resolved = await resolve_provider(provider.type, provider.model or "", provider.base_url, provider.api_key)
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{resolved.base_url}/chat/completions",
                headers=resolved.headers,
                json={
                    "model": provider.model or "",
                    "messages": messages,
                    "tools": [tool],
                    "tool_choice": {"type": "function", "function": {"name": "propose_edit_plan"}},
                    "stream": False,
                    **resolved.extra,
                },
            )
            if r.status_code != 200:
                raise PlanError(f"LLM error ({r.status_code})")
            message = r.json()["choices"][0]["message"]
    finally:
        resolved.release()

    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        if fn.get("name") != "propose_edit_plan":
            continue
        raw = fn.get("arguments")
        args = raw if isinstance(raw, dict) else json.loads(raw or "{}")
        return list(args.get("steps") or []), str(args.get("summary") or "")
    raise PlanError("The model did not propose a plan")


@router.post("/plan", response_model=PlanResponse)
async def plan_edit(body: PlanRequest):
    stats: dict[str, Any] = {}
    if body.path:
        stats = await asyncio.to_thread(compute_stats, resolve_mesh_path(body.path))
    operations = mesh_ops_registry.describe()
    warnings: list[str] = []

    use_llm = body.mode == "llm" or (body.mode == "auto" and body.provider.type != "none")
    if use_llm:
        try:
            raw_steps, summary = await _plan_with_llm(body.instruction, stats, body.provider)
            if raw_steps:
                steps, warnings = validate_plan(raw_steps, operations)
                return PlanResponse(steps=steps, summary=summary or summarise_plan(steps), source="llm", warnings=warnings)
            warnings.append(summary or "The AI planner found no matching operations.")
        except (PlanError, httpx.HTTPError, ValueError, KeyError, RuntimeError) as exc:
            if body.mode == "llm":
                raise HTTPException(502, f"AI planner failed: {exc}") from exc
            warnings.append(f"AI planner unavailable ({exc}); used built-in phrase rules.")

    raw_steps = parse_instruction(body.instruction, stats)
    if not raw_steps:
        return PlanResponse(
            steps=[], source="none",
            summary="I couldn't map that to a mesh operation. Try e.g. “remove floaters, then reduce to 20k triangles”.",
            warnings=warnings,
        )
    steps, more = validate_plan(raw_steps, operations)
    return PlanResponse(steps=steps, summary=summarise_plan(steps), source="rules", warnings=warnings + more)


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

class ApplyRequest(BaseModel):
    path: str
    steps: list[PlanStep] = Field(min_length=1)
    instruction: Optional[str] = None
    source: str = "editor"


def apply_steps(input_path: Path, steps: list[dict[str, Any]], instruction: Optional[str], source: str) -> dict[str, Any]:
    started = time.monotonic()
    validated, warnings = validate_plan(steps, mesh_ops_registry.describe())
    scratch = Path(tempfile.mkdtemp(prefix="polypal_edit_"))
    try:
        current = input_path
        results: list[dict[str, Any]] = []
        for index, step in enumerate(validated):
            context = MeshOpContext(
                workspace_dir=registry.WORKSPACE_DIR,
                temp_dir=scratch,
                output_path=scratch / f"step{index:02d}.glb",
                preserve_visuals=True,
            )
            try:
                result = mesh_ops_registry.run(step["op"], current, step["params"], context)
            except (MeshOpNotFoundError, MeshOpUnavailableError, MeshOpExecutionError,
                    TypeError, ValueError, FileNotFoundError):
                raise
            except Exception as exc:  # noqa: BLE001 — backend libraries raise their own types
                raise MeshOpExecutionError(f"{step['label']} failed: {exc}") from exc
            current = Path(result.file_path)
            results.append({**step, "details": dict(result.details)})

        digest = hashlib.sha1(json.dumps(validated, sort_keys=True).encode() + str(time.time_ns()).encode()).hexdigest()[:8]
        final = _output_dir_for(input_path) / f"{input_path.stem}_edit_{digest}.glb"
        shutil.copyfile(current, final)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    provenance.record_edit(final, input_path, steps=results, source=source, instruction=instruction)
    stats = compute_stats(final)
    return {
        **_workspace_payload(final),
        "steps": results,
        "warnings": warnings,
        "stats": stats,
        "summary": summarise_plan(results),
        "duration_s": round(time.monotonic() - started, 2),
    }


@router.post("/apply")
async def apply_edit(body: ApplyRequest):
    input_path = resolve_mesh_path(body.path)
    try:
        return await asyncio.to_thread(
            apply_steps, input_path, [s.model_dump() for s in body.steps], body.instruction, body.source,
        )
    except PlanError as exc:
        raise HTTPException(400, str(exc)) from exc
    except MeshOpNotFoundError as exc:
        raise HTTPException(404, f"Unknown mesh operation: {exc}") from exc
    except (MeshOpUnavailableError, MeshOpExecutionError) as exc:
        raise HTTPException(503, str(exc)) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

