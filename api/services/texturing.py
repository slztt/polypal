"""Local, GPU-free texturing by projecting the source picture onto the mesh.

Image-to-3D models rebuild the object in the picture, so that picture already
holds the colours of the side it shows. This module:

1. finds the object in the image (alpha channel, or the border colour as
   background) and removes shiny highlights;
2. works out which side of the mesh the picture shows, by comparing the
   mesh's silhouette from each horizontal direction with the object's outline;
3. projects the picture onto the vertices, using a depth buffer so surfaces
   hidden behind others are not painted, and trusting each vertex by how
   squarely it faces the camera (grazing surfaces would smear);
4. removes the lighting baked into the photo: the shading is fitted to the
   mesh's own surface normals (a low-order spherical-harmonics light) and
   divided out, so the viewer's lights don't double up with the photo's;
5. fills parts no picture shows by diffusing colour across the surface from
   the painted parts, seeded with a heavily blurred see-through projection —
   large colour regions carry round (a red shirt stays red at the back) but
   details like faces or logos are not copied onto the back;
6. optionally blends extra pictures of other sides (e.g. a generated back
   view) into the same result.

Low-poly meshes are subdivided first so the colour stays sharp. The result is
stored as vertex colours in a GLB. It needs only numpy and Pillow.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

from services.mesh_analysis import weld_vertices
from services.mesh_io import load_flat_mesh

MAX_IMAGE_SIDE = 1024
MASK_GRID = 96
TARGET_FACES = 250_000          # subdivide sparser meshes up to about this many faces
MAX_FACES = 600_000
FILL_ITERATIONS = 90
OPPOSITE = {"front (+Z)": "back (-Z)", "back (-Z)": "front (+Z)", "right (+X)": "left (-X)", "left (-X)": "right (+X)"}

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
    lighting_removed: float = 0.0   # how much shading was divided out (0 = none)
    views_used: tuple[str, ...] = ()


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


def _edges(faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    return edges[:, 0], edges[:, 1]


def _neighbour_mean(values: np.ndarray, a: np.ndarray, b: np.ndarray, degree: np.ndarray) -> np.ndarray:
    n = len(values)
    out = np.empty_like(values)
    for c in range(values.shape[1]):
        out[:, c] = np.bincount(a, weights=values[b, c], minlength=n) + np.bincount(b, weights=values[a, c], minlength=n)
    return out / np.maximum(degree, 1)[:, None]


def _soften(colors: np.ndarray, hidden: np.ndarray, faces: np.ndarray, n: int, iterations: int = 4) -> np.ndarray:
    """Blend hidden vertices toward their neighbours (others stay exact)."""
    if not hidden.any() or not len(faces):
        return colors
    a, b = _edges(faces)
    degree = np.bincount(a, minlength=n) + np.bincount(b, minlength=n)
    current = colors.astype(np.float64).copy()
    for _ in range(iterations):
        mean = _neighbour_mean(current, a, b, degree)
        current[hidden] = 0.5 * current[hidden] + 0.5 * mean[hidden]
    return current


def _diffuse_fill(colors: np.ndarray, known: np.ndarray, faces: np.ndarray, iterations: int = FILL_ITERATIONS) -> np.ndarray:
    """Harmonic-style fill: unknown vertices repeatedly take their neighbours'
    mean while known vertices stay fixed, so colour flows in from the painted
    parts. `colors` holds the starting guess for unknown vertices."""
    if known.all() or not len(faces):
        return colors
    n = len(colors)
    a, b = _edges(faces)
    degree = np.bincount(a, minlength=n) + np.bincount(b, minlength=n)
    current = colors.astype(np.float64).copy()
    unknown = ~known
    for _ in range(iterations):
        current[unknown] = _neighbour_mean(current, a, b, degree)[unknown]
    return current


def _vertex_normals(vertices: np.ndarray, faces: np.ndarray, n: int) -> np.ndarray:
    """Area-weighted normals for (welded) vertices."""
    if not len(faces):
        return np.zeros((n, 3))
    tri = vertices[faces]
    face_n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    normals = np.zeros((n, 3))
    for c in range(3):
        for k in range(3):
            normals[:, c] += np.bincount(faces[:, k], weights=face_n[:, c], minlength=n)
    length = np.linalg.norm(normals, axis=1, keepdims=True)
    return normals / np.maximum(length, 1e-12)


def _luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.299, 0.587, 0.114])


def remove_highlights(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Mask out shiny specular spots: much brighter than their surroundings and
    nearly white. They are refilled from the neighbouring colour later."""
    from PIL import Image, ImageFilter

    lum = _luminance(rgb.astype(np.float32))
    radius = max(2.0, 0.025 * max(mask.shape))
    blurred = np.asarray(Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)
    maxc, minc = rgb.max(axis=-1).astype(np.float32), rgb.min(axis=-1).astype(np.float32)
    saturation = (maxc - minc) / np.maximum(maxc, 1)
    highlight = mask & (lum > 200) & (lum > blurred * 1.22) & (saturation < 0.22)
    # Never drop most of the object (an all-white object is not a highlight).
    if highlight.sum() > 0.08 * mask.sum():
        return mask
    return mask & ~highlight


