"""Local, GPU-free texturing by projecting the source picture onto the mesh.

Image-to-3D models rebuild the object in the picture, so that picture already
holds the colours of the side it shows. This module:

1. finds the object in the image (alpha channel, or the border colour as
   background);
2. works out which side of the mesh the picture shows, by comparing the
   mesh's silhouette from each horizontal direction with the object's outline;
3. projects the picture onto the vertices along that direction, using a depth
   buffer so surfaces hidden behind others are not painted with the front;
4. gives hidden parts the picture's colour at the same position (an object's
   back usually resembles its front) and softens them toward their
   neighbours so the sides don't streak.

The result is stored as vertex colours in a GLB. Quality follows mesh density
(generated meshes are dense) and is best for objects whose sides resemble the
pictured side. It needs only numpy and Pillow.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np

from services.mesh_analysis import weld_vertices
from services.mesh_io import load_flat_mesh

MAX_IMAGE_SIDE = 1024
MASK_GRID = 96

# Camera directions considered (the camera sits on this side, looking back).
# glTF models conventionally face +Z, so it wins ties.
VIEWS: dict[str, tuple[np.ndarray, np.ndarray]] = {
    "front (+Z)": (np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0])),
    "back (-Z)": (np.array([0.0, 0.0, -1.0]), np.array([-1.0, 0.0, 0.0])),
    "right (+X)": (np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0])),
    "left (-X)": (np.array([-1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])),
}
_TIE_BREAK = {"front (+Z)": 0.02, "back (-Z)": 0.0, "right (+X)": 0.0, "left (-X)": 0.0}


class TexturingError(ValueError):
    pass


@dataclass
class TextureResult:
    view: str
    silhouette_match: float
    visible_share: float
    vertex_colors: np.ndarray  # (n, 4) uint8


# ---------------------------------------------------------------------------
# Image side
# ---------------------------------------------------------------------------

def load_image(data: bytes) -> np.ndarray:
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # noqa: BLE001 — Pillow raises many types
        raise TexturingError("The source picture could not be read") from exc
    image = image.convert("RGBA")
    if max(image.size) > MAX_IMAGE_SIDE:
        image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
    return np.asarray(image, dtype=np.uint8)


def foreground_mask(rgba: np.ndarray) -> np.ndarray:
    """True where the object is. Uses transparency when the picture has it,
    otherwise treats colours close to the border's median as background."""
    alpha = rgba[..., 3]
    if (alpha < 250).mean() > 0.01:
        mask = alpha > 128
    else:
        rgb = rgba[..., :3].astype(np.float32)
        border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
        background = np.median(border, axis=0)
        distance = np.linalg.norm(rgb - background, axis=-1)
        mask = distance > 38.0
    if mask.sum() < 0.002 * mask.size:
        raise TexturingError("Couldn't find the object in the picture")
    return mask


