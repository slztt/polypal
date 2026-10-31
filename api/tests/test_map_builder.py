import io
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

import services.generator_registry as registry
from services import map_builder as mb


def floor_plan(light_walls: bool = False) -> bytes:
    bg, fg = ("black", "white") if light_walls else ("white", "black")
    img = Image.new("RGB", (800, 600), bg)
    d = ImageDraw.Draw(img)
    W = 10
    def wall(x0, y0, x1, y1):
        d.rectangle([x0, y0, x1, y1], fill=fg)
    wall(50, 50, 750, 50 + W); wall(50, 550 - W, 380, 550); wall(425, 550 - W, 750, 550)
    wall(50, 50, 50 + W, 550); wall(750 - W, 50, 750, 550)
    wall(400, 50, 400 + W, 200); wall(400, 245, 400 + W, 300)
    wall(50, 300, 200, 300 + W); wall(245, 300, 750, 300 + W)
    d.arc([200, 255, 290, 345], 180, 270, fill=fg, width=1)
    d.text((550, 150), "KITCHEN", fill=fg)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


class MapBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name).resolve()
        self._patch = patch.object(registry, "WORKSPACE_DIR", self.ws)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def test_builds_walls_floor_and_three_doors(self) -> None:
        result = mb.build_map(floor_plan(), mb.MapOptions(name="House"))
        self.assertEqual(len(result["doors"]), 3)
        for door in result["doors"]:
            self.assertAlmostEqual(door["width_m"], 0.85, delta=0.15)
        self.assertTrue((self.ws / result["path"]).is_file())
        # Scale from 20 cm walls: 800 px picture with ~10 px walls ≈ 15 m wide.
        self.assertAlmostEqual(result["size_m"][0], 15, delta=2.5)

    def test_light_walls_on_dark_background(self) -> None:
        result = mb.build_map(floor_plan(light_walls=True), mb.MapOptions(walls="auto"))
        self.assertEqual(len(result["doors"]), 3)

    def test_glb_has_hinged_doors_with_open_animations(self) -> None:
        result = mb.build_map(floor_plan(), mb.MapOptions())
        gltf, _ = mb._read_glb((self.ws / result["path"]).read_bytes())
        names = [n.get("name") for n in gltf["nodes"]]
        self.assertIn("Floor", names)
        self.assertIn("Walls", names)
        doors = [n for n in gltf["nodes"] if str(n.get("name", "")).startswith("Door_")]
        self.assertEqual(len(doors), 3)
        for node in doors:
            self.assertNotIn("matrix", node)
            self.assertIn("translation", node)
            self.assertIn(node["extras"]["polypal_door"]["swing"], (1, -1))
        self.assertEqual(len(gltf["animations"]), 3)
        # The open pose is a quarter turn from the closed pose.
        anim = gltf["animations"][0]
        self.assertEqual(anim["channels"][0]["target"]["path"], "rotation")

    def test_explicit_width_and_no_doors(self) -> None:
        result = mb.build_map(floor_plan(), mb.MapOptions(width_m=40, doors=False))
        self.assertEqual(result["doors"], [])
        self.assertAlmostEqual(result["size_m"][0], 40, delta=1)

    def test_blank_picture_is_rejected(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (200, 200), "white").save(buf, "PNG")
        with self.assertRaises(mb.MapBuildError):
            mb.build_map(buf.getvalue(), mb.MapOptions())
        with self.assertRaises(mb.MapBuildError):
            mb.build_map(b"not an image", mb.MapOptions())

    def test_picked_wall_colour(self) -> None:
        img = Image.new("RGB", (400, 300), (240, 230, 200))
        d = ImageDraw.Draw(img)
        d.rectangle([20, 20, 380, 30], fill=(200, 40, 40))
        d.rectangle([20, 20, 30, 280], fill=(200, 40, 40))
        d.ellipse([200, 150, 260, 210], fill=(30, 30, 30))   # dark blob that is not a wall
        rgb = np.asarray(img, dtype=np.float32) / 255
        mask = mb.wall_mask(rgb, mb.MapOptions(walls="color", wall_color=(200, 40, 40)))
        self.assertTrue(mask[25, 200])
        self.assertFalse(mask[180, 230])

    def test_greedy_rectangles_cover_mask_exactly(self) -> None:
        rng = np.random.default_rng(1)
        mask = rng.random((30, 40)) > 0.6
        cover = np.zeros_like(mask)
        for r, c, h, w in mb.greedy_rectangles(mask):
            self.assertFalse(cover[r:r + h, c:c + w].any())
            cover[r:r + h, c:c + w] = True
        self.assertTrue((cover == mask).all())

    def test_quaternions(self) -> None:
        q = mb._quat_mul(mb._quat_y(-math.pi / 2), mb._quat_y(math.pi / 2))
        np.testing.assert_allclose(q, [0, 0, 0, 1], atol=1e-9)


if __name__ == "__main__":
    unittest.main()
