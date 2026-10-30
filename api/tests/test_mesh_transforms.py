import tempfile
import unittest
from pathlib import Path

import numpy as np

try:
    import trimesh
    HAVE_TRIMESH = True
except ImportError:  # pragma: no cover
    HAVE_TRIMESH = False

from services.mesh_ops import MeshOpContext, mesh_ops_registry


def _context(directory: Path, name: str = "out.glb") -> MeshOpContext:
    return MeshOpContext(
        workspace_dir=directory,
        temp_dir=directory,
        output_path=directory / name,
    )


def _load(path: Path):
    from services.mesh_io import load_flat_mesh
    return load_flat_mesh(path)


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class MeshAnalysisTests(unittest.TestCase):
    def test_components_ranked_largest_first(self) -> None:
        from services.mesh_analysis import face_component_labels

        big = trimesh.creation.icosphere(subdivisions=2)
        small = trimesh.creation.box(extents=[0.1, 0.1, 0.1])
        small.apply_translation([5, 0, 0])
        combined = trimesh.util.concatenate([small, big])
        labels = face_component_labels(np.asarray(combined.vertices), np.asarray(combined.faces))
        self.assertEqual(int(labels.max()), 1)
        self.assertEqual(int((labels == 0).sum()), len(big.faces))
        self.assertEqual(int((labels == 1).sum()), len(small.faces))

    def test_seam_duplicated_vertices_count_as_one_piece(self) -> None:
        from services.mesh_analysis import face_component_labels

        box = trimesh.creation.box()
        # Unmerge: every face gets its own three vertices (like UV seams).
        vertices = box.vertices[box.faces].reshape(-1, 3)
        faces = np.arange(len(vertices)).reshape(-1, 3)
        labels = face_component_labels(vertices, faces)
        self.assertEqual(set(labels.tolist()), {0})

    def test_orientation_repairs_randomly_flipped_faces(self) -> None:
        from services.mesh_analysis import orient_faces_consistently, signed_volume

        sphere = trimesh.creation.icosphere(subdivisions=2)
        faces = np.asarray(sphere.faces).copy()
        rng = np.random.default_rng(7)
        flip = rng.random(len(faces)) < 0.3
        faces[flip] = faces[flip][:, ::-1]
        fixed, flipped = orient_faces_consistently(faces)
        self.assertGreater(flipped, 0)
        candidate = trimesh.Trimesh(sphere.vertices, fixed, process=False)
        self.assertTrue(candidate.is_winding_consistent)
        self.assertNotAlmostEqual(abs(signed_volume(np.asarray(sphere.vertices), fixed)), 0.0)

    def test_statistics_for_open_and_closed_meshes(self) -> None:
        from services.mesh_analysis import mesh_statistics

        box = trimesh.creation.box(extents=[1, 2, 3])
        stats = mesh_statistics(box)
        self.assertTrue(stats["watertight"])
        self.assertAlmostEqual(stats["volume"], 6.0, places=6)
        self.assertAlmostEqual(stats["surface_area"], 22.0, places=6)
        self.assertEqual(stats["components"], 1)
        self.assertEqual(stats["boundary_edges"], 0)
        np.testing.assert_allclose(stats["extents"], [1, 2, 3])

        opened = trimesh.Trimesh(box.vertices, box.faces[2:], process=False)
        open_stats = mesh_statistics(opened)
        self.assertFalse(open_stats["watertight"])
        self.assertIsNone(open_stats["volume"])
        self.assertGreater(open_stats["boundary_edges"], 0)


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class TransformOperationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, mesh, name: str = "in.glb") -> Path:
        path = self.dir / name
        mesh.export(str(path))
        return path

    def test_scale_to_size_hits_exact_height_and_reports_units(self) -> None:
        source = self._write(trimesh.creation.box(extents=[1.0, 2.0, 0.5]))
        result = mesh_ops_registry.run(
            "scale_to_size", source, {"dimension": "height", "size": 25, "unit": "cm"}, _context(self.dir),
        )
        mesh = _load(result.file_path)
        self.assertAlmostEqual(float(mesh.extents[1]), 0.25, places=6)
        self.assertAlmostEqual(float(mesh.extents[0]), 0.125, places=6)
        self.assertEqual(result.details["units"], "m")
        self.assertAlmostEqual(result.details["scale_factor"], 0.125)

    def test_scale_to_size_rejects_unknown_unit(self) -> None:
        source = self._write(trimesh.creation.box())
        with self.assertRaises(ValueError):
            mesh_ops_registry.run("scale_to_size", source, {"unit": "furlong"}, _context(self.dir))

    def test_rotate_quarter_turn_swaps_extents_and_stays_grounded(self) -> None:
        source = self._write(trimesh.creation.box(extents=[1.0, 2.0, 3.0]))
        result = mesh_ops_registry.run("rotate", source, {"axis": "z", "degrees": 90}, _context(self.dir))
        mesh = _load(result.file_path)
        np.testing.assert_allclose(sorted(mesh.extents), [1.0, 2.0, 3.0], atol=1e-6)
        self.assertAlmostEqual(float(mesh.extents[0]), 2.0, places=6)
        self.assertAlmostEqual(float(mesh.bounds[0][1]), 0.0, places=6)

    def test_mirror_keeps_outward_normals(self) -> None:
        box = trimesh.creation.box()
        box.apply_translation([2.0, 0, 0])
        source = self._write(box)
        result = mesh_ops_registry.run("mirror", source, {"axis": "x"}, _context(self.dir))
        mesh = _load(result.file_path)
        self.assertGreater(mesh.volume, 0)
        np.testing.assert_allclose(mesh.bounds, box.bounds, atol=1e-6)

    def test_recenter_moves_to_origin_and_ground(self) -> None:
        box = trimesh.creation.box(extents=[1, 1, 1])
        box.apply_translation([3, 4, -5])
        result = mesh_ops_registry.run("recenter", self._write(box), {}, _context(self.dir))
        lo, hi = _load(result.file_path).bounds
        self.assertAlmostEqual(float(lo[1]), 0.0, places=6)
        self.assertAlmostEqual(float((lo[0] + hi[0]) / 2), 0.0, places=6)
        self.assertAlmostEqual(float((lo[2] + hi[2]) / 2), 0.0, places=6)

    def test_remove_small_components_drops_floaters(self) -> None:
        big = trimesh.creation.icosphere(subdivisions=2)
        floater = trimesh.creation.box(extents=[0.05, 0.05, 0.05])
        floater.apply_translation([3, 0, 0])
        source = self._write(trimesh.util.concatenate([big, floater]))
        result = mesh_ops_registry.run(
            "remove_small_components", source, {"min_face_share": 0.1}, _context(self.dir),
        )
        self.assertEqual(result.details["components_removed"], 1)
        self.assertEqual(len(_load(result.file_path).faces), len(big.faces))

    def test_fix_normals_turns_inside_out_mesh_outward(self) -> None:
        sphere = trimesh.creation.icosphere(subdivisions=1)
        inverted = trimesh.Trimesh(sphere.vertices, sphere.faces[:, ::-1], process=False)
        source = self._write(inverted)
        result = mesh_ops_registry.run("fix_normals", source, {}, _context(self.dir))
        self.assertTrue(result.details["inverted"])
        self.assertGreater(_load(result.file_path).volume, 0)

    def test_subdivide_quadruples_faces_and_enforces_limit(self) -> None:
        box = trimesh.creation.box()
        result = mesh_ops_registry.run("subdivide", self._write(box), {"iterations": 1}, _context(self.dir))
        self.assertEqual(result.details["face_count"], len(box.faces) * 4)

        from services.mesh_ops import transforms
        original = transforms.MAX_SUBDIVIDED_FACES
        transforms.MAX_SUBDIVIDED_FACES = 10
        try:
            with self.assertRaises(ValueError):
                mesh_ops_registry.run("subdivide", self._write(box, "b.glb"), {"iterations": 1}, _context(self.dir, "c.glb"))
        finally:
            transforms.MAX_SUBDIVIDED_FACES = original

    def test_flatten_bakes_scene_transforms_for_edits(self) -> None:
        # A gizmo transform baked at scene level must survive the next edit.
        scene = trimesh.Scene()
        scene.add_geometry(trimesh.creation.box(), transform=trimesh.transformations.translation_matrix([10, 0, 0]))
        source = self.dir / "scene.glb"
        scene.export(str(source))
        mesh = _load(source)
        self.assertGreater(float(mesh.bounds[0][0]), 9.0)


if __name__ == "__main__":
    unittest.main()
