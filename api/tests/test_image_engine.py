import asyncio
import base64
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import services.generator_registry as registry
from services import image_engine

FAKE_SD = '''#!{python}
import json, sys
args = sys.argv[1:]
if "--help" in args:
    print("usage: sd [options]  -M, --mode [img_gen|vid_gen|convert]")
    sys.exit(0)
log = {log!r}
with open(log, "a") as fh:
    fh.write(json.dumps(args) + "\\n")
if "FAIL" in args:
    print("error: model failed to load"); sys.exit(1)
print("loading model")
for i in range(1, 5):
    print(f"  |====>  | {{i}}/4 - 0.1s/it sampling")
print("decoding latents")
out = args[args.index("-o") + 1]
import struct, zlib
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\\x00\\xff\\x00\\x00")) + chunk(b"IEND", b"")
open(out, "wb").write(png)
'''


def _png_data_url() -> str:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (8, 8), (255, 0, 0, 128)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@unittest.skipIf(sys.platform == "win32", "fake engine is a POSIX script")
class ImageEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ws = root / "ws"
        self.ws.mkdir()
        self.log = root / "calls.jsonl"
        self._env = mock.patch.dict(os.environ, {"POLYPAL_IMAGEGEN_DIR": str(root / "imagegen")})
        self._env.start()
        self._ws = mock.patch.object(registry, "WORKSPACE_DIR", self.ws)
        self._ws.start()
        image_engine._help_cache.clear()
        bin_dir = image_engine.bin_dir()
        bin_dir.mkdir(parents=True)
        sd = bin_dir / "sd"
        sd.write_text(FAKE_SD.format(python=sys.executable, log=str(self.log)))
        sd.chmod(0o755)
        for model_id in ("sd-turbo", "flux-kontext"):
            for _, path in image_engine.model_files(image_engine.get_model(model_id)):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"weights")

    def tearDown(self) -> None:
        self._ws.stop()
        self._env.stop()
        self._tmp.cleanup()

    def _calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_catalog_and_download_state(self) -> None:
        models = {m["id"]: m for m in image_engine.list_models()}
        self.assertTrue(models["sd-turbo"]["downloaded"])
        self.assertFalse(models["sdxl-turbo"]["downloaded"])
        # The catalog default isn't downloaded, so the first ready model is used.
        self.assertEqual(image_engine.default_model_id(), "sd-turbo")

    def test_text_to_image_command_and_progress(self) -> None:
        out = self.ws / "a.png"
        steps = []
        request = image_engine.ImageRequest(prompt="a red teapot", model_id="sd-turbo", seed=7, purpose="3d")
        image_engine.run(request, out, lambda pct, step: steps.append(pct))
        self.assertTrue(out.read_bytes().startswith(b"\x89PNG"))
        args = self._calls()[0]
        self.assertIn("plain white background", args[args.index("-p") + 1])
        self.assertEqual(args[args.index("-s") + 1], "7")
        self.assertEqual(args[args.index("--steps") + 1], "4")
        self.assertNotIn("-n", args)  # cfg 1.0 models ignore negatives
        self.assertEqual(steps[-1], 100)
        self.assertIn(95, steps)

    def test_single_reference_models_edit_the_first_picture(self) -> None:
        refs = [self.ws / "r1.png", self.ws / "r2.png"]
        for r in refs:
            r.write_bytes(b"x")
        request = image_engine.ImageRequest(prompt="make it blue", model_id="sd-turbo", references=refs, strength=0.5)
        image_engine.run(request, self.ws / "b.png", lambda *_: None)
        args = self._calls()[0]
        self.assertEqual(args[args.index("-i") + 1], str(refs[0]))
        self.assertEqual(args[args.index("--strength") + 1], "0.5")
        self.assertNotIn("-M", args)  # this engine build infers img2img (img_gen mode)

    def test_multi_reference_models_get_every_picture(self) -> None:
        refs = []
        for i in range(7):
            ref = self.ws / f"r{i}.png"
            ref.write_bytes(b"x")
            refs.append(ref)
        request = image_engine.ImageRequest(prompt="combine", model_id="flux-kontext", references=refs)
        image_engine.run(request, self.ws / "c.png", lambda *_: None)
        args = self._calls()[0]
        self.assertEqual(args.count("-r"), image_engine.MAX_REFERENCES)
        for flag in ("--diffusion-model", "--vae", "--clip_l", "--t5xxl", "--guidance", "--vae-tiling"):
            self.assertIn(flag, args)

    def test_engine_failure_reports_its_output(self) -> None:
        request = image_engine.ImageRequest(prompt="FAIL", model_id="sd-turbo")
        with mock.patch.object(image_engine, "build_command", lambda b, r, o: [str(b), "FAIL", "-o", str(o)]):
            with self.assertRaises(RuntimeError) as ctx:
                image_engine.run(request, self.ws / "d.png", lambda *_: None)
        self.assertIn("model failed to load", str(ctx.exception))

    def test_route_queues_job_and_lists_gallery(self) -> None:
        from routers import images

        response = asyncio.run(images.generate(images.GenerateRequest(
            prompt="a lamp", references=[_png_data_url()], model_id="sd-turbo",
        )))
        deadline = time.time() + 15
        job = images._jobs[response["job_id"]]
        while job["status"] in ("pending", "running") and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertTrue((self.ws / job["path"]).is_file())
        gallery = asyncio.run(images.gallery())
        self.assertEqual(gallery[0]["prompt"], "a lamp")
        asyncio.run(images.delete_image(gallery[0]["path"]))
        self.assertEqual(asyncio.run(images.gallery()), [])

    def test_route_refuses_without_engine_or_model(self) -> None:
        from fastapi import HTTPException
        from routers import images

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(images.generate(images.GenerateRequest(prompt="x", model_id="sdxl-turbo")))
        self.assertEqual(ctx.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            asyncio.run(images.generate(images.GenerateRequest(prompt="x", model_id="sd-turbo", references=[_png_data_url()] * 6)))


class AssetPickingTests(unittest.TestCase):
    ASSETS = [{"name": n} for n in (
        "sd-master-abc-bin-win-cuda12-x64.zip", "cudart-sd-bin-win-cu12-x64.zip", "sd-master-abc-bin-win-vulkan-x64.zip",
        "sd-master-abc-bin-win-avx2-x64.zip", "sd-master-abc-bin-Linux-Ubuntu-24.04-x86_64.zip",
        "sd-master-abc-bin-Darwin-macOS-15.0-arm64.zip",
    )]

    def test_platform_choices(self) -> None:
        pick = lambda **kw: image_engine.pick_asset(self.ASSETS, **kw)["name"]  # noqa: E731
        self.assertIn("cuda12", pick(platform="win32", nvidia=True))
        self.assertIn("vulkan", pick(platform="win32", nvidia=False))
        self.assertIn("Darwin", pick(platform="darwin", nvidia=False))
        self.assertIn("Linux", pick(platform="linux", nvidia=False))


if __name__ == "__main__":
    unittest.main()
