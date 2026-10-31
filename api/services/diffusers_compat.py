"""Keep diffusers-based extensions loading on newer diffusers releases.

A diffusers pipeline's ``model_index.json`` names, for each component, the
library to load it from — e.g. ``["triposg.schedulers.scheduling_rectified_flow",
"RectifiedFlowScheduler"]``. Older diffusers imported such modules on demand;
newer releases refuse anything not already imported ("is not one of the
libraries Diffusers can load components from"), so extensions written before
that change (TripoSG and others) fail at ``from_pretrained``.

Before a generator loads, the runner pre-imports the custom modules named by
the model's ``model_index.json`` — but only modules that live inside the
extension's own directory. That is code the user already installed and runs
anyway, so this restores the old behaviour without letting a downloaded
config import arbitrary modules.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
from pathlib import Path
from typing import Iterable

BUILTIN_LIBRARIES = {"diffusers", "transformers", "onnxruntime", "onnxruntime.training"}


def _named_libraries(index: dict) -> list[str]:
    names = []
    for value in index.values():
        if (
            isinstance(value, (list, tuple))
            and len(value) == 2
            and isinstance(value[0], str)
            and value[0]
            and value[0] not in BUILTIN_LIBRARIES
        ):
            names.append(value[0])
    return names


def _is_inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _origin_of(module_name: str) -> Path | None:
    try:
        spec = importlib.util.find_spec(module_name)
    except (ImportError, ValueError, AttributeError):
        return None
    if spec is None or not spec.origin or spec.origin in ("built-in", "frozen"):
        return None
    return Path(spec.origin)


def preimport_pipeline_modules(model_dirs: Iterable[Path], extension_dir: Path) -> list[str]:
    """Import extension-local modules named in model_index.json files.

    Looks at ``model_index.json`` directly inside each model directory and one
    level below (pipelines stored in a sub-folder). Returns the modules
    imported; never raises — a failure here only means diffusers reports its
    own, clearer error later.
    """
    imported: list[str] = []
    seen: set[str] = set()
    for model_dir in model_dirs:
        model_dir = Path(model_dir)
        if not model_dir.is_dir():
            continue
        indexes = [model_dir / "model_index.json", *model_dir.glob("*/model_index.json")]
        for index_path in indexes:
            try:
                index = json.loads(index_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(index, dict):
                continue
            for name in _named_libraries(index):
                if name in seen:
                    continue
                seen.add(name)
                origin = _origin_of(name)
                if origin is None or not _is_inside(origin, extension_dir):
                    continue
                try:
                    importlib.import_module(name)
                    imported.append(name)
                except Exception:  # noqa: BLE001 — let diffusers report the real problem
                    continue
    return imported
