"""Generation provenance: where every model in the workspace came from.

Each mesh PolyPal writes into the workspace gets a sidecar
``<mesh>.provenance.json`` describing how it was made:

* ``generation`` — model, exact parameters (with a resolved seed), the input
  image (stored content-addressed under ``.polypal/inputs``) and timing;
* ``edit`` — the operation(s) applied and the ``parent`` mesh they were
  applied to.

Following ``parent`` links gives the full lineage back to the generation, which
is what one-click regeneration replays. Sidecars are best-effort: a failure to
write one never fails the generation or edit that produced the mesh.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import services.generator_registry as registry
from services.app_info import APP_VERSION

SCHEMA_VERSION = 1
SIDECAR_SUFFIX = ".provenance.json"
INPUTS_DIR = Path(".polypal") / "inputs"
MAX_LINEAGE = 64
SEED_PARAM_IDS = ("seed",)
MAX_SEED = 2**31 - 1

_IMAGE_EXTENSIONS = {
    b"\x89PNG": ".png",
    b"\xff\xd8\xff": ".jpg",
    b"RIFF": ".webp",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _workspace() -> Path:
    return registry.WORKSPACE_DIR.resolve()


def relative_to_workspace(path: Path) -> Optional[str]:
    """Workspace-relative POSIX path, or None for files outside the workspace."""
    try:
        return Path(path).resolve().relative_to(_workspace()).as_posix()
    except (OSError, ValueError):
        return None


def sidecar_for(mesh_path: Path) -> Path:
    return Path(f"{mesh_path}{SIDECAR_SUFFIX}")


def read_record(mesh_path: Path) -> Optional[dict[str, Any]]:
    sidecar = sidecar_for(mesh_path)
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_record(mesh_path: Path, record: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Atomically write the sidecar. Returns the record, or None on failure."""
    sidecar = sidecar_for(mesh_path)
    tmp = sidecar.with_name(sidecar.name + ".tmp")
    try:
        tmp.write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
        os.replace(tmp, sidecar)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        return None
    return record


# ---------------------------------------------------------------------------
# Seeds
# ---------------------------------------------------------------------------

def resolve_seed(params: dict[str, Any], schema: Iterable[dict[str, Any]] = ()) -> tuple[dict[str, Any], bool]:
    """Pin a random seed so the run can be replayed exactly.

    A seed of ``None``/negative/"random" (or a schema-declared seed the caller
    did not set and whose default is random) is replaced with a concrete random
    integer — behaviourally identical for the extension, but now recorded.
    Returns ``(params, deterministic)``; deterministic is False when the model
    exposes no seed at all.
    """
    resolved = dict(params)
    declared = {p.get("id"): p for p in schema if isinstance(p, dict)}
    seed_key = next((k for k in SEED_PARAM_IDS if k in resolved or k in declared), None)
    if seed_key is None:
        return resolved, False
    value = resolved.get(seed_key, declared.get(seed_key, {}).get("default"))
    if _is_random_seed(value):
        resolved[seed_key] = random.randint(0, MAX_SEED)
    elif seed_key not in resolved:
        resolved[seed_key] = value
    return resolved, True


