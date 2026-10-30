"""GPU status, pre-launch VRAM estimates and the automatic unloading policy."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import gpu
from services.extension_process import ExtensionProcess
from services.generator_registry import generator_registry
from services.llm_server import llama_pool

router = APIRouter(prefix="/gpu", tags=["gpu"])

# Model ids with a generation in progress — never unloaded by the policy.
busy_models: set[str] = set()


def resident_allocations(target_model_id: Optional[str] = None) -> list[dict[str, Any]]:
    """PolyPal-owned VRAM users: loaded 3D generators and local LLM servers."""
    resident: list[dict[str, Any]] = []
    for model_id, generator in list(getattr(generator_registry, "_generators", {}).items()):
        try:
            loaded = generator.is_loaded()
        except Exception:  # noqa: BLE001
            loaded = False
        if not loaded:
            continue
        manifest = getattr(generator_registry, "_manifests", {}).get(model_id, {})
        vram_gb = manifest.get("vram_gb") or getattr(generator, "VRAM_GB", 0) or 0
        resident.append({
            "kind": "generator", "id": model_id, "mb": int(float(vram_gb) * 1024),
            "is_target": model_id == target_model_id, "busy": model_id in busy_models,
        })
    try:
        servers = llama_pool.snapshot().get("servers", [])
    except Exception:  # noqa: BLE001
        servers = []
    for server in servers:
        resident.append({
            "kind": "llm", "id": server.get("model_id") or "llm", "mb": int(server.get("vram_mb") or 0),
            "is_target": False, "busy": False,
        })
    return resident


def launch_plan_for(model_id: str, params: Optional[dict[str, Any]] = None) -> gpu.LaunchPlan:
    manifest = generator_registry.get_manifest(model_id)
    resident = [r for r in resident_allocations(model_id) if not r["busy"] or r["is_target"]]
    return gpu.plan_launch(model_id, manifest, params, gpu.query_gpus(), resident)


def release(items: list[dict[str, Any]]) -> list[str]:
    """Unload the listed allocations; returns the ids actually released."""
    released = []
    for item in items:
        try:
            if item["kind"] == "llm":
                llama_pool.unload(item["id"])
            else:
                with generator_registry._lifecycle_lock:
                    generator = generator_registry.get_generator(item["id"])
                    if isinstance(generator, ExtensionProcess):
                        generator.stop()
                    else:
                        generator.unload()
            released.append(item["id"])
        except Exception:  # noqa: BLE001 — best effort; the launch proceeds regardless
            continue
    return released


def free_vram_before_launch(model_id: str, params: Optional[dict[str, Any]] = None) -> list[str]:
    """Policy hook called by the generation worker right before loading a model."""
    if gpu.policy.unload_before_launch != "auto":
        return []
    plan = launch_plan_for(model_id, params)
    if plan.verdict in ("fits_after_unload", "tight", "exceeds") and plan.unload:
        return release(plan.unload)
    return []


def reap_idle_generators() -> list[str]:
    loaded = [r["id"] for r in resident_allocations() if r["kind"] == "generator"]
    stale = gpu.idle_generators_to_unload(loaded, busy_models)
    return release([{"kind": "generator", "id": model_id} for model_id in stale])


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status")
async def gpu_status():
    gpus = await asyncio.to_thread(gpu.query_gpus)
    resident = await asyncio.to_thread(resident_allocations)
    for item in resident:
        if item["kind"] == "generator":
            idle = gpu.idle_seconds(item["id"])
            item["idle_seconds"] = round(idle) if idle is not None else None
    return {
        "gpus": gpus,
        "resident": resident,
        "policy": gpu.policy.__dict__,
    }


class EstimateRequest(BaseModel):
    model_id: str
    params: dict[str, Any] = {}


@router.post("/estimate")
async def estimate(body: EstimateRequest):
    try:
        plan = await asyncio.to_thread(launch_plan_for, body.model_id, body.params)
    except (KeyError, ValueError) as exc:
        raise HTTPException(404, f"Unknown model: {body.model_id}") from exc
    return plan.to_dict()


class PolicyUpdate(BaseModel):
    unload_before_launch: Optional[str] = None
    idle_unload_minutes: Optional[int] = None


@router.get("/policy")
async def get_policy():
    return gpu.policy.__dict__


@router.post("/policy")
async def set_policy(body: PolicyUpdate):
    gpu.policy.update(**body.model_dump(exclude_none=True))
    gpu.reaper.start(reap_idle_generators)
    return gpu.policy.__dict__


@router.post("/unload-idle")
async def unload_idle():
    released = await asyncio.to_thread(reap_idle_generators)
    return {"released": released}
