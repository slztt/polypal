"""Transform, sizing and cleanup operations for the mesh editor.

Pure trimesh + numpy, so they run everywhere the API runs (no pymeshlab or
Node runtime needed). Rigid/affine operations transform the scene graph and
keep materials, UVs and node structure intact; topology operations flatten to
one mesh first (see ``services.mesh_io``).

Scene units are metres, the glTF convention, so ``scale_to_size`` is what makes
a model physically meaningful for measuring and printing.
"""

from math import isfinite, radians
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from services.mesh_analysis import (
    face_component_labels,
    orient_faces_consistently,
    signed_volume,
)
from services.mesh_io import flatten_scene, load_scene

from .types import MeshOpContext, MeshOpResult, MeshOpUnavailableError


AXIS_INDEX = {"x": 0, "y": 1, "z": 2}

# Metres per unit. Kept in sync with src/shared/utils/units.ts.
UNIT_TO_METRES = {
    "mm": 0.001,
    "cm": 0.01,
    "m": 1.0,
    "in": 0.0254,
    "ft": 0.3048,
}

# glTF is Y-up: height is the Y extent, width X, depth Z.
DIMENSION_AXIS = {"width": 0, "height": 1, "depth": 2}

MAX_SUBDIVIDED_FACES = 2_000_000


def _trimesh():
    try:
        import trimesh
    except ImportError as exc:  # pragma: no cover - trimesh is a hard dependency
        raise MeshOpUnavailableError("trimesh is not available on this system") from exc
    return trimesh


def _output(context: MeshOpContext, prefix: str) -> Path:
    # Imported lazily: operations.py pulls in the pymeshlab-facing helpers.
    from .operations import _output_path

    return _output_path(context, prefix)


def _scene_face_count(scene) -> int:
    return int(sum(len(g.faces) for g in scene.geometry.values() if hasattr(g, "faces")))


def _scene_result(scene, context: MeshOpContext, prefix: str, **details: Any) -> MeshOpResult:
    output_path = _output(context, prefix)
    scene.export(str(output_path))
    bounds = scene.bounds
    extents = (bounds[1] - bounds[0]).tolist() if bounds is not None else [0.0, 0.0, 0.0]
    context.progress(100, "Done")
    return MeshOpResult(
        file_path=output_path,
        details={"face_count": _scene_face_count(scene), "extents": extents, **details},
    )


def _mesh_result(mesh, context: MeshOpContext, prefix: str, **details: Any) -> MeshOpResult:
    output_path = _output(context, prefix)
    mesh.export(str(output_path))
    context.progress(100, "Done")
    return MeshOpResult(
        file_path=output_path,
        details={"face_count": int(len(mesh.faces)), "extents": mesh.extents.tolist(), **details},
    )


