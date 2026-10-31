"""Map Builder: turn a top-down map or floor plan picture into a 3D level.

Pipeline (CPU only, no AI model needed):

1. Find the walls — the minority of pixels on the far side of an automatic
   brightness threshold (or pixels close to a colour the user picked).
2. Clean up: thin lines thinner than the walls (door arcs, furniture outlines)
   and small blobs (room labels, symbols) are removed.
3. Find the doors — short gaps in otherwise straight, thin walls.
4. Build the level: the picture becomes the textured floor, walls are extruded
   as merged boxes, and each door is its own hinged node ("Door_01", …) with a
   glTF "open" animation, so doors swing open in PolyPal and in game engines.

The scale comes from the wall thickness (walls are assumed ~20 cm thick)
unless the caller gives the real map width.
"""

from __future__ import annotations

import io
import json
import math
import re
import struct
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

import numpy as np
from PIL import Image, ImageFilter

import services.generator_registry as registry
from services import provenance

WallMode = Literal["auto", "dark", "light", "color"]

MAX_PROCESS_SIDE = 1200
MAX_GRID_SIDE = 480
MAX_TEXTURE_SIDE = 2048
ASSUMED_WALL_M = 0.2
DOOR_MIN_M = 0.6
DOOR_MAX_M = 1.8
PLAIN_WALL = (0.90, 0.88, 0.85)
DOOR_WOOD = (0.55, 0.36, 0.21)
DOOR_HANDLE = (0.18, 0.18, 0.18)
OPEN_SECONDS = 0.8


class MapBuildError(Exception):
    pass


@dataclass
class MapOptions:
    width_m: Optional[float] = None          # real width of the picture; None = estimate from walls
    wall_height: float = 2.7
    walls: WallMode = "auto"
    wall_color: Optional[tuple[int, int, int]] = None   # for walls="color"
    tolerance: float = 0.18                  # colour distance for walls="color" (0–1)
    doors: bool = True
    name: str = "map"


@dataclass
class Door:
    name: str
    axis: Literal["x", "z"]                  # direction the door leaf runs along
    hinge: tuple[float, float]               # (x, z) in metres
    length: float
    thickness: float
    height: float
    swing: int                               # +1 / -1: which side it opens to
    cells: tuple[int, int, int, int] = (0, 0, 0, 0)   # r0, c0, r1, c1 (inclusive) in grid cells


@dataclass
class MapPlan:
    mask: np.ndarray                         # walls on the grid (rows = z, cols = x)
    cell_m: float                            # metres per grid cell
    thickness_cells: float
    doors: list[Door] = field(default_factory=list)


# ─── Wall detection ───────────────────────────────────────────────────────────

def _otsu(values: np.ndarray) -> float:
    hist, edges = np.histogram(values, bins=256, range=(0.0, 1.0))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total == 0:
        return 0.5
    centers = (edges[:-1] + edges[1:]) / 2
    weight_bg = np.cumsum(hist)
    weight_fg = total - weight_bg
    mean_bg = np.cumsum(hist * centers)
    mean_total = mean_bg[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mean_total * weight_bg - mean_bg * total) ** 2 / (weight_bg * weight_fg)
    between = np.nan_to_num(between)
    return float(centers[int(np.argmax(between))])


def wall_mask(rgb: np.ndarray, opts: MapOptions) -> np.ndarray:
    """Boolean wall mask at the picture's resolution. `rgb` is float 0–1, HxWx3."""
    if opts.walls == "color":
        if not opts.wall_color:
            raise MapBuildError("Pick a wall colour first")
        target = np.array(opts.wall_color, dtype=np.float32) / 255.0
        distance = np.linalg.norm(rgb - target, axis=2) / math.sqrt(3)
        return distance <= max(0.01, min(opts.tolerance, 1.0))
    luminance = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    threshold = _otsu(luminance)
    dark = luminance < threshold
    if opts.walls == "dark":
        return dark
    if opts.walls == "light":
        return ~dark
    # Auto: walls are the minority class.
    return dark if dark.mean() <= 0.5 else ~dark


