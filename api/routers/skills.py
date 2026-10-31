"""Skill management routes (see services/skills.py)."""

from __future__ import annotations

import asyncio
from typing import Optional
from urllib.error import URLError

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import skills

router = APIRouter(prefix="/skills", tags=["skills"])


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, "Skill not found") from exc
    except skills.SkillError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (URLError, OSError) as exc:
        raise HTTPException(502, f"Download failed: {exc}") from exc


class SaveSkill(BaseModel):
    content: str = Field(min_length=1)
    original_name: Optional[str] = None


class Toggle(BaseModel):
    enabled: bool


class InstallRequest(BaseModel):
    url: Optional[str] = None
    path: Optional[str] = None


TEMPLATE = """---
name: my-skill
description: What this skill does, and when the copilot should use it.
---
# My skill

Write the steps or rules the copilot should follow here.
"""


@router.get("")
async def list_skills():
    return await asyncio.to_thread(skills.list_skills)


@router.get("/template")
async def template():
    return {"content": TEMPLATE}


@router.get("/{name}")
async def get_skill(name: str):
    return await asyncio.to_thread(_call, skills.get_skill, name)


@router.put("")
async def save_skill(body: SaveSkill):
    return await asyncio.to_thread(_call, skills.save_skill, body.content, body.original_name)


@router.post("/{name}/enabled")
async def set_enabled(name: str, body: Toggle):
    return await asyncio.to_thread(_call, skills.set_enabled, name, body.enabled)


@router.delete("/{name}")
async def delete_skill(name: str):
    return {"deleted": await asyncio.to_thread(_call, skills.delete_skill, name)}


@router.post("/install")
async def install(body: InstallRequest):
    if body.url:
        names = await asyncio.to_thread(_call, skills.install_from_github, body.url)
    elif body.path:
        names = await asyncio.to_thread(_call, skills.install_from_folder, body.path)
    else:
        raise HTTPException(400, "Provide a GitHub url or a folder path")
    return {"installed": names}
