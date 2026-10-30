"""Built-in mesh operation definitions."""

from .operations import decimate_mesh, repair_mesh, smooth_mesh
from .transforms import (
    fix_normals,
    mirror_mesh,
    recenter_mesh,
    remove_small_components,
    rotate_mesh,
    scale_mesh,
    scale_to_size,
    subdivide_mesh,
)
from .types import MeshOp


REPAIR_PARAMS = (
    {
        "id": "remove_duplicates",
        "label": "Remove Duplicates",
        "type": "boolean",
        "default": True,
        "tooltip": "Remove duplicate vertices and faces.",
    },
    {
        "id": "remove_degenerate",
        "label": "Remove Degenerate Faces",
        "type": "boolean",
        "default": True,
        "tooltip": "Remove zero-area faces and collapsed edges.",
    },
    {
        "id": "fix_non_manifold",
        "label": "Fix Non-Manifold",
        "type": "boolean",
        "default": True,
        "tooltip": "Detach faces causing non-manifold edges.",
    },
    {
        "id": "fill_holes",
        "label": "Fill Holes",
        "type": "boolean",
        "default": True,
        "tooltip": (
            "Fill simple boundary holes. Structural holes from AI generation "
            "may not be fillable in post-processing."
        ),
    },
    {
        "id": "max_hole_size",
        "label": "Max Hole Size",
        "type": "int",
        "default": 2000,
        "min": 10,
        "max": 10000,
        "tooltip": (
            "Maximum number of boundary edges of a hole to be filled. "
            "Increase if large holes remain open."
        ),
    },
)

DECIMATE_PARAMS = (
    {
        "id": "target_faces",
        "label": "Target Triangles",
        "type": "int",
        "default": 10000,
        "min": 100,
        "max": 1000000,
        "tooltip": "Target number of triangles after simplification.",
    },
)

SMOOTH_PARAMS = (
    {
        "id": "iterations",
        "label": "Iterations",
        "type": "int",
        "default": 5,
        "min": 1,
        "max": 50,
        "tooltip": (
            "Number of smoothing passes. More iterations = smoother result "
            "but may lose fine details."
        ),
    },
    {
        "id": "lambda_",
        "label": "Smoothing Strength",
        "type": "float",
        "default": 0.5,
        "min": 0.1,
        "max": 1.0,
        "step": 0.05,
        "tooltip": (
            "Controls how far each vertex moves toward its neighbours per "
            "iteration. Lower = more conservative."
        ),
    },
    {
        "id": "mode",
        "label": "Mode",
        "type": "select",
        "default": "taubin",
        "options": [
            {"value": "taubin", "label": "Taubin (volume-preserving)"},
            {"value": "laplacian", "label": "Laplacian (stronger, may shrink)"},
        ],
        "tooltip": (
            "Taubin alternates positive/negative steps to prevent mesh "
            "shrinkage. Laplacian is simpler but tends to shrink the mesh over "
            "many iterations."
        ),
    },
)

AXIS_OPTIONS = [
    {"value": "x", "label": "X"},
    {"value": "y", "label": "Y (up)"},
    {"value": "z", "label": "Z"},
]

UNIT_OPTIONS = [
    {"value": "mm", "label": "Millimetres"},
    {"value": "cm", "label": "Centimetres"},
    {"value": "m", "label": "Metres"},
    {"value": "in", "label": "Inches"},
    {"value": "ft", "label": "Feet"},
]

ROTATE_PARAMS = (
    {"id": "axis", "label": "Axis", "type": "select", "default": "y", "options": AXIS_OPTIONS,
     "tooltip": "Axis to rotate around. Y is up."},
    {"id": "degrees", "label": "Degrees", "type": "float", "default": 90.0, "min": -360.0, "max": 360.0,
     "step": 15.0, "tooltip": "Rotation angle; positive is counter-clockwise looking down the axis."},
    {"id": "reground", "label": "Keep on ground", "type": "boolean", "default": True,
     "tooltip": "Move the result back so it rests on the ground plane."},
)

MIRROR_PARAMS = (
    {"id": "axis", "label": "Axis", "type": "select", "default": "x", "options": AXIS_OPTIONS,
     "tooltip": "Axis to flip across, through the mesh centre."},
)

SCALE_PARAMS = (
    {"id": "factor", "label": "Factor", "type": "float", "default": 2.0, "min": 0.001, "max": 1000.0,
     "step": 0.1, "tooltip": "Uniform scale factor (2 = twice as large)."},
)