def _runs_along_rows(mask: np.ndarray) -> np.ndarray:
    """Per-pixel length of the horizontal run of True it belongs to (0 for False)."""
    h, w = mask.shape
    out = np.zeros(mask.shape, dtype=np.int32)
    padded = np.zeros((h, w + 2), dtype=np.int8)
    padded[:, 1:-1] = mask
    diff = np.diff(padded, axis=1)
    for r in range(h):
        starts = np.flatnonzero(diff[r] == 1)
        ends = np.flatnonzero(diff[r] == -1)
        for s, e in zip(starts, ends):
            out[r, s:e] = e - s
    return out


def wall_thickness(mask: np.ndarray) -> float:
    """Typical wall thickness in pixels: the short side of the runs through wall pixels."""
    if not mask.any():
        return 1.0
    across = np.minimum(_runs_along_rows(mask), _runs_along_rows(mask.T).T)
    values = across[mask]
    return float(max(1.0, np.median(values)))


def _filter(mask: np.ndarray, kind: Literal["min", "max"], size: int) -> np.ndarray:
    if size <= 1:
        return mask
    img = Image.fromarray(mask.astype(np.uint8) * 255)
    img = img.filter(ImageFilter.MinFilter(size) if kind == "min" else ImageFilter.MaxFilter(size))
    return np.asarray(img) > 127


def _components(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    h, w = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    comps: list[list[tuple[int, int]]] = []
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]:
            continue
        seen[r0, c0] = True
        queue = deque([(int(r0), int(c0))])
        cells: list[tuple[int, int]] = []
        while queue:
            r, c = queue.popleft()
            cells.append((r, c))
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < h and 0 <= nc < w and mask[nr, nc] and not seen[nr, nc]:
                    seen[nr, nc] = True
                    queue.append((nr, nc))
        comps.append(cells)
    return comps


def remove_small(mask: np.ndarray, min_extent: int) -> np.ndarray:
    """Drop blobs whose bounding box is smaller than `min_extent` on its long side."""
    out = mask.copy()
    for cells in _components(mask):
        rows = [r for r, _ in cells]
        cols = [c for _, c in cells]
        if max(max(rows) - min(rows), max(cols) - min(cols)) + 1 < min_extent:
            for r, c in cells:
                out[r, c] = False
    return out


def _downsample(mask: np.ndarray, factor: int) -> np.ndarray:
    if factor <= 1:
        return mask.copy()
    h, w = mask.shape
    gh, gw = h // factor, w // factor
    blocks = mask[: gh * factor, : gw * factor].reshape(gh, factor, gw, factor)
    return blocks.mean(axis=(1, 3)) >= 0.5


# ─── Doors ────────────────────────────────────────────────────────────────────

def _gap_candidates(mask: np.ndarray, min_len: int, max_len: int, min_side: int, max_thick: int) -> list[tuple[int, int, int]]:
    """(row, c0, c1) gaps in horizontal walls: a short empty run with straight, thin wall on both sides."""
    h, w = mask.shape
    runs = _runs_along_rows(mask)
    vertical = _runs_along_rows(mask.T).T
    found = []
    for r in range(h):
        row = mask[r]
        c = 0
        while c < w:
            if row[c]:
                c += 1
                continue
            start = c
            while c < w and not row[c]:
                c += 1
            end = c - 1
            length = end - start + 1
            if start == 0 or c >= w or not (min_len <= length <= max_len):
                continue
            left, right = start - 1, c
            if runs[r, left] < min_side or runs[r, right] < min_side:
                continue
            if vertical[r, left] > max_thick or vertical[r, right] > max_thick:
                continue
            found.append((r, start, end))
    return found


