"""Generated meshes in the workspace: list them and delete them.

The Library keeps its own copies (``Library/``) and is managed separately, so
it is never listed or touched here; neither are generated images or hidden
PolyPal folders.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import services.generator_registry as registry
from services import provenance

MESH_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl", ".ply"}
_SKIP_DIRS = {"Library", "Images"}


class MeshError(Exception):
    pass


def _root() -> Path:
    return registry.WORKSPACE_DIR.resolve()


def _skipped(rel: Path) -> bool:
    first = rel.parts[0] if rel.parts else ""
    return first in _SKIP_DIRS or any(p.startswith(".") for p in rel.parts)


def _thumbnail(mesh: Path) -> Optional[str]:
    """The picture the mesh was generated from, following edits back to it."""
    current: Optional[Path] = mesh
    for _ in range(12):
        if current is None:
            return None
        record = provenance.read_record(current)
        if not record:
            return None
        stored = ((record.get("generation") or {}).get("input") or {}).get("stored_path")
        if stored:
            return f"/workspace/{stored}"
        parent = record.get("parent")
        current = (_root() / parent) if parent else None
    return None


def _model_name(mesh: Path) -> Optional[str]:
    record = provenance.read_record(mesh) or {}
    return (record.get("generation") or {}).get("model_name")


def list_meshes(limit: int = 200) -> list[dict[str, Any]]:
    root = _root()
    if not root.is_dir():
        return []
    items: list[tuple[float, Path]] = []
    for path in root.rglob("*"):
        if path.suffix.lower() not in MESH_EXTENSIONS or not path.is_file():
            continue
        rel = path.relative_to(root)
        if _skipped(rel):
            continue
        items.append((path.stat().st_mtime, path))
    items.sort(key=lambda t: t[0], reverse=True)
    out = []
    for mtime, path in items[:limit]:
        rel = path.relative_to(root).as_posix()
        record = provenance.read_record(path) or {}
        out.append({
            "path": rel,
            "url": f"/workspace/{rel}",
            "name": path.stem,
            "collection": rel.split("/")[0] if "/" in rel else "",
            "bytes": path.stat().st_size,
            "modified_at": datetime.fromtimestamp(mtime, timezone.utc).isoformat(timespec="seconds"),
            "kind": record.get("kind") or "file",
            "model_name": _model_name(path),
            "thumbnail_url": _thumbnail(path),
        })
    return out


def _resolve(path: str) -> Path:
    raw = (path or "").strip()
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    candidate = Path(raw)
    target = candidate.resolve() if candidate.is_absolute() else (_root() / raw).resolve()
    try:
        rel = target.relative_to(_root())
    except ValueError as exc:
        raise MeshError("Only models inside the workspace can be deleted") from exc
    if not rel.parts or _skipped(rel):
        raise MeshError("That file is not a generated model")
    if target.suffix.lower() not in MESH_EXTENSIONS:
        raise MeshError("That file is not a 3D model")
    return target


def delete_mesh(path: str) -> bool:
    """Delete a mesh and its sidecars. Returns False if it was already gone."""
    target = _resolve(path)
    if not target.is_file():
        return False
    target.unlink()
    for extra in (provenance.sidecar_for(target), target.with_suffix(".meta.json")):
        try:
            extra.unlink()
        except FileNotFoundError:
            pass
    return True