def _finite(name: str, value: Any) -> float:
    number = float(value)
    if not isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _about(point: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """``matrix`` applied about ``point`` instead of the origin."""
    to_origin = np.eye(4)
    to_origin[:3, 3] = -point
    back = np.eye(4)
    back[:3, 3] = point
    return back @ matrix @ to_origin


def _bottom_centre(bounds: np.ndarray) -> np.ndarray:
    lo, hi = bounds
    return np.array([(lo[0] + hi[0]) / 2.0, lo[1], (lo[2] + hi[2]) / 2.0])


# ---------------------------------------------------------------------------
# Rigid / affine operations (scene level — materials survive)
# ---------------------------------------------------------------------------

def rotate_mesh(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    trimesh = _trimesh()
    axis = str(params.get("axis", "y"))
    if axis not in AXIS_INDEX:
        raise ValueError("axis must be one of x, y, z")
    degrees = _finite("degrees", params.get("degrees", 90.0))
    context.progress(20, "Loading mesh…")
    scene = load_scene(input_path, trimesh)
    direction = np.zeros(3)
    direction[AXIS_INDEX[axis]] = 1.0
    centre = _bottom_centre(scene.bounds)
    rotation = trimesh.transformations.rotation_matrix(radians(degrees), direction)
    context.progress(60, f"Rotating {degrees:g}° about {axis.upper()}…")
    scene.apply_transform(_about(centre, rotation))
    if bool(params.get("reground", True)):
        _reground(scene)
    return _scene_result(scene, context, "mesh-rotate")


def mirror_mesh(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    trimesh = _trimesh()
    axis = str(params.get("axis", "x"))
    if axis not in AXIS_INDEX:
        raise ValueError("axis must be one of x, y, z")
    context.progress(20, "Loading mesh…")
    scene = load_scene(input_path, trimesh)
    # Bake into the geometry rather than the node: a negative-determinant node
    # matrix renders inside-out in some viewers, while Trimesh.apply_transform
    # flips the face winding for us.
    centre = (scene.bounds[0] + scene.bounds[1]) / 2.0
    reflect = np.eye(4)
    reflect[AXIS_INDEX[axis], AXIS_INDEX[axis]] = -1.0
    matrix = _about(centre, reflect)
    flat = flatten_scene(scene, trimesh)
    flat.apply_transform(matrix)
    context.progress(60, f"Mirrored across {axis.upper()}")
    return _mesh_result(flat, context, "mesh-mirror")


def scale_mesh(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    trimesh = _trimesh()
    factor = _finite("factor", params.get("factor", 1.0))
    if factor <= 0:
        raise ValueError("factor must be positive")
    context.progress(20, "Loading mesh…")
    scene = load_scene(input_path, trimesh)
    scene.apply_transform(_about(_bottom_centre(scene.bounds), np.diag([factor, factor, factor, 1.0])))
    return _scene_result(scene, context, "mesh-scale", scale_factor=factor)


def scale_to_size(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    """Uniformly scale so one dimension measures exactly ``size`` ``unit``."""
    trimesh = _trimesh()
    unit = str(params.get("unit", "cm"))
    if unit not in UNIT_TO_METRES:
        raise ValueError(f"unit must be one of {', '.join(UNIT_TO_METRES)}")
    dimension = str(params.get("dimension", "height"))
    size = _finite("size", params.get("size", 10.0))
    if size <= 0:
        raise ValueError("size must be positive")
    context.progress(20, "Loading mesh…")
    scene = load_scene(input_path, trimesh)
    extents = scene.bounds[1] - scene.bounds[0]
    if dimension == "longest":
        current = float(np.max(extents))
    elif dimension in DIMENSION_AXIS:
        current = float(extents[DIMENSION_AXIS[dimension]])
    else:
        raise ValueError("dimension must be one of width, height, depth, longest")
    if current <= 1e-12:
        raise ValueError(f"The mesh has no {dimension} to scale")
    target_metres = size * UNIT_TO_METRES[unit]
    factor = target_metres / current
    context.progress(60, f"Scaling {dimension} to {size:g} {unit}…")
    scene.apply_transform(_about(_bottom_centre(scene.bounds), np.diag([factor, factor, factor, 1.0])))
    return _scene_result(
        scene, context, "mesh-sized",
        scale_factor=factor,
        units="m",
        real_world={"dimension": dimension, "size": size, "unit": unit},
    )


def _reground(scene) -> None:
    lo = scene.bounds[0]
    shift = np.eye(4)
    shift[1, 3] = -lo[1]
    scene.apply_transform(shift)


def recenter_mesh(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    trimesh = _trimesh()
    context.progress(20, "Loading mesh…")
    scene = load_scene(input_path, trimesh)
    lo, hi = scene.bounds
    shift = np.eye(4)
    if bool(params.get("center", True)):
        shift[0, 3] = -(lo[0] + hi[0]) / 2.0
        shift[2, 3] = -(lo[2] + hi[2]) / 2.0
    if bool(params.get("ground", True)):
        shift[1, 3] = -lo[1]
    scene.apply_transform(shift)
    return _scene_result(scene, context, "mesh-recenter")


# ---------------------------------------------------------------------------
# Topology operations (flattened mesh)
# ---------------------------------------------------------------------------

def subdivide_mesh(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    trimesh = _trimesh()
    iterations = int(params.get("iterations", 1))
    mode = str(params.get("mode", "midpoint"))
    if iterations < 1:
        raise ValueError("iterations must be at least 1")
    context.progress(20, "Loading mesh…")
    mesh = flatten_scene(trimesh.load(str(input_path)), trimesh)
    projected = len(mesh.faces) * (4 ** iterations)
    if projected > MAX_SUBDIVIDED_FACES:
        raise ValueError(
            f"Subdividing {len(mesh.faces):,} faces {iterations}× would produce "
            f"{projected:,} faces (limit {MAX_SUBDIVIDED_FACES:,}). Decimate first or use fewer iterations."
        )
    context.progress(50, f"Subdividing ({mode})…")
    if mode == "loop":
        vertices, faces = trimesh.remesh.subdivide_loop(mesh.vertices, mesh.faces, iterations=iterations)
        result = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    else:
        result = mesh
        for _ in range(iterations):
            result = result.subdivide()
    return _mesh_result(result, context, "mesh-subdivide")


def remove_small_components(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    """Drop floating debris: keep the largest piece, or every piece above a share."""
    trimesh = _trimesh()
    keep_largest_only = bool(params.get("keep_largest_only", False))
    min_share = float(params.get("min_face_share", 0.01))
    context.progress(20, "Loading mesh…")
    mesh = flatten_scene(trimesh.load(str(input_path)), trimesh)
    context.progress(40, "Finding connected pieces…")
    labels = face_component_labels(np.asarray(mesh.vertices), np.asarray(mesh.faces))
    if len(labels) == 0:
        raise ValueError("The mesh has no faces")
    counts = np.bincount(labels)
    if keep_largest_only:
        keep = labels == 0
    else:
        keep = counts[labels] >= max(1, int(np.ceil(min_share * counts[0])))
    removed_components = int(len(counts) - len(np.unique(labels[keep])))
    context.progress(70, f"Removing {removed_components} piece(s)…")
    result = mesh.submesh([np.flatnonzero(keep)], append=True) if removed_components else mesh
    return _mesh_result(
        result, context, "mesh-cleanup",
        components_before=int(len(counts)),
        components_removed=removed_components,
    )


def fix_normals(input_path: Path, params: Mapping[str, Any], context: MeshOpContext) -> MeshOpResult:
    """Make face winding consistent and point normals outward."""
    trimesh = _trimesh()
    context.progress(20, "Loading mesh…")
    mesh = flatten_scene(trimesh.load(str(input_path)), trimesh)
    context.progress(50, "Orienting faces…")
    faces, flipped = orient_faces_consistently(np.asarray(mesh.faces))
    inverted = False
    if bool(params.get("outward", True)) and signed_volume(np.asarray(mesh.vertices), faces) < 0:
        faces = faces[:, ::-1]
        inverted = True
    mesh.faces = faces
    return _mesh_result(mesh, context, "mesh-normals", faces_flipped=flipped, inverted=inverted)