def _group_gaps(cands: list[tuple[int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Merge gaps in consecutive rows with overlapping spans → (r0, c0, r1, c1)."""
    groups: list[list[int]] = []
    for r, c0, c1 in sorted(cands):
        for g in groups:
            if g[2] == r - 1 and not (c1 < g[1] or c0 > g[3]):
                g[1], g[3] = min(g[1], c0), max(g[3], c1)
                g[2] = r
                break
        else:
            groups.append([r, c0, r, c1])
    return [(g[0], g[1], g[2], g[3]) for g in groups]


def find_doors(mask: np.ndarray, thickness: float, cell_m: float) -> list[tuple[str, tuple[int, int, int, int]]]:
    min_len = max(2, int(round(DOOR_MIN_M / cell_m)))
    max_len = max(min_len + 1, int(round(DOOR_MAX_M / cell_m)))
    min_side = max(2, int(round(thickness * 1.5)))
    max_thick = max(2, int(math.ceil(thickness * 2.2)))
    doors: list[tuple[str, tuple[int, int, int, int]]] = []
    for r0, c0, r1, c1 in _group_gaps(_gap_candidates(mask, min_len, max_len, min_side, max_thick)):
        if r1 - r0 + 1 <= max_thick:
            doors.append(("x", (r0, c0, r1, c1)))
    for c0, r0, c1, r1 in _group_gaps(_gap_candidates(mask.T, min_len, max_len, min_side, max_thick)):
        if c1 - c0 + 1 <= max_thick:
            doors.append(("z", (r0, c0, r1, c1)))
    return doors


def _free_cells(mask: np.ndarray, r0: int, c0: int, r1: int, c1: int) -> int:
    h, w = mask.shape
    r0, r1 = max(0, r0), min(h - 1, r1)
    c0, c1 = max(0, c0), min(w - 1, c1)
    if r0 > r1 or c0 > c1:
        return 0
    return int((~mask[r0:r1 + 1, c0:c1 + 1]).sum())


# ─── Planning ─────────────────────────────────────────────────────────────────

def plan_map(rgb: np.ndarray, opts: MapOptions) -> MapPlan:
    h, w, _ = rgb.shape
    mask = wall_mask(rgb, opts)
    if mask.mean() < 0.002:
        raise MapBuildError("No walls found in this picture. Try 'Walls are light' or pick the wall colour.")
    thickness = wall_thickness(mask)
    # Remove lines clearly thinner than the walls (door swings, furniture outlines).
    if thickness >= 4:
        size = int(thickness * 0.6) | 1
        mask = _filter(_filter(mask, "min", size), "max", size)
    width_m = opts.width_m if opts.width_m and opts.width_m > 0 else (w * ASSUMED_WALL_M / thickness)
    width_m = float(min(max(width_m, 2.0), 2000.0))
    px_m = width_m / w

    # Grid: about two cells per wall thickness, capped for speed.
    factor = max(1, int(thickness // 2), int(math.ceil(max(h, w) / MAX_GRID_SIDE)))
    grid = _downsample(mask, factor)
    cell_m = px_m * factor
    t_cells = max(1.0, thickness / factor)
    # Room labels and symbols: blobs smaller than a door.
    grid = remove_small(grid, max(3, int(round(DOOR_MIN_M / cell_m))))
    if not grid.any():
        raise MapBuildError("Only small marks were found — no walls to build.")

    plan = MapPlan(mask=grid, cell_m=cell_m, thickness_cells=t_cells)
    if not opts.doors:
        return plan

    door_height = min(2.1, opts.wall_height * 0.85)
    for i, (axis, (r0, c0, r1, c1)) in enumerate(find_doors(grid, t_cells, cell_m), start=1):
        if axis == "x":
            length = (c1 - c0 + 1) * cell_m
            thick = (r1 - r0 + 1) * cell_m
            hinge = (c0 * cell_m, (r0 + r1 + 1) / 2 * cell_m)
            reach = c1 - c0 + 1
            above = _free_cells(grid, r0 - reach, c0, r0 - 1, c1)
            below = _free_cells(grid, r1 + 1, c0, r1 + reach, c1)
            swing = 1 if above >= below else -1          # +1 opens toward -z (up in the picture)
        else:
            length = (r1 - r0 + 1) * cell_m
            thick = (c1 - c0 + 1) * cell_m
            hinge = ((c0 + c1 + 1) / 2 * cell_m, r0 * cell_m)
            reach = r1 - r0 + 1
            left = _free_cells(grid, r0, c0 - reach, r1, c0 - 1)
            right = _free_cells(grid, r0, c1 + 1, r1, c1 + reach)
            swing = 1 if right >= left else -1           # +1 opens toward +x
        plan.doors.append(Door(
            name=f"Door_{i:02d}", axis=axis, hinge=hinge, length=length,
            thickness=max(0.035, min(thick * 0.5, 0.07)), height=door_height, swing=swing,
            cells=(r0, c0, r1, c1),
        ))
    return plan


# ─── Geometry ─────────────────────────────────────────────────────────────────

def greedy_rectangles(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Cover the mask with few axis-aligned rectangles → (r, c, height, width)."""
    used = np.zeros(mask.shape, dtype=bool)
    h, w = mask.shape
    rects = []
    for r in range(h):
        for c in range(w):
            if not mask[r, c] or used[r, c]:
                continue
            cw = 1
            while c + cw < w and mask[r, c + cw] and not used[r, c + cw]:
                cw += 1
            ch = 1
            while r + ch < h and mask[r + ch, c:c + cw].all() and not used[r + ch, c:c + cw].any():
                ch += 1
            used[r:r + ch, c:c + cw] = True
            rects.append((r, c, ch, cw))
    return rects


_FACES = [  # (normal axis, sign) → corner order, outward-facing quads
    ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),     # top
    ((0, 0, 1), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),     # +z
    ((0, 0, -1), [(1, 0, 0), (0, 0, 0), (0, 1, 0), (1, 1, 0)]),    # -z
    ((1, 0, 0), [(1, 0, 1), (1, 0, 0), (1, 1, 0), (1, 1, 1)]),     # +x
    ((-1, 0, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),    # -x
]


class _MeshBuilder:
    """Flat-shaded boxes with per-face colours (4 vertices per face)."""

    def __init__(self) -> None:
        self.vertices: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, int, int]] = []
        self.colors: list[tuple[int, int, int, int]] = []

    def box(self, x0: float, y0: float, z0: float, x1: float, y1: float, z1: float,
            side: tuple[float, float, float], top: Optional[tuple[float, float, float]] = None,
            bottom: bool = False) -> None:
        sizes = (x1 - x0, y1 - y0, z1 - z0)
        faces = list(_FACES)
        if bottom:
            faces.append(((0, -1, 0), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]))
        for normal, corners in faces:
            color = top if (normal == (0, 1, 0) and top) else side
            rgba = tuple(int(round(max(0.0, min(1.0, v)) * 255)) for v in color) + (255,)
            base = len(self.vertices)
            for cx, cy, cz in corners:
                self.vertices.append((x0 + cx * sizes[0], y0 + cy * sizes[1], z0 + cz * sizes[2]))
                self.colors.append(rgba)  # type: ignore[arg-type]
            self.faces.extend([(base, base + 1, base + 2), (base, base + 2, base + 3)])

    def mesh(self):
        import trimesh
        return trimesh.Trimesh(
            vertices=np.array(self.vertices, dtype=np.float64),
            faces=np.array(self.faces, dtype=np.int64),
            vertex_colors=np.array(self.colors, dtype=np.uint8),
            process=False,
        )