def _is_random_seed(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        stripped = value.strip().lower()
        if stripped in ("", "random", "-1"):
            return True
        try:
            return int(stripped) < 0
        except ValueError:
            return False
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value < 0
    return False


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def store_input_image(image_bytes: bytes, filename: Optional[str] = None) -> dict[str, Any]:
    """Keep a content-addressed copy of the input so regeneration can replay it."""
    digest = hashlib.sha256(image_bytes).hexdigest()
    suffix = next((ext for magic, ext in _IMAGE_EXTENSIONS.items() if image_bytes.startswith(magic)), ".png")
    relative = INPUTS_DIR / f"{digest}{suffix}"
    target = _workspace() / relative
    info: dict[str, Any] = {"kind": "image", "sha256": digest, "filename": filename, "bytes": len(image_bytes)}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            tmp = target.with_name(target.name + ".tmp")
            tmp.write_bytes(image_bytes)
            os.replace(tmp, target)
        info["stored_path"] = relative.as_posix()
    except OSError:
        info["stored_path"] = None
    return info


def load_input_image(record: dict[str, Any]) -> Optional[bytes]:
    stored = ((record.get("generation") or {}).get("input") or {}).get("stored_path")
    if not stored:
        return None
    path = (_workspace() / stored).resolve()
    if not registry.is_within_workspace(path) or not path.is_file():
        return None
    data = path.read_bytes()
    expected = record["generation"]["input"].get("sha256")
    if expected and hashlib.sha256(data).hexdigest() != expected:
        return None
    return data


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

def record_generation(
    output_path: Path,
    *,
    model_id: str,
    manifest: Optional[dict[str, Any]],
    params: dict[str, Any],
    deterministic: bool,
    input_info: Optional[dict[str, Any]],
    collection: str,
    started_at: float,
    priority: Optional[str] = None,
    regenerated_from: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    output_rel = relative_to_workspace(output_path)
    if output_rel is None:
        return None
    manifest = manifest or {}
    record = {
        "schema": SCHEMA_VERSION,
        "kind": "generation",
        "created_at": _now(),
        "app_version": APP_VERSION,
        "output": output_rel,
        "parent": None,
        "units": None,
        "generation": {
            "model_id": model_id,
            "model_name": manifest.get("name", model_id),
            "model_version": manifest.get("version", ""),
            "params": params,
            "deterministic": deterministic,
            "input": input_info,
            "collection": collection,
            "duration_s": round(max(0.0, time.monotonic() - started_at), 2),
            "priority": priority,
            "regenerated_from": regenerated_from,
        },
    }
    return _write_record(Path(output_path), record)


def record_edit(
    output_path: Path,
    parent_path: Path,
    *,
    steps: list[dict[str, Any]],
    source: str = "editor",
    instruction: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Record an edit. ``steps`` are ``{op, label?, params, details?}`` dicts."""
    output_rel = relative_to_workspace(output_path)
    if output_rel is None:
        return None
    parent_rel = relative_to_workspace(parent_path)
    parent = read_record(Path(parent_path)) if parent_rel else None

    # Real-world units carry down the lineage unless an edit sets them anew.
    units = (parent or {}).get("units")
    real_world = (parent or {}).get("real_world")
    for step in steps:
        details = step.get("details") or {}
        if details.get("units"):
            units = details["units"]
            real_world = details.get("real_world", real_world)

    record = {
        "schema": SCHEMA_VERSION,
        "kind": "edit",
        "created_at": _now(),
        "app_version": APP_VERSION,
        "output": output_rel,
        "parent": parent_rel,
        "parent_external": None if parent_rel else str(parent_path),
        "units": units,
        "real_world": real_world,
        "edit": {
            "source": source,
            "instruction": instruction,
            "steps": steps,
        },
    }
    return _write_record(Path(output_path), record)


# ---------------------------------------------------------------------------
# Reading lineage
# ---------------------------------------------------------------------------

def lineage(mesh_path: Path) -> list[dict[str, Any]]:
    """Records from the root (usually a generation) down to ``mesh_path``."""
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    current: Optional[Path] = Path(mesh_path)
    while current is not None and len(chain) < MAX_LINEAGE:
        record = read_record(current)
        if record is None:
            break
        key = record.get("output") or str(current)
        if key in seen:
            break  # defensive: a hand-edited sidecar could form a cycle
        seen.add(key)
        chain.append(record)
        parent = record.get("parent")
        current = (_workspace() / parent) if parent else None
    chain.reverse()
    return chain


def root_generation(mesh_path: Path) -> Optional[dict[str, Any]]:
    for record in lineage(mesh_path):
        if record.get("kind") == "generation":
            return record
    return None


def units_for(mesh_path: Path) -> Optional[str]:
    record = read_record(Path(mesh_path))
    return (record or {}).get("units")
