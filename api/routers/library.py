"""Local model library routes (see services/library.py)."""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import library

router = APIRouter(prefix="/library", tags=["library"])


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, "Library item not found") from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except library.LibraryError as exc:
        raise HTTPException(400, str(exc)) from exc


class SaveRequest(BaseModel):
    source: str
    name: str = Field(default="", max_length=200)
    category: Optional[str] = None
    tags: list[str] = []
    notes: Optional[str] = None
    thumbnail: Optional[str] = None  # PNG data URL


class UpdateRequest(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    notes: Optional[str] = None
    thumbnail: Optional[str] = None


class CategoryRequest(BaseModel):
    name: str


@router.get("/items")
async def list_items(q: str = "", category: Optional[str] = None):
    return await asyncio.to_thread(library.list_items, q, category)


@router.post("/items")
async def save_item(body: SaveRequest):
    return await asyncio.to_thread(
        _call, library.save_item, body.source,
        name=body.name, category=body.category, tags=body.tags, notes=body.notes, thumbnail=body.thumbnail,
    )


@router.get("/items/{item_id}")
async def get_item(item_id: str):
    return await asyncio.to_thread(_call, library.get_item, item_id)


@router.patch("/items/{item_id}")
async def update_item(item_id: str, body: UpdateRequest):
    return await asyncio.to_thread(_call, library.update_item, item_id, **body.model_dump(exclude_none=True))


@router.delete("/items/{item_id}")
async def delete_item(item_id: str):
    return {"deleted": await asyncio.to_thread(_call, library.delete_item, item_id)}


@router.get("/categories")
async def categories():
    return await asyncio.to_thread(library.list_categories)


@router.post("/categories")
async def add_category(body: CategoryRequest):
    return await asyncio.to_thread(_call, library.add_category, body.name)


@router.delete("/categories/{name}")
async def remove_category(name: str):
    return await asyncio.to_thread(_call, library.remove_category, name)