def _wall_colors(rgb_small: np.ndarray, plan: MapPlan, rect: tuple[int, int, int, int]) -> tuple[float, float, float]:
    r, c, ch, cw = rect
    patch = rgb_small[r:r + ch, c:c + cw]
    return tuple(float(v) for v in patch.reshape(-1, 3).mean(axis=0))  # type: ignore[return-value]


def build_scene(rgb: np.ndarray, texture: Image.Image, plan: MapPlan, opts: MapOptions):
    import trimesh
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    gh, gw = plan.mask.shape
    cell = plan.cell_m
    width, depth = gw * cell, gh * cell
    wall_h = max(0.5, float(opts.wall_height))
    scene = trimesh.Scene()

    # Floor: the picture itself, mapped top-down.
    floor_v = np.array([[0, 0, 0], [width, 0, 0], [width, 0, depth], [0, 0, depth]], dtype=np.float64)
    floor_f = np.array([[0, 2, 1], [0, 3, 2]])
    uv = np.array([[0, 1], [1, 1], [1, 0], [0, 0]], dtype=np.float64)
    material = PBRMaterial(name="MapFloor", baseColorTexture=texture, metallicFactor=0.0, roughnessFactor=0.9)
    floor = trimesh.Trimesh(vertices=floor_v, faces=floor_f, process=False)
    floor.visual = TextureVisuals(uv=uv, material=material)
    scene.add_geometry(floor, node_name="Floor", geom_name="Floor")

    # Walls: colours from the picture, or a plain wall colour when the plan draws walls in near-black.
    small = np.asarray(Image.fromarray((rgb * 255).astype(np.uint8)).resize((gw, gh), Image.Resampling.BOX), dtype=np.float32) / 255.0
    wall_lum = float((small[plan.mask] @ np.array([0.299, 0.587, 0.114])).mean())
    from_picture = wall_lum > 0.25
    walls = _MeshBuilder()
    for rect in greedy_rectangles(plan.mask):
        r, c, ch, cw = rect
        colour = _wall_colors(small, plan, rect)
        side = colour if from_picture else PLAIN_WALL
        top = colour if from_picture else tuple(min(1.0, v * 1.15 + 0.05) for v in colour)
        walls.box(c * cell, 0.0, r * cell, (c + cw) * cell, wall_h, (r + ch) * cell, side=side, top=top)  # type: ignore[arg-type]
    # Lintels above doors.
    for door in plan.doors:
        r0, c0, r1, c1 = door.cells
        if door.height < wall_h - 0.05:
            walls.box(c0 * cell, door.height, r0 * cell, (c1 + 1) * cell, wall_h, (r1 + 1) * cell,
                      side=PLAIN_WALL if not from_picture else tuple(small[max(0, r0 - 1), c0]), bottom=True)  # type: ignore[arg-type]
    if walls.faces:
        scene.add_geometry(walls.mesh(), node_name="Walls", geom_name="Walls")

    # Doors: one node per door with the hinge at its origin; the leaf runs along local +x.
    for door in plan.doors:
        leaf = _MeshBuilder()
        clearance = 0.01
        t = door.thickness
        leaf.box(clearance, 0.0, -t / 2, door.length - clearance, door.height, t / 2, side=DOOR_WOOD, bottom=True)
        hx = door.length * 0.85
        for zs in (t / 2, -t / 2 - 0.04):
            leaf.box(hx - 0.06, door.height * 0.47, zs, hx + 0.06, door.height * 0.47 + 0.03, zs + 0.04, side=DOOR_HANDLE, bottom=True)
        transform = np.eye(4)
        if door.axis == "z":
            transform[:3, :3] = _rot_y(-math.pi / 2)
        transform[0, 3], transform[2, 3] = door.hinge
        scene.add_geometry(leaf.mesh(), node_name=door.name, geom_name=door.name, transform=transform)
    return scene


