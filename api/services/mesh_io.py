"""Shared mesh loading helpers.

A GLB stores node transforms in its scene graph. Concatenating
``scene.geometry.values()`` drops those transforms, so a mesh whose gizmo pose
was baked at scene level (see ``/optimize/transform``) would silently lose it
on the next edit or export. Every caller that needs one flat mesh goes through
``flatten_scene`` instead.
"""

from pathlib import Path
from typing import Any


def flatten_scene(loaded: Any, trimesh_module: Any = None) -> Any:
    """Return a single Trimesh with scene-graph node transforms baked in.

    Raises ``ValueError`` for a scene with no geometry or for unsupported
    contents (e.g. a bare point cloud).
    """
    if trimesh_module is None:
        import trimesh as trimesh_module

    if isinstance(loaded, trimesh_module.Trimesh):
        return loaded
    if isinstance(loaded, trimesh_module.Scene):
        if len(loaded.geometry) == 0:
            raise ValueError("Mesh contains no geometry")
        # The spelling varies across trimesh versions: to_mesh()/to_geometry()
        # are the modern APIs (4.6+); dump(concatenate=True) is the 4.5 fallback.
        for flatten in (
            lambda s: s.to_mesh(),
            lambda s: s.to_geometry(),
            lambda s: s.dump(concatenate=True),
        ):
            try:
                result = flatten(loaded)
            except (AttributeError, TypeError):
                continue
            if isinstance(result, trimesh_module.Trimesh):
                return result
            if isinstance(result, (list, tuple)) and result:
                return trimesh_module.util.concatenate(list(result))
        return trimesh_module.util.concatenate(list(loaded.geometry.values()))
    raise ValueError("Unsupported mesh contents")


def load_flat_mesh(path: Path, trimesh_module: Any = None) -> Any:
    """Load ``path`` and flatten it to one Trimesh (transforms baked)."""
    if trimesh_module is None:
        import trimesh as trimesh_module
    return flatten_scene(trimesh_module.load(str(path)), trimesh_module)


def load_scene(path: Path, trimesh_module: Any = None) -> Any:
    """Load ``path`` as a Scene so materials, UVs and node structure survive."""
    if trimesh_module is None:
        import trimesh as trimesh_module
    loaded = trimesh_module.load(str(path))
    if isinstance(loaded, trimesh_module.Trimesh):
        return trimesh_module.Scene(loaded)
    if isinstance(loaded, trimesh_module.Scene):
        if len(loaded.geometry) == 0:
            raise ValueError("Mesh contains no geometry")
        return loaded
    raise ValueError("Unsupported mesh contents")
