"""Generated mesh routes (see services/meshes.py)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import meshes

router = APIRouter(prefix="/meshes", tags=["meshes"])


class DeleteRequest(BaseModel):
    paths: list[str]


@router.get("")
async def list_meshes(limit: int = 200):
    return await asyncio.to_thread(meshes.list_meshes, max(1, min(limit, 1000)))


@router.post("/delete")
async def delete_meshes(body: DeleteRequest):
    """Delete several meshes (e.g. every version of one model) in one call."""
    deleted: list[str] = []
    for path in body.paths[:500]:
        try:
            if await asyncio.to_thread(meshes.delete_mesh, path):
                deleted.append(path)
        except meshes.MeshError as exc:
            raise HTTPException(400, f"{path}: {exc}") from exc
    return {"deleted": deleted}