def bleed_colors(rgb: np.ndarray, mask: np.ndarray, iterations: int = 48) -> np.ndarray:
    """Spread object colours outward over the background, so samples that land
    just outside the outline pick up the object's edge colour, not the backdrop."""
    filled = mask.copy()
    colour = np.where(mask[..., None], rgb.astype(np.float32), 0.0)
    for _ in range(iterations):
        if filled.all():
            break
        total = np.zeros_like(colour)
        count = np.zeros(mask.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted_fill = np.roll(filled, (dy, dx), axis=(0, 1))
            total += np.roll(colour, (dy, dx), axis=(0, 1)) * shifted_fill[..., None]
            count += shifted_fill
        grow = (~filled) & (count > 0)
        colour[grow] = total[grow] / count[grow, None]
        filled |= grow
    return colour


def _bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


# ---------------------------------------------------------------------------
# Mesh side
# ---------------------------------------------------------------------------

def _project(vertices: np.ndarray, view: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    direction, right = VIEWS[view]
    u = vertices @ right
    v = vertices[:, 1]
    depth = vertices @ direction
    return u, v, depth


def _to_grid(u: np.ndarray, v: np.ndarray, box: tuple[int, int, int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Map projected coordinates onto the image box, keeping the mesh's aspect
    ratio (centred), with +v up."""
    x0, y0, x1, y1 = box
    width, height = max(x1 - x0, 1), max(y1 - y0, 1)
    span_u, span_v = max(u.max() - u.min(), 1e-9), max(v.max() - v.min(), 1e-9)
    scale = min(width / span_u, height / span_v)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    mu, mv = (u.max() + u.min()) / 2.0, (v.max() + v.min()) / 2.0
    px = cx + (u - mu) * scale
    py = cy - (v - mv) * scale
    return px, py


def _silhouette(px: np.ndarray, py: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    grid = np.zeros(shape, dtype=bool)
    ix = np.clip(px.astype(int), 0, shape[1] - 1)
    iy = np.clip(py.astype(int), 0, shape[0] - 1)
    grid[iy, ix] = True
    # Close the gaps between splatted points.
    for _ in range(2):
        grid = grid | np.roll(grid, 1, 0) | np.roll(grid, -1, 0) | np.roll(grid, 1, 1) | np.roll(grid, -1, 1)
    return grid


def _downsample(mask: np.ndarray, size: int) -> tuple[np.ndarray, float]:
    factor = size / max(mask.shape)
    h, w = max(1, int(mask.shape[0] * factor)), max(1, int(mask.shape[1] * factor))
    ys = (np.arange(h) / factor).astype(int).clip(0, mask.shape[0] - 1)
    xs = (np.arange(w) / factor).astype(int).clip(0, mask.shape[1] - 1)
    return mask[np.ix_(ys, xs)], factor


def choose_view(vertices: np.ndarray, mask: np.ndarray) -> tuple[str, float]:
    small, factor = _downsample(mask, MASK_GRID)
    box = _bbox(small)
    scores = {}
    for view in VIEWS:
        u, v, _ = _project(vertices, view)
        px, py = _to_grid(u, v, box)
        sil = _silhouette(px, py, small.shape)
        union = (sil | small).sum()
        scores[view] = ((sil & small).sum() / union if union else 0.0) + _TIE_BREAK[view]
    best = max(scores, key=scores.get)
    return best, float(scores[best] - _TIE_BREAK[best])


def _visible(px: np.ndarray, py: np.ndarray, depth: np.ndarray, faces: np.ndarray, extent: float) -> np.ndarray:
    """Vertices nearest the camera in their depth-buffer cell."""
    n_faces = max(len(faces), 1)
    resolution = int(np.clip(np.sqrt(n_faces) / 2.0, 64, 512))
    span = max(px.max() - px.min(), py.max() - py.min(), 1e-9)
    gx = ((px - px.min()) / span * (resolution - 1)).astype(int)
    gy = ((py - py.min()) / span * (resolution - 1)).astype(int)
    zbuf = np.full((resolution, resolution), -np.inf)
    np.maximum.at(zbuf, (gy, gx), depth)
    if len(faces):
        # Face centroids fill cells between sparse vertices.
        cx, cy, cz = gx[faces].mean(axis=1).astype(int), gy[faces].mean(axis=1).astype(int), depth[faces].mean(axis=1)
        np.maximum.at(zbuf, (cy, cx), cz)
    return depth >= zbuf[gy, gx] - 0.02 * extent


def _soften(colors: np.ndarray, hidden: np.ndarray, faces: np.ndarray, n: int, iterations: int = 4) -> np.ndarray:
    """Blend hidden vertices a little toward their neighbours (visible ones stay
    exact), so projected-through colour on the back and sides doesn't streak."""
    if not hidden.any() or not len(faces):
        return colors
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    a, b = edges[:, 0], edges[:, 1]
    degree = np.zeros(n)
    np.add.at(degree, a, 1)
    np.add.at(degree, b, 1)
    current = colors.astype(np.float64).copy()
    for _ in range(iterations):
        total = np.zeros_like(current)
        np.add.at(total, a, current[b])
        np.add.at(total, b, current[a])
        mean = total / np.maximum(degree, 1)[:, None]
        current[hidden] = 0.5 * current[hidden] + 0.5 * mean[hidden]
    return current


def project_texture(vertices: np.ndarray, faces: np.ndarray, image_rgba: np.ndarray, view: Optional[str] = None) -> TextureResult:
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    if len(vertices) == 0:
        raise TexturingError("The mesh has no vertices")
    mask = foreground_mask(image_rgba)
    if view is None:
        view, match = choose_view(vertices, mask)
    else:
        if view not in VIEWS:
            raise TexturingError(f"Unknown view: {view}")
        match = float("nan")

    colour_field = bleed_colors(image_rgba[..., :3], mask)
    u, v, depth = _project(vertices, view)
    px, py = _to_grid(u, v, _bbox(mask))
    h, w = mask.shape
    ix = np.clip(np.round(px).astype(int), 0, w - 1)
    iy = np.clip(np.round(py).astype(int), 0, h - 1)
    sampled = colour_field[iy, ix]

    extent = float(np.max(vertices.max(axis=0) - vertices.min(axis=0))) or 1.0
    welded = weld_vertices(vertices, faces) if len(faces) else np.zeros((0, 3), dtype=np.int64)
    n_welded = int(welded.max()) + 1 if len(welded) else len(vertices)
    # Work on welded vertices so colour flows across UV seams.
    owner = np.zeros(len(vertices), dtype=np.int64)
    if len(faces):
        owner[faces.reshape(-1)] = welded.reshape(-1)
    visible = _visible(px, py, depth, faces, extent)

    if not visible.any():
        raise TexturingError("No part of the mesh faces the picture")
    # Every vertex takes the picture's colour where it projects: exact for the
    # pictured side, and for hidden parts the usual assumption that an
    # object's back resembles its front. Averaged per welded vertex so UV
    # seams don't split colours.
    welded_colours = np.zeros((n_welded, 3))
    counts = np.zeros(n_welded)
    seen = np.zeros(n_welded)
    np.add.at(welded_colours, owner, sampled)
    np.add.at(counts, owner, 1)
    np.add.at(seen, owner, visible.astype(float))
    welded_colours /= np.maximum(counts, 1)[:, None]
    welded_colours = _soften(welded_colours, seen == 0, welded, n_welded)

    rgb = np.clip(welded_colours[owner], 0, 255).astype(np.uint8)
    rgba = np.concatenate([rgb, np.full((len(rgb), 1), 255, dtype=np.uint8)], axis=1)
    return TextureResult(view=view, silhouette_match=match, visible_share=float(visible.mean()), vertex_colors=rgba)


def texture_mesh_file(mesh_path: Path, image_bytes: bytes, output_path: Path, view: Optional[str] = None) -> dict[str, Any]:
    import trimesh

    mesh = load_flat_mesh(mesh_path)
    result = project_texture(np.asarray(mesh.vertices), np.asarray(mesh.faces), load_image(image_bytes), view)
    coloured = trimesh.Trimesh(
        vertices=mesh.vertices, faces=mesh.faces, process=False,
        vertex_colors=result.vertex_colors,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    coloured.export(str(output_path))
    return {
        "view": result.view,
        "silhouette_match": None if np.isnan(result.silhouette_match) else round(result.silhouette_match, 3),
        "visible_share": round(result.visible_share, 3),
        "method": "projection",
    }