SCALE_TO_SIZE_PARAMS = (
    {"id": "dimension", "label": "Dimension", "type": "select", "default": "height",
     "options": [
         {"value": "height", "label": "Height (Y)"},
         {"value": "width", "label": "Width (X)"},
         {"value": "depth", "label": "Depth (Z)"},
         {"value": "longest", "label": "Longest side"},
     ],
     "tooltip": "Which bounding-box dimension the size applies to. Others scale proportionally."},
    {"id": "size", "label": "Size", "type": "float", "default": 10.0, "min": 0.0001, "max": 100000.0,
     "step": 0.5, "tooltip": "Real-world size of the chosen dimension."},
    {"id": "unit", "label": "Unit", "type": "select", "default": "cm", "options": UNIT_OPTIONS,
     "tooltip": "Unit of the size. The mesh is stored in metres (glTF convention)."},
)

RECENTER_PARAMS = (
    {"id": "center", "label": "Centre horizontally", "type": "boolean", "default": True,
     "tooltip": "Move the bounding-box centre onto the X/Z origin."},
    {"id": "ground", "label": "Place on ground", "type": "boolean", "default": True,
     "tooltip": "Move the lowest point onto Y = 0."},
)

SUBDIVIDE_PARAMS = (
    {"id": "iterations", "label": "Iterations", "type": "int", "default": 1, "min": 1, "max": 3,
     "tooltip": "Each iteration splits every triangle into four."},
    {"id": "mode", "label": "Mode", "type": "select", "default": "midpoint",
     "options": [
         {"value": "midpoint", "label": "Midpoint (keeps shape and UVs)"},
         {"value": "loop", "label": "Loop (smoother, drops textures)"},
     ],
     "tooltip": "Midpoint adds density without changing the surface; Loop also rounds it."},
)

COMPONENT_PARAMS = (
    {"id": "keep_largest_only", "label": "Keep largest piece only", "type": "boolean", "default": False,
     "tooltip": "Discard every disconnected piece except the biggest one."},
    {"id": "min_face_share", "label": "Minimum size", "type": "float", "default": 0.01, "min": 0.0,
     "max": 0.5, "step": 0.005,
     "tooltip": "Pieces with fewer faces than this share of the largest piece are removed."},
)

NORMALS_PARAMS = (
    {"id": "outward", "label": "Point outward", "type": "boolean", "default": True,
     "tooltip": "After making winding consistent, flip everything if normals face inward."},
)


BUILTIN_MESH_OPS = (
    MeshOp(
        id="repair",
        label="Repair Mesh",
        params_schema=REPAIR_PARAMS,
        fn=repair_mesh,
        category="repair",
        description="Remove duplicate/degenerate faces, fix non-manifold edges and fill holes.",
    ),
    MeshOp(
        id="decimate",
        label="Optimize Mesh",
        params_schema=DECIMATE_PARAMS,
        fn=decimate_mesh,
        category="optimization",
        description="Reduce the triangle count while preserving the overall shape.",
    ),
    MeshOp(
        id="smooth",
        label="Smooth Mesh",
        params_schema=SMOOTH_PARAMS,
        fn=smooth_mesh,
        category="optimization",
        description="Smooth bumpy or noisy surfaces.",
    ),
    MeshOp(
        id="remove_small_components",
        label="Remove Floating Pieces",
        params_schema=COMPONENT_PARAMS,
        fn=remove_small_components,
        category="cleanup",
        description="Delete small disconnected fragments (floaters) around the main model.",
    ),
    MeshOp(
        id="fix_normals",
        label="Fix Normals",
        params_schema=NORMALS_PARAMS,
        fn=fix_normals,
        category="cleanup",
        description="Make face winding consistent and point normals outward (fixes dark/inside-out patches).",
    ),
    MeshOp(
        id="subdivide",
        label="Subdivide",
        params_schema=SUBDIVIDE_PARAMS,
        fn=subdivide_mesh,
        category="topology",
        description="Increase mesh density by splitting triangles.",
    ),
    MeshOp(
        id="rotate",
        label="Rotate",
        params_schema=ROTATE_PARAMS,
        fn=rotate_mesh,
        category="transform",
        description="Rotate the mesh around an axis by a number of degrees.",
    ),
    MeshOp(
        id="mirror",
        label="Mirror",
        params_schema=MIRROR_PARAMS,
        fn=mirror_mesh,
        category="transform",
        description="Flip the mesh across an axis.",
    ),
    MeshOp(
        id="scale",
        label="Scale",
        params_schema=SCALE_PARAMS,
        fn=scale_mesh,
        category="transform",
        description="Scale the mesh uniformly by a factor.",
    ),
    MeshOp(
        id="scale_to_size",
        label="Set Real-World Size",
        params_schema=SCALE_TO_SIZE_PARAMS,
        fn=scale_to_size,
        category="transform",
        description="Scale the mesh so a chosen dimension measures an exact real-world size.",
    ),
    MeshOp(
        id="recenter",
        label="Centre & Ground",
        params_schema=RECENTER_PARAMS,
        fn=recenter_mesh,
        category="transform",
        description="Centre the mesh on the origin and rest it on the ground plane.",
    ),
)