def _blurred_field(field: np.ndarray, mask: np.ndarray) -> np.ndarray:
    from PIL import Image, ImageFilter

    x0, y0, x1, y1 = _bbox(mask)
    radius = max(2.0, 0.07 * max(x1 - x0, y1 - y0))
    img = Image.fromarray(np.clip(field, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float64)


def fit_lighting(normals: np.ndarray, luminance: np.ndarray, weights: np.ndarray) -> Optional[np.ndarray]:
    """Fit shading S(n) = c0 + c1·nx + c2·ny + c3·nz (+ order-2 terms when
    there are enough samples) to the observed brightness, robustly (Huber
    IRLS) so colour changes in the object itself count as outliers. Returns
    the coefficients, or None when there is too little to go on."""
    use = weights > 0.3
    if use.sum() < 60:
        return None
    n = normals[use]
    y = luminance[use]
    w = weights[use]
    basis = _sh_basis(n, order=2 if use.sum() > 2000 else 1)
    coeffs = np.zeros(basis.shape[1])
    robust = np.ones_like(y)
    for _ in range(8):
        sw = np.sqrt(w * robust)
        coeffs, *_ = np.linalg.lstsq(basis * sw[:, None], y * sw, rcond=None)
        residual = y - basis @ coeffs
        scale = 1.4826 * np.median(np.abs(residual)) + 1e-6
        r = np.abs(residual) / (1.345 * scale)
        robust = np.where(r <= 1, 1.0, 1.0 / r)
    return coeffs


def _sh_basis(n: np.ndarray, order: int) -> np.ndarray:
    x, y, z = n[:, 0], n[:, 1], n[:, 2]
    cols = [np.ones_like(x), x, y, z]
    if order >= 2:
        cols += [x * y, y * z, x * z, x * x - y * y, 3 * z * z - 1]
    return np.stack(cols, axis=1)


def delight(colors: np.ndarray, normals: np.ndarray, weights: np.ndarray, strength: float = 1.0) -> tuple[np.ndarray, float]:
    """Divide the fitted photo lighting out of the colours. Returns the new
    colours and how strong the removed shading was (0 = flat light)."""
    lum = _luminance(colors)
    coeffs = fit_lighting(normals, lum, weights)
    if coeffs is None:
        return colors, 0.0
    order = 2 if len(coeffs) > 4 else 1
    shading = _sh_basis(normals, order) @ coeffs
    use = weights > 0.3
    reference = float(np.median(shading[use])) if use.any() else float(np.median(shading))
    if reference <= 1e-3:
        return colors, 0.0
    ratio = np.clip(shading / reference, 0.35, 2.5)
    gain = np.clip(1.0 / ratio, 0.62, 1.7) ** strength
    variation = float(np.std(ratio[use])) if use.any() else 0.0
    return np.clip(colors * gain[:, None], 0, 255), variation


def _project_view(vertices, faces, image_rgba, view, normals_w, owner, n_welded, extent):
    """Colours, blurred see-through colours and confidence weights for one picture."""
    mask = foreground_mask(image_rgba)
    rgb = image_rgba[..., :3]
    clean = remove_highlights(rgb, mask)
    field = bleed_colors(rgb, clean)
    blurred = _blurred_field(field, mask)

    u, v, depth = _project(vertices, view)
    px, py = _to_grid(u, v, _bbox(mask))
    h, w = mask.shape
    ix = np.clip(np.round(px).astype(int), 0, w - 1)
    iy = np.clip(np.round(py).astype(int), 0, h - 1)
    visible = _visible(px, py, depth, faces, extent)

    def per_welded(values: np.ndarray) -> np.ndarray:
        out = np.zeros((n_welded, values.shape[1]))
        for c in range(values.shape[1]):
            out[:, c] = np.bincount(owner, weights=values[:, c], minlength=n_welded)
        return out

    counts = np.maximum(np.bincount(owner, minlength=n_welded), 1)
    sampled = per_welded(field[iy, ix]) / counts[:, None]
    through = per_welded(blurred[iy, ix]) / counts[:, None]
    seen = np.bincount(owner, weights=visible.astype(float), minlength=n_welded) / counts
    direction = VIEWS[view][0]
    facing = normals_w @ direction
    weight = np.clip((facing - 0.08) / 0.42, 0.0, 1.0) * (seen > 0.5)
    return sampled, through, weight, float(visible.mean())


def project_texture(
    vertices: np.ndarray,
    faces: np.ndarray,
    image_rgba: np.ndarray,
    view: Optional[str] = None,
    extra_views: Sequence[tuple[np.ndarray, str]] = (),
    remove_lighting: bool = True,
) -> TextureResult:
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

    extent = float(np.max(vertices.max(axis=0) - vertices.min(axis=0))) or 1.0
    welded = weld_vertices(vertices, faces) if len(faces) else np.zeros((0, 3), dtype=np.int64)
    n_welded = int(welded.max()) + 1 if len(welded) else len(vertices)
    # Work on welded vertices so colour flows across UV seams.
    owner = np.arange(len(vertices), dtype=np.int64)
    if len(faces):
        owner = np.zeros(len(vertices), dtype=np.int64)
        owner[faces.reshape(-1)] = welded.reshape(-1)
    welded_pos = np.zeros((n_welded, 3))
    for c in range(3):
        welded_pos[:, c] = np.bincount(owner, weights=vertices[:, c], minlength=n_welded)
    welded_pos /= np.maximum(np.bincount(owner, minlength=n_welded), 1)[:, None]
    normals = _vertex_normals(welded_pos, welded, n_welded)

    pictures: list[tuple[np.ndarray, str]] = [(image_rgba, view)]
    for extra_rgba, extra_view in extra_views:
        resolved = OPPOSITE[view] if extra_view == "opposite" else extra_view
        if resolved not in VIEWS:
            raise TexturingError(f"Unknown view: {extra_view}")
        pictures.append((extra_rgba, resolved))

    colour_sum = np.zeros((n_welded, 3))
    weight_sum = np.zeros(n_welded)
    through = None
    visible_share = 0.0
    lighting = 0.0
    for index, (rgba, pic_view) in enumerate(pictures):
        sampled, seen_through, weight, share = _project_view(vertices, faces, rgba, pic_view, normals, owner, n_welded, extent)
        if remove_lighting:
            sampled, removed = delight(sampled, normals, weight)
            seen_through, _ = delight(seen_through, normals, weight, strength=0.6)
            lighting = max(lighting, removed)
        if index == 0:
            through = seen_through
            visible_share = share
        colour_sum += sampled * weight[:, None]
        weight_sum += weight

    if not (weight_sum > 0).any():
        raise TexturingError("No part of the mesh faces the picture")
    painted = colour_sum / np.maximum(weight_sum, 1e-9)[:, None]
    confident = weight_sum >= 0.6
    start = np.where((weight_sum > 0)[:, None], painted, through)
    diffused = _diffuse_fill(np.where(confident[:, None], painted, start), confident, welded)
    # Keep the see-through colour as an anchor so large regions carry round
    # instead of everything averaging toward one colour.
    filled = np.where(confident[:, None], diffused, 0.55 * diffused + 0.45 * through)
    blend = np.clip(weight_sum / 0.6, 0.0, 1.0)[:, None]
    colours = blend * painted + (1 - blend) * filled
    colours = _soften(colours, ~confident, welded, n_welded, iterations=2)

    rgb = np.clip(colours[owner], 0, 255).astype(np.uint8)
    rgba = np.concatenate([rgb, np.full((len(rgb), 1), 255, dtype=np.uint8)], axis=1)
    return TextureResult(
        view=view, silhouette_match=match, visible_share=visible_share, vertex_colors=rgba,
        lighting_removed=round(lighting, 3), views_used=tuple(v for _, v in pictures),
    )


def densify(mesh, target_faces: int = TARGET_FACES, max_faces: int = MAX_FACES):
    """Midpoint-subdivide sparse meshes (shape unchanged) so vertex colour has
    enough resolution to look sharp."""
    while len(mesh.faces) < target_faces and len(mesh.faces) * 4 <= max_faces:
        mesh = mesh.subdivide()
    return mesh


def texture_mesh_file(
    mesh_path: Path,
    image_bytes: bytes,
    output_path: Path,
    view: Optional[str] = None,
    extra_images: Sequence[tuple[bytes, str]] = (),
    remove_lighting: bool = True,
) -> dict[str, Any]:
    import trimesh

    mesh = densify(load_flat_mesh(mesh_path))
    extras = [(load_image(data), extra_view) for data, extra_view in extra_images]
    result = project_texture(np.asarray(mesh.vertices), np.asarray(mesh.faces), load_image(image_bytes), view,
                             extra_views=extras, remove_lighting=remove_lighting)
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
        "lighting_removed": result.lighting_removed,
        "views_used": list(result.views_used),
        "faces": int(len(mesh.faces)),
        "method": "projection-v2",
    }
