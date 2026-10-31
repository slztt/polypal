"""The local model library: named, categorised copies of models the user keeps.

Each item is a folder under ``<workspace>/Library/<id>/`` holding the mesh
(``model.<ext>``), an optional ``thumbnail.png`` and ``item.json`` with the
name, category, tags, notes and where it came from. Categories are kept in
``<workspace>/Library/categories.json`` so empty categories survive.

Items are copies, so editing or deleting the original never changes the
library — and the library keeps its own provenance sidecar so a saved model
can still be regenerated.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import services.generator_registry as registry
from services import provenance

MODEL_SUFFIXES = {".glb", ".gltf", ".obj", ".stl", ".ply", ".splat"}
MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024
DEFAULT_CATEGORY = "Uncategorised"
_ID = re.compile(r"^[a-f0-9]{32}$")


class LibraryError(ValueError):
    pass


def root() -> Path:
    path = registry.WORKSPACE_DIR / "Library"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _item_dir(item_id: str) -> Path:
    if not _ID.fullmatch(item_id or ""):
        raise LibraryError("Invalid library item id")
    return root() / item_id


def _clean_text(value: Optional[str], limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _public(item: dict[str, Any], folder: Path) -> dict[str, Any]:
    rel = folder.relative_to(registry.WORKSPACE_DIR)
    base = f"/workspace/{rel.as_posix()}"
    return {
        **item,
        "url": f"{base}/{item['file']}",
        "thumbnail_url": f"{base}/thumbnail.png" if (folder / "thumbnail.png").is_file() else None,
    }


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------

def _categories_path() -> Path:
    return root() / "categories.json"


def list_categories() -> list[str]:
    try:
        stored = json.loads(_categories_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        stored = []
    used = {item["category"] for item in list_items()}
    names = {c for c in stored if isinstance(c, str) and c} | used | {DEFAULT_CATEGORY}
    return sorted(names, key=lambda c: (c != DEFAULT_CATEGORY, c.lower()))


def add_category(name: str) -> list[str]:
    name = _clean_text(name, 60)
    if not name:
        raise LibraryError("Category name is required")
    current = [c for c in list_categories() if c != DEFAULT_CATEGORY]
    if name not in current:
        current.append(name)
    _write_json(_categories_path(), sorted(current, key=str.lower))
    return list_categories()


def remove_category(name: str) -> list[str]:
    """Delete a category; its items move to Uncategorised."""
    if name == DEFAULT_CATEGORY:
        raise LibraryError("The default category can't be removed")
    for item in list_items():
        if item["category"] == name:
            update_item(item["id"], category=DEFAULT_CATEGORY)
    remaining = [c for c in list_categories() if c not in (name, DEFAULT_CATEGORY)]
    _write_json(_categories_path(), remaining)
    return list_categories()


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------

def _resolve_source(raw: str) -> Path:
    raw = (raw or "").strip()
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    if raw.startswith("/optimize/serve-file?path="):
        from urllib.parse import unquote
        raw = unquote(raw.split("path=", 1)[1])
    candidate = Path(raw)
    path = candidate.resolve() if candidate.is_absolute() else (registry.WORKSPACE_DIR / raw).resolve()
    if not candidate.is_absolute() and not registry.is_within_workspace(path):
        raise LibraryError("Invalid path")
    if not path.is_file():
        raise FileNotFoundError(f"File not found: {raw}")
    if path.suffix.lower() not in MODEL_SUFFIXES:
        raise LibraryError(f"Unsupported model format: {path.suffix}")
    return path


def _decode_thumbnail(data_url: Optional[str]) -> Optional[bytes]:
    if not data_url:
        return None
    match = re.match(r"^data:image/png;base64,(.+)$", data_url, re.S)
    if not match:
        raise LibraryError("Thumbnail must be a PNG data URL")
    try:
        data = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise LibraryError("Thumbnail is not valid base64") from exc
    if len(data) > MAX_THUMBNAIL_BYTES or not data.startswith(b"\x89PNG"):
        raise LibraryError("Thumbnail must be a PNG under 4 MB")
    return data


def save_item(
    source: str,
    *,
    name: str,
    category: Optional[str] = None,
    tags: Optional[list[str]] = None,
    notes: Optional[str] = None,
    thumbnail: Optional[str] = None,
) -> dict[str, Any]:
    source_path = _resolve_source(source)
    name = _clean_text(name, 80) or source_path.stem
    category = _clean_text(category, 60) or DEFAULT_CATEGORY
    thumb = _decode_thumbnail(thumbnail)

    item_id = uuid.uuid4().hex
    folder = _item_dir(item_id)
    folder.mkdir(parents=True)
    try:
        file_name = f"model{source_path.suffix.lower()}"
        shutil.copyfile(source_path, folder / file_name)
        sidecar = provenance.sidecar_for(source_path)
        if sidecar.is_file():
            shutil.copyfile(sidecar, provenance.sidecar_for(folder / file_name))
        if thumb:
            (folder / "thumbnail.png").write_bytes(thumb)
        record = provenance.read_record(source_path) or {}
        item = {
            "id": item_id,
            "name": name,
            "category": category,
            "tags": sorted({_clean_text(t, 30) for t in (tags or []) if _clean_text(t, 30)}),
            "notes": _clean_text(notes, 1000),
            "file": file_name,
            "format": source_path.suffix.lower().lstrip("."),
            "bytes": (folder / file_name).stat().st_size,
            "source": provenance.relative_to_workspace(source_path) or str(source_path),
            "model_name": ((record.get("generation") or {}).get("model_name")),
            "units": record.get("units"),
            "created_at": _now(),
            "updated_at": _now(),
        }
        _write_json(folder / "item.json", item)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    if category != DEFAULT_CATEGORY and category not in list_categories():
        add_category(category)
    return _public(item, folder)


def _read_item(folder: Path) -> Optional[dict[str, Any]]:
    try:
        item = json.loads((folder / "item.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(item, dict) or not (folder / str(item.get("file", ""))).is_file():
        return None
    return item


def list_items(query: str = "", category: Optional[str] = None) -> list[dict[str, Any]]:
    needle = query.strip().lower()
    items = []
    for folder in root().iterdir():
        if not folder.is_dir() or not _ID.fullmatch(folder.name):
            continue
        item = _read_item(folder)
        if item is None:
            continue
        if category and item.get("category") != category:
            continue
        haystack = " ".join([item.get("name", ""), item.get("category", ""), item.get("notes", ""), *item.get("tags", [])]).lower()
        if needle and needle not in haystack:
            continue
        items.append(_public(item, folder))
    items.sort(key=lambda i: i.get("updated_at") or "", reverse=True)
    return items


def get_item(item_id: str) -> dict[str, Any]:
    folder = _item_dir(item_id)
    item = _read_item(folder)
    if item is None:
        raise KeyError(item_id)
    return _public(item, folder)


def update_item(item_id: str, **changes: Any) -> dict[str, Any]:
    folder = _item_dir(item_id)
    item = _read_item(folder)
    if item is None:
        raise KeyError(item_id)
    if changes.get("name") is not None:
        item["name"] = _clean_text(changes["name"], 80) or item["name"]
    if changes.get("category") is not None:
        item["category"] = _clean_text(changes["category"], 60) or DEFAULT_CATEGORY
    if changes.get("tags") is not None:
        item["tags"] = sorted({_clean_text(t, 30) for t in changes["tags"] if _clean_text(t, 30)})
    if changes.get("notes") is not None:
        item["notes"] = _clean_text(changes["notes"], 1000)
    if changes.get("thumbnail"):
        (folder / "thumbnail.png").write_bytes(_decode_thumbnail(changes["thumbnail"]))
    item["updated_at"] = _now()
    _write_json(folder / "item.json", item)
    return _public(item, folder)


def delete_item(item_id: str) -> bool:
    folder = _item_dir(item_id)
    if not folder.is_dir():
        return False
    shutil.rmtree(folder)
    return True
