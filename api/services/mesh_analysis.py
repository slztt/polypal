"""Topology analysis in plain numpy.

PolyPal ships trimesh + numpy without scipy/networkx, so trimesh's graph
helpers (``split``, ``fix_winding``, ``connected_components``) raise "no graph
engines available". The few graph algorithms the editor needs live here:

* connected components (union-find with pointer jumping, vectorised),
* consistent face orientation (BFS over shared edges),
* a statistics probe used by the editor, the copilot and diagnostics.
"""

from collections import deque
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Vertex welding
# ---------------------------------------------------------------------------

def weld_vertices(vertices: np.ndarray, faces: np.ndarray, decimals: int = 6) -> np.ndarray:
    """Map faces onto position-unique vertices.

    Generated meshes duplicate vertices along UV seams, which would make one
    surface look like many disconnected pieces. Returns the re-indexed faces.
    """
    if len(vertices) == 0:
        return faces.copy()
    scale = float(np.max(np.abs(vertices))) or 1.0
    keys = np.round(vertices / scale, decimals)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    return inverse.reshape(-1)[faces]


# ---------------------------------------------------------------------------
# Connected components
# ---------------------------------------------------------------------------

def vertex_component_labels(faces: np.ndarray, vertex_count: int) -> np.ndarray:
    """Label each vertex with the smallest vertex id of its component.

    Min-label hooking over faces plus full pointer jumping; converges in a
    handful of iterations even on large meshes.
    """
    labels = np.arange(vertex_count, dtype=np.int64)
    if len(faces) == 0:
        return labels
    faces = np.asarray(faces, dtype=np.int64)
    while True:
        previous = labels.copy()
        face_min = labels[faces].min(axis=1)
        for column in range(faces.shape[1]):
            roots = labels[faces[:, column]]
            np.minimum.at(labels, roots, face_min)
            np.minimum.at(labels, faces[:, column], face_min)
        # Pointer jumping: collapse every chain onto its root.
        while True:
            jumped = labels[labels]
            if np.array_equal(jumped, labels):
                break
            labels = jumped
        if np.array_equal(labels, previous):
            return labels


def face_component_labels(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Component id (0..k-1, largest first) for every face, after welding."""
    if len(faces) == 0:
        return np.zeros(0, dtype=np.int64)
    welded = weld_vertices(vertices, faces)
    vertex_labels = vertex_component_labels(welded, int(welded.max()) + 1)
    face_roots = vertex_labels[welded[:, 0]]
    roots, inverse, counts = np.unique(face_roots, return_inverse=True, return_counts=True)
    # Renumber so component 0 is the one with the most faces.
    order = np.argsort(-counts, kind="stable")
    rank = np.empty_like(order)
    rank[order] = np.arange(len(order))
    return rank[inverse.reshape(-1)]


# ---------------------------------------------------------------------------
# Edge topology
# ---------------------------------------------------------------------------

def edge_use_counts(faces: np.ndarray) -> np.ndarray:
    """How many faces use each undirected edge (one count per unique edge)."""
    if len(faces) == 0:
        return np.zeros(0, dtype=np.int64)
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    edges.sort(axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return counts


def orient_faces_consistently(faces: np.ndarray) -> tuple[np.ndarray, int]:
    """Flip faces so neighbours agree on winding. Returns (faces, flipped_count).

    Two faces sharing an edge are consistent when they traverse it in
    opposite directions. Each connected patch is walked breadth-first from its
    first face; non-manifold edges (3+ faces) are skipped.
    """
    faces = np.asarray(faces, dtype=np.int64).copy()
    face_count = len(faces)
    if face_count == 0:
        return faces, 0

    directed = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    owner = np.tile(np.arange(face_count), 3)
    undirected = np.sort(directed, axis=1)
    _, edge_id = np.unique(undirected, axis=0, return_inverse=True)
    edge_id = edge_id.reshape(-1)

    order = np.argsort(edge_id, kind="stable")
    sorted_edges = edge_id[order]
    starts = np.flatnonzero(np.r_[True, sorted_edges[1:] != sorted_edges[:-1]])
    ends = np.r_[starts[1:], len(order)]

    neighbours: list[list[tuple[int, bool]]] = [[] for _ in range(face_count)]
    for start, end in zip(starts, ends):
        if end - start != 2:
            continue  # boundary or non-manifold edge
        a, b = order[start], order[start + 1]
        fa, fb = int(owner[a]), int(owner[b])
        if fa == fb:
            continue
        # Same direction on both faces means exactly one of them must flip.
        same = bool(directed[a, 0] == directed[b, 0])
        neighbours[fa].append((fb, same))
        neighbours[fb].append((fa, same))

    flip = np.zeros(face_count, dtype=bool)
    seen = np.zeros(face_count, dtype=bool)
    for seed in range(face_count):
        if seen[seed]:
            continue
        seen[seed] = True
        queue = deque([seed])
        while queue:
            face = queue.popleft()
            for other, same in neighbours[face]:
                if seen[other]:
                    continue
                seen[other] = True
                # Consistent iff their (possibly flipped) directions oppose.
                flip[other] = flip[face] ^ same
                queue.append(other)

    faces[flip] = faces[flip][:, ::-1]
    return faces, int(flip.sum())


def signed_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """Signed volume via the divergence theorem (positive = outward normals)."""
    if len(faces) == 0:
        return 0.0
    tri = vertices[faces]
    return float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6.0)


# ---------------------------------------------------------------------------
# Statistics probe
# ---------------------------------------------------------------------------

def mesh_statistics(mesh: Any) -> dict[str, Any]:
    """Geometry and topology figures for one flattened Trimesh.

    Lengths are in scene units (metres by glTF convention); areas and volumes
    are in square/cubic scene units.
    """
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    stats: dict[str, Any] = {
        "vertices": int(len(vertices)),
        "faces": int(len(faces)),
    }
    if len(vertices) == 0 or len(faces) == 0:
        stats.update({
            "bounds": None, "extents": [0.0, 0.0, 0.0], "surface_area": 0.0,
            "volume": None, "watertight": False, "components": 0,
            "boundary_edges": 0, "non_manifold_edges": 0, "degenerate_faces": 0,
        })
        return stats

    lo, hi = vertices.min(axis=0), vertices.max(axis=0)
    welded = weld_vertices(vertices, faces)
    counts = edge_use_counts(welded)
    boundary = int((counts == 1).sum())
    non_manifold = int((counts > 2).sum())

    tri = vertices[faces]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    doubled_area = np.linalg.norm(cross, axis=1)
    area = float(doubled_area.sum() / 2.0)
    degenerate = int((doubled_area <= 1e-12 * max(1.0, float(np.max(hi - lo)) ** 2)).sum())

    labels = vertex_component_labels(welded, int(welded.max()) + 1)
    components = int(len(np.unique(labels[welded[:, 0]])))

    watertight = boundary == 0 and non_manifold == 0
    volume = abs(signed_volume(vertices, faces)) if watertight else None

    stats.update({
        "bounds": [lo.tolist(), hi.tolist()],
        "extents": (hi - lo).tolist(),
        "surface_area": area,
        "volume": volume,
        "watertight": watertight,
        "components": components,
        "boundary_edges": boundary,
        "non_manifold_edges": non_manifold,
        "degenerate_faces": degenerate,
    })
    return stats