def _rot_y(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _quat_y(theta: float) -> list[float]:
    return [0.0, math.sin(theta / 2), 0.0, math.cos(theta / 2)]


def _quat_mul(a: list[float], b: list[float]) -> list[float]:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


# ─── GLB post-processing: door TRS, extras and open animations ───────────────

def _read_glb(data: bytes) -> tuple[dict[str, Any], bytearray]:
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise MapBuildError("Exporter did not produce a GLB")
    offset = 12
    gltf: dict[str, Any] = {}
    binary = bytearray()
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8: offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(chunk.decode("utf-8"))
        elif chunk_type == 0x004E4942:
            binary = bytearray(chunk)
        offset += 8 + chunk_len
    return gltf, binary


def _write_glb(gltf: dict[str, Any], binary: bytearray) -> bytes:
    while len(binary) % 4:
        binary.append(0)
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(binary)
    else:
        gltf["buffers"] = [{"byteLength": len(binary)}]
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (struct.pack("<4sII", b"glTF", 2, total)
            + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(binary), 0x004E4942) + bytes(binary))


def add_door_animations(glb: bytes, doors: list[Door]) -> bytes:
    if not doors:
        return glb
    gltf, binary = _read_glb(glb)
    nodes = gltf.get("nodes", [])
    by_name = {n.get("name"): i for i, n in enumerate(nodes)}
    gltf.setdefault("bufferViews", [])
    gltf.setdefault("accessors", [])
    animations = gltf.setdefault("animations", [])

    def push(values: list[float], kind: str, count: int) -> int:
        while len(binary) % 4:
            binary.append(0)
        start = len(binary)
        binary.extend(struct.pack(f"<{len(values)}f", *values))
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": start, "byteLength": len(values) * 4})
        accessor: dict[str, Any] = {"bufferView": len(gltf["bufferViews"]) - 1, "componentType": 5126, "count": count, "type": kind}
        if kind == "SCALAR":
            accessor["min"], accessor["max"] = [min(values)], [max(values)]
        gltf["accessors"].append(accessor)
        return len(gltf["accessors"]) - 1

    times = push([0.0, OPEN_SECONDS], "SCALAR", 2)
    for door in doors:
        index = by_name.get(door.name)
        if index is None:
            continue
        base = _quat_y(-math.pi / 2) if door.axis == "z" else [0.0, 0.0, 0.0, 1.0]
        opened = _quat_mul(base, _quat_y(door.swing * math.pi / 2))
        node = nodes[index]
        node.pop("matrix", None)
        node["translation"] = [door.hinge[0], 0.0, door.hinge[1]]
        node["rotation"] = base
        node["extras"] = {"polypal_door": {"swing": door.swing, "angle_deg": 90, "open_seconds": OPEN_SECONDS}}
        rotations = push(base + opened, "VEC4", 2)
        animations.append({
            "name": f"Open {door.name}",
            "samplers": [{"input": times, "output": rotations, "interpolation": "LINEAR"}],
            "channels": [{"sampler": 0, "target": {"node": index, "path": "rotation"}}],
        })
    return _write_glb(gltf, binary)


