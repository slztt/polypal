import json
import sys
import tempfile
import unittest
from pathlib import Path

from services.diffusers_compat import preimport_pipeline_modules


class PreimportTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ext = root / "ext"
        package = self.ext / "fakepipe" / "schedulers"
        package.mkdir(parents=True)
        (self.ext / "fakepipe" / "__init__.py").write_text("")
        (package / "__init__.py").write_text("")
        (package / "flow.py").write_text("LOADED = True\n")
        self.model = root / "models" / "fake"
        self.model.mkdir(parents=True)
        sys.path.insert(0, str(self.ext))

    def tearDown(self) -> None:
        sys.path.remove(str(self.ext))
        for name in [m for m in sys.modules if m.startswith("fakepipe")]:
            del sys.modules[name]
        self._tmp.cleanup()

    def _index(self, data: dict, sub: str = "") -> None:
        target = self.model / sub if sub else self.model
        target.mkdir(exist_ok=True)
        (target / "model_index.json").write_text(json.dumps(data))

    def test_imports_extension_local_component_modules(self) -> None:
        self._index({
            "_class_name": "FakePipeline",
            "scheduler": ["fakepipe.schedulers.flow", "RectifiedFlowScheduler"],
            "vae": ["diffusers", "AutoencoderKL"],
            "feature_extractor": ["transformers", "CLIPImageProcessor"],
        })
        imported = preimport_pipeline_modules([self.model], self.ext)
        self.assertEqual(imported, ["fakepipe.schedulers.flow"])
        self.assertIn("fakepipe.schedulers.flow", sys.modules)

    def test_ignores_modules_outside_the_extension(self) -> None:
        # A downloaded config must not be able to import arbitrary installed modules.
        self._index({"scheduler": ["json.tool", "X"], "other": ["does.not.exist", "Y"]})
        self.assertEqual(preimport_pipeline_modules([self.model], self.ext), [])
        self.assertNotIn("json.tool", sys.modules)

    def test_finds_pipelines_in_a_subfolder_and_tolerates_junk(self) -> None:
        self._index({"scheduler": ["fakepipe.schedulers.flow", "S"]}, sub="pipeline")
        (self.model / "model_index.json").write_text("{not json")
        missing = Path(self._tmp.name) / "missing"
        self.assertEqual(preimport_pipeline_modules([missing, self.model], self.ext), ["fakepipe.schedulers.flow"])


if __name__ == "__main__":
    unittest.main()
