import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

try:
    import trimesh
    from PIL import Image
    HAVE_DEPS = True
except ImportError:  # pragma: no cover
    HAVE_DEPS = False

import services.generator_registry as registry
from services import provenance, texturing


def _picture(width=200, height=100, transparent=False):
    """Left half red, right half blue, on white (or transparent) — object centred."""
    img = np.full((height + 40, width + 40, 4), 255, dtype=np.uint8)
    if transparent:
        img[..., 3] = 0
    img[20:20 + height, 20:20 + width // 2] = [220, 30, 30, 255]
    img[20:20 + height, 20 + width // 2:20 + width] = [30, 30, 220, 255]
    return img


def _png(rgba) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def _slab():
    """2 wide × 1 tall × 0.3 deep, densely subdivided (like generated meshes)."""
    mesh = trimesh.creation.box(extents=[2.0, 1.0, 0.3])
    for _ in range(4):
        mesh = mesh.subdivide()
    return mesh


@unittest.skipUnless(HAVE_DEPS, "trimesh/Pillow not installed")
class ProjectionTests(unittest.TestCase):
    def test_front_view_chosen_and_sides_painted_correctly(self) -> None:
        mesh = _slab()
        result = texturing.project_texture(mesh.vertices, mesh.faces, _picture())
        self.assertEqual(result.view, "front (+Z)")
        self.assertGreater(result.silhouette_match, 0.7)
        colours = result.vertex_colors.astype(int)
        left, right = mesh.vertices[:, 0] < -0.3, mesh.vertices[:, 0] > 0.3
        self.assertTrue((colours[left, 0] > colours[left, 2]).mean() > 0.95)
        self.assertTrue((colours[right, 2] > colours[right, 0]).mean() > 0.95)
        # No vertex picks up the white backdrop.
        self.assertFalse(((colours[:, :3] > 230).all(axis=1)).any())

    def test_side_view_is_detected_from_the_outline(self) -> None:
        mesh = _slab()
        mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
        result = texturing.project_texture(mesh.vertices, mesh.faces, _picture())
        self.assertIn(result.view, ("right (+X)", "left (-X)"))

    def test_transparent_backgrounds_and_empty_pictures(self) -> None:
        mask = texturing.foreground_mask(_picture(transparent=True))
        self.assertAlmostEqual(mask.mean(), (200 * 100) / (240 * 140), places=3)
        with self.assertRaises(texturing.TexturingError):
            texturing.foreground_mask(np.full((50, 50, 4), 255, dtype=np.uint8))
        with self.assertRaises(texturing.TexturingError):
            texturing.load_image(b"not an image")

    def test_hidden_back_mirrors_the_pictured_side(self) -> None:
        mesh = _slab()
        result = texturing.project_texture(mesh.vertices, mesh.faces, _picture(), view="front (+Z)")
        back = mesh.vertices[:, 2] < -0.1
        colours = result.vertex_colors.astype(int)
        back_left = back & (mesh.vertices[:, 0] < -0.3)
        self.assertTrue((colours[back_left, 0] > colours[back_left, 2]).all())
        self.assertLess(result.visible_share, 0.9)


def _lit_sphere_picture(size=240, albedo=(230, 120, 40), light=(-0.6, 0.6, 0.53)):
    """A uniformly coloured ball photographed under a strong key light from the top left."""
    img = np.full((size, size, 4), 255, dtype=np.uint8)
    c, r = size / 2, size * 0.4
    ys, xs = np.mgrid[0:size, 0:size]
    nx, ny = (xs - c) / r, -(ys - c) / r
    inside = nx ** 2 + ny ** 2 < 1
    nz = np.sqrt(np.clip(1 - nx ** 2 - ny ** 2, 0, 1))
    L = np.array(light) / np.linalg.norm(light)
    shade = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1) * 0.85 + 0.15
    for k in range(3):
        img[..., k] = np.where(inside, np.clip(albedo[k] * shade, 0, 255), 255)
    return img


@unittest.skipUnless(HAVE_DEPS, "trimesh/Pillow not installed")
class LightingAndFillTests(unittest.TestCase):
    def test_photo_lighting_is_removed(self) -> None:
        mesh = trimesh.creation.icosphere(subdivisions=5, radius=1.0)
        picture = _lit_sphere_picture()
        raw = texturing.project_texture(mesh.vertices, mesh.faces, picture, view="front (+Z)", remove_lighting=False)
        fixed = texturing.project_texture(mesh.vertices, mesh.faces, picture, view="front (+Z)")
        front = mesh.vertices[:, 2] > 0.5
        def spread(result):
            lum = result.vertex_colors[front, :3].astype(float) @ np.array([0.299, 0.587, 0.114])
            return lum.std() / lum.mean()
        self.assertLess(spread(fixed), spread(raw) * 0.5)
        self.assertGreater(fixed.lighting_removed, 0.1)
        # Hue survives: still orange.
        mean = fixed.vertex_colors[front, :3].mean(axis=0)
        self.assertGreater(mean[0], mean[1] > mean[2] and mean[1] or 0)

    def test_small_front_details_are_not_copied_onto_the_back(self) -> None:
        mesh = _slab()
        picture = _picture()
        picture[60:80, 60:80] = [10, 200, 10, 255]  # a small green "logo" on the red half
        result = texturing.project_texture(mesh.vertices, mesh.faces, picture, view="front (+Z)")
        colours = result.vertex_colors.astype(int)
        x, y, z = mesh.vertices[:, 0], mesh.vertices[:, 1], mesh.vertices[:, 2]
        logo_x, logo_y = -0.5, 0.0  # where the logo lands on the slab
        near = (np.abs(x - logo_x) < 0.08) & (np.abs(y - logo_y) < 0.08)
        front_logo = colours[near & (z > 0.1)]
        back_logo = colours[near & (z < -0.1)]
        self.assertTrue((front_logo[:, 1] > front_logo[:, 0]).any())
        self.assertFalse((back_logo[:, 1] > back_logo[:, 0]).any())

    def test_extra_back_view_paints_the_back(self) -> None:
        mesh = _slab()
        front = _picture()
        back = np.full_like(front, 255)
        back[20:120, 20:220] = [240, 220, 20, 255]  # all-yellow back
        result = texturing.project_texture(mesh.vertices, mesh.faces, front, view="front (+Z)", extra_views=[(back, "opposite")])
        colours = result.vertex_colors.astype(int)
        behind = (mesh.vertices[:, 2] < -0.14) & (np.abs(mesh.vertices[:, 0]) < 0.9) & (np.abs(mesh.vertices[:, 1]) < 0.4)
        self.assertTrue(((colours[behind, 0] > 180) & (colours[behind, 1] > 160) & (colours[behind, 2] < 120)).mean() > 0.9)
        self.assertEqual(result.views_used, ("front (+Z)", "back (-Z)"))


@unittest.skipUnless(HAVE_DEPS, "trimesh/Pillow not installed")
class TextureRouteTests(unittest.TestCase):
    def test_uses_the_recorded_source_picture_and_writes_vertex_colours(self) -> None:
        from routers import texture

        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp).resolve()
            with patch.object(registry, "WORKSPACE_DIR", ws):
                mesh_path = ws / "Default" / "slab.glb"
                mesh_path.parent.mkdir()
                _slab().export(str(mesh_path))
                info = provenance.store_input_image(_png(_picture()), "pic.png")
                provenance.record_generation(mesh_path, model_id="m", manifest={}, params={}, deterministic=True,
                                             input_info=info, collection="Default", started_at=0.0)
                response = asyncio.run(texture.project(texture.ProjectRequest(path="Default/slab.glb")))
                out = ws / response["path"]
                loaded = trimesh.load(str(out), force="mesh")
                self.assertEqual(loaded.visual.kind, "vertex")
                self.assertEqual(response["details"]["view"], "front (+Z)")
                self.assertEqual(provenance.read_record(out)["edit"]["steps"][0]["op"], "texture_projection")

    def test_models_without_a_source_picture_need_one(self) -> None:
        from fastapi import HTTPException
        from routers import texture

        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp).resolve()
            with patch.object(registry, "WORKSPACE_DIR", ws):
                (ws / "a.glb").write_bytes(b"x")
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(texture.project(texture.ProjectRequest(path="a.glb")))
                self.assertEqual(ctx.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
