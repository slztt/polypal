"""Map Builder routes (see services/map_builder.py)."""

from __future__ import annotations

import asyncio
import re
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from services import map_builder

router = APIRouter(prefix="/maps", tags=["maps"])

MAX_UPLOAD = 40 * 1024 * 1024


def _hex_color(value: Optional[str]) -> Optional[tuple[int, int, int]]:
    if not value:
        return None
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", value.strip())
    if not match:
        raise HTTPException(400, "wall_color must look like #aabbcc")
    raw = match.group(1)
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


@router.post("/build")
async def build(
    image: UploadFile = File(...),
    name: str = Form("map"),
    width_m: Optional[float] = Form(None),
    wall_height: float = Form(2.7),
    walls: str = Form("auto"),
    wall_color: Optional[str] = Form(None),
    tolerance: float = Form(0.18),
    doors: bool = Form(True),
):
    if walls not in ("auto", "dark", "light", "color"):
        raise HTTPException(400, "walls must be auto, dark, light or color")
    data = await image.read()
    if not data:
        raise HTTPException(400, "The picture is empty")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That picture is too large (40 MB max)")
    opts = map_builder.MapOptions(
        width_m=width_m if width_m and width_m > 0 else None,
        wall_height=min(max(wall_height, 0.5), 50.0),
        walls=walls,  # type: ignore[arg-type]
        wall_color=_hex_color(wall_color),
        tolerance=tolerance,
        doors=doors,
        name=name,
    )
    try:
        return await asyncio.to_thread(map_builder.build_map, data, opts, image.filename)
    except map_builder.MapBuildError as exc:
        raise HTTPException(422, str(exc)) from exc