# ─── Entry point ──────────────────────────────────────────────────────────────

def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 _-]+", "", name or "").strip().replace(" ", "_")
    return cleaned[:60] or "map"


def load_picture(image_bytes: bytes) -> tuple[np.ndarray, Image.Image]:
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:  # PIL raises many types for bad input
        raise MapBuildError("That file is not a picture PolyPal can read") from exc
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image)
    image = image.convert("RGB")
    texture = image.copy()
    texture.thumbnail((MAX_TEXTURE_SIDE, MAX_TEXTURE_SIDE))
    work = image.copy()
    work.thumbnail((MAX_PROCESS_SIDE, MAX_PROCESS_SIDE))
    return np.asarray(work, dtype=np.float32) / 255.0, texture


def build_map(image_bytes: bytes, opts: MapOptions, filename: Optional[str] = None) -> dict[str, Any]:
    started = time.monotonic()
    rgb, texture = load_picture(image_bytes)
    plan = plan_map(rgb, opts)
    scene = build_scene(rgb, texture, plan, opts)
    glb = add_door_animations(scene.export(file_type="glb"), plan.doors)

    folder = registry.WORKSPACE_DIR / "Maps"
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{_safe_name(opts.name)}_{int(time.time())}"
    out = folder / f"{stem}.glb"
    out.write_bytes(glb)

    input_info = provenance.store_input_image(image_bytes, filename)
    params = {
        "width_m": opts.width_m, "wall_height": opts.wall_height, "walls": opts.walls,
        "wall_color": list(opts.wall_color) if opts.wall_color else None,
        "tolerance": opts.tolerance, "doors": opts.doors,
    }
    provenance.record_generation(
        out, model_id="polypal/map-builder", manifest={"name": "PolyPal Map Builder", "version": "1"},
        params=params, deterministic=True, input_info=input_info, collection="Maps", started_at=started,
    )
    gh, gw = plan.mask.shape
    rel = out.resolve().relative_to(registry.WORKSPACE_DIR.resolve()).as_posix()
    return {
        "path": rel,
        "url": f"/workspace/{rel}",
        "size_m": [round(gw * plan.cell_m, 2), round(opts.wall_height, 2), round(gh * plan.cell_m, 2)],
        "wall_count": len(greedy_rectangles(plan.mask)),
        "doors": [{"name": d.name, "width_m": round(d.length, 2), "swing": d.swing} for d in plan.doors],
        "cell_m": round(plan.cell_m, 4),
        "seconds": round(time.monotonic() - started, 2),
    }
