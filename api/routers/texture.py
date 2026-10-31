"""Texturing routes: paint a mesh from a picture (see services/texturing.py)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import services.generator_registry as registry
from services import provenance, texturing

router = APIRouter(prefix="/texture", tags=["texture"])


class ProjectRequest(BaseModel):
    path: str
    image: Optional[str] = None       # data URL; omitted = the picture the model was generated from
    image_path: Optional[str] = None  # or a workspace image path
    view: Optional[str] = None        # force a side; omitted = detect
    back_image: Optional[str] = None  # optional data URL of the opposite side (e.g. a generated back view)
    remove_lighting: bool = True      # divide the photo's own lighting out of the colours


def _decode_data_url(value: str) -> bytes:
    match = re.match(r"^data:image/[\w.+-]+;base64,(.+)$", value, re.S)
    if not match:
        raise HTTPException(400, "image must be a data URL")
    try:
        return base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, "image is not valid base64") from exc


def _image_bytes(body: ProjectRequest, mesh_path) -> bytes:
    if body.image:
        match = re.match(r"^data:image/[\w.+-]+;base64,(.+)$", body.image, re.S)
        if not match:
            raise HTTPException(400, "image must be a data URL")
        try:
            return base64.b64decode(match.group(1), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(400, "image is not valid base64") from exc
    if body.image_path:
        raw = body.image_path.removeprefix("/workspace/")
        target = (registry.WORKSPACE_DIR / raw).resolve()
        if not registry.is_within_workspace(target) or not target.is_file():
            raise HTTPException(400, "Invalid image path")
        return target.read_bytes()
    root = provenance.root_generation(mesh_path)
    data = provenance.load_input_image(root) if root else None
    if data is None:
        raise HTTPException(409, "No source picture is recorded for this model — choose one to paint from")
    return data


@router.get("/views")
def views():
    return list(texturing.VIEWS)


@router.post("/project")
async def project(body: ProjectRequest):
    from routers.edit import compute_stats, resolve_mesh_path

    mesh_path = resolve_mesh_path(body.path)
    image = _image_bytes(body, mesh_path)
    out_dir = mesh_path.parent if registry.is_within_workspace(mesh_path) else registry.WORKSPACE_DIR / "Edits"
    output = out_dir / f"{mesh_path.stem}_textured_{uuid.uuid4().hex[:8]}.glb"
    try:
        extras = [(_decode_data_url(body.back_image), "opposite")] if body.back_image else []
        details = await asyncio.to_thread(
            texturing.texture_mesh_file, mesh_path, image, output, body.view, extras, body.remove_lighting,
        )
    except texturing.TexturingError as exc:
        raise HTTPException(422, str(exc)) from exc
    provenance.record_edit(output, mesh_path, steps=[{
        "op": "texture_projection", "label": "Texture from picture", "params": {"view": body.view, "back_view": bool(body.back_image), "remove_lighting": body.remove_lighting}, "details": details,
    }], source="texture")
    rel = provenance.relative_to_workspace(output)
    stats = await asyncio.to_thread(compute_stats, output)
    return {"path": rel, "url": f"/workspace/{rel}", "details": details, "stats": stats}
