"""Image generation routes (see services/image_engine.py)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import services.generator_registry as registry
from services import gpu, image_engine
from services.priority_queue import normalize_priority

router = APIRouter(prefix="/images", tags=["images"])

_jobs: dict[str, dict[str, Any]] = {}
_cancel: dict[str, threading.Event] = {}
_downloads: dict[str, dict[str, Any]] = {}
_download_cancel: dict[str, threading.Event] = {}


def output_dir() -> Path:
    path = registry.WORKSPACE_DIR / "Images"
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Status, engine and models
# ---------------------------------------------------------------------------

@router.get("/status")
async def status():
    models = await asyncio.to_thread(image_engine.list_models)
    return {
        "engine_installed": image_engine.engine_installed(),
        "models": models,
        "default_model": image_engine.default_model_id(),
        "downloads": _downloads,
        "max_references": image_engine.MAX_REFERENCES,
    }


def _start_download(key: str, work) -> None:
    if _downloads.get(key, {}).get("running"):
        return
    cancel = threading.Event()
    _download_cancel[key] = cancel
    _downloads[key] = {"running": True, "percent": 0, "status": "Starting…"}

    def progress(msg: dict) -> None:
        _downloads[key] = {**_downloads.get(key, {}), **msg, "running": True}

    def worker() -> None:
        try:
            work(progress, cancel.is_set)
            _downloads[key] = {"running": False, "percent": 100, "status": "done", "done": True}
        except image_engine.DownloadCancelled:
            _downloads[key] = {"running": False, "status": "cancelled", "cancelled": True}
        except Exception as exc:  # noqa: BLE001 — reported to the UI
            _downloads[key] = {"running": False, "status": "error", "error": str(exc)}

    threading.Thread(target=worker, daemon=True, name=f"imagegen-{key}").start()


async def _watch(key: str):
    async def stream():
        while True:
            state = _downloads.get(key, {})
            yield f"data: {json.dumps(state)}\n\n"
            if not state.get("running"):
                return
            await asyncio.sleep(0.5)
    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/engine/install")
async def install_engine():
    if not image_engine.engine_installed():
        _start_download("engine", image_engine.install_engine)
    else:
        _downloads["engine"] = {"running": False, "status": "done", "done": True, "percent": 100}
    return await _watch("engine")


@router.get("/models/{model_id}/download")
async def download_model(model_id: str):
    try:
        image_engine.get_model(model_id)
    except KeyError as exc:
        raise HTTPException(404, "Unknown image model") from exc
    _start_download(model_id, lambda progress, cancelled: image_engine.download_model(model_id, progress, cancelled))
    return await _watch(model_id)


@router.post("/models/{model_id}/download/cancel")
async def cancel_download(model_id: str):
    event = _download_cancel.get(model_id)
    if event:
        event.set()
    return {"cancelled": bool(event)}


@router.delete("/models/{model_id}")
async def delete_model(model_id: str):
    try:
        return {"deleted": await asyncio.to_thread(image_engine.delete_model, model_id)}
    except KeyError as exc:
        raise HTTPException(404, "Unknown image model") from exc


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=1000)
    references: list[str] = Field(default_factory=list)  # data URLs or /workspace/ paths
    model_id: Optional[str] = None
    width: Optional[int] = Field(default=None, ge=256, le=2048)
    height: Optional[int] = Field(default=None, ge=256, le=2048)
    steps: Optional[int] = Field(default=None, ge=1, le=100)
    seed: Optional[int] = None
    strength: float = Field(default=0.6, ge=0.05, le=0.95)
    purpose: str = "image"
    priority: str = "normal"


def _reference_file(raw: str, folder: Path, index: int) -> Path:
    match = re.match(r"^data:image/([\w.+-]+);base64,(.+)$", raw, re.S)
    if match:
        try:
            data = base64.b64decode(match.group(2), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(400, f"Reference {index + 1} is not valid base64") from exc
        if len(data) > 25 * 1024 * 1024:
            raise HTTPException(400, f"Reference {index + 1} is larger than 25 MB")
        path = folder / f"ref{index}.png"
        _write_png(data, path)
        return path
    rel = raw.removeprefix("/workspace/")
    target = (registry.WORKSPACE_DIR / rel).resolve()
    if not registry.is_within_workspace(target) or not target.is_file():
        raise HTTPException(400, f"Reference {index + 1} not found")
    path = folder / f"ref{index}.png"
    _write_png(target.read_bytes(), path)
    return path


def _write_png(data: bytes, path: Path) -> None:
    """Normalise any picture to RGB PNG — the engine reads PNG/JPEG only."""
    import io
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, "A reference picture could not be read") from exc
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.split()[-1])
        image = background
    image.convert("RGB").save(path, format="PNG")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "image"


def _free_vram_for_images() -> None:
    """Image models are large: release 3D models and LLMs first (if allowed)."""
    if gpu.policy.unload_before_launch != "auto":
        return
    try:
        from routers.gpu import release, resident_allocations

        release([r for r in resident_allocations() if not r.get("busy")])
    except Exception:  # noqa: BLE001 — advisory only
        pass


@router.post("/generate")
async def generate(body: GenerateRequest):
    if not image_engine.engine_installed():
        raise HTTPException(409, "The image engine is not installed yet")
    model_id = body.model_id or image_engine.default_model_id()
    if model_id is None:
        raise HTTPException(409, "No image model is downloaded yet")
    try:
        model = image_engine.get_model(model_id)
    except KeyError as exc:
        raise HTTPException(404, "Unknown image model") from exc
    if not image_engine.is_downloaded(model):
        raise HTTPException(409, f"{model['name']} is not downloaded yet")
    if len(body.references) > image_engine.MAX_REFERENCES:
        raise HTTPException(400, f"At most {image_engine.MAX_REFERENCES} reference pictures")

    job_id = uuid.uuid4().hex
    scratch = Path(tempfile.mkdtemp(prefix="polypal_img_"))
    references = [_reference_file(raw, scratch, i) for i, raw in enumerate(body.references)]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output = output_dir() / f"{stamp}-{_slug(body.prompt)}-{job_id[:6]}.png"
    request = image_engine.ImageRequest(
        prompt=body.prompt, negative=body.negative, references=references, model_id=model_id,
        width=body.width, height=body.height, steps=body.steps, seed=body.seed,
        strength=body.strength, purpose=body.purpose,
    )
    job = {"id": job_id, "status": "pending", "progress": 0, "step": "Waiting…", "url": None, "error": None,
           "prompt": body.prompt, "model_id": model_id, "created": time.time()}
    _jobs[job_id] = job
    cancel = threading.Event()
    _cancel[job_id] = cancel

    def work() -> None:
        if cancel.is_set():
            job["status"] = "cancelled"
            return
        job["status"] = "running"
        try:
            _free_vram_for_images()

            def progress(pct: int, step: str) -> None:
                job["progress"], job["step"] = max(job["progress"], pct), step

            image_engine.run(request, output, progress, cancel)
            meta = {"prompt": body.prompt, "negative": body.negative, "model_id": model_id, "purpose": body.purpose,
                    "references": len(references), "seed": request.seed, "created_at": datetime.now().isoformat()}
            output.with_suffix(".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            rel = output.relative_to(registry.WORKSPACE_DIR).as_posix()
            job.update(status="done", progress=100, step="Done", url=f"/workspace/{rel}", path=rel)
        except Exception as exc:  # noqa: BLE001 — reported to the UI
            job.update(status="cancelled" if cancel.is_set() else "error", error=str(exc))
        finally:
            import shutil
            shutil.rmtree(scratch, ignore_errors=True)

    # Same single GPU worker as 3D generation, so the two never compete for VRAM.
    from routers.generation import _generation_queue

    _generation_queue.submit(f"image-{job_id}", normalize_priority(body.priority), work)
    return {"job_id": job_id, "model_id": model_id}


@router.get("/jobs/{job_id}")
async def job_status(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown image job")
    return job


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    event = _cancel.get(job_id)
    if event is None:
        raise HTTPException(404, "Unknown image job")
    event.set()
    return {"cancelled": True}


@router.get("/gallery")
async def gallery(limit: int = 60):
    def collect():
        items = []
        for png in sorted(output_dir().glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
            meta: dict[str, Any] = {}
            try:
                meta = json.loads(png.with_suffix(".json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            rel = png.relative_to(registry.WORKSPACE_DIR).as_posix()
            items.append({"url": f"/workspace/{rel}", "path": rel, "prompt": meta.get("prompt", ""),
                          "model_id": meta.get("model_id"), "created_at": meta.get("created_at")})
        return items
    return await asyncio.to_thread(collect)


@router.delete("/gallery")
async def delete_image(path: str):
    target = (registry.WORKSPACE_DIR / path.removeprefix("/workspace/")).resolve()
    images = output_dir().resolve()
    if images not in target.parents or target.suffix.lower() != ".png" or not target.is_file():
        raise HTTPException(400, "Not a generated image")
    target.unlink()
    target.with_suffix(".json").unlink(missing_ok=True)
    return {"deleted": True}
