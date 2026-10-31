import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import services.generator_registry as registry
from services import meshes, provenance


class MeshTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name).resolve()
        self._patch = patch.object(registry, "WORKSPACE_DIR", self.ws)
        self._patch.start()
        for folder in ("Default", "Library/abc", "Images", ".polypal/inputs"):
            (self.ws / folder).mkdir(parents=True)
        self.mesh = self.ws / "Default" / "cat.glb"
        self.mesh.write_bytes(b"glTF")
        self.edit = self.ws / "Default" / "cat_edit_1.glb"
        self.edit.write_bytes(b"glTF2")
        (self.ws / ".polypal/inputs/abc.png").write_bytes(b"png")
        provenance.sidecar_for(self.mesh).write_text(json.dumps({
            "kind": "generation", "generation": {"model_name": "M", "input": {"stored_path": ".polypal/inputs/abc.png"}}}))
        provenance.sidecar_for(self.edit).write_text(json.dumps({"kind": "edit", "parent": "Default/cat.glb"}))
        (self.ws / "Library/abc/model.glb").write_bytes(b"lib")
        (self.ws / "Images/x.glb").write_bytes(b"no")

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def test_lists_only_generated_meshes_with_thumbnail_from_root_input(self) -> None:
        items = meshes.list_meshes()
        self.assertEqual(sorted(i["path"] for i in items), ["Default/cat.glb", "Default/cat_edit_1.glb"])
        edit = next(i for i in items if i["path"] == "Default/cat_edit_1.glb")
        self.assertEqual(edit["thumbnail_url"], "/workspace/.polypal/inputs/abc.png")
        self.assertEqual(edit["kind"], "edit")

    def test_delete_removes_mesh_and_sidecar(self) -> None:
        self.assertTrue(meshes.delete_mesh("/workspace/Default/cat.glb"))
        self.assertFalse(self.mesh.exists())
        self.assertFalse(provenance.sidecar_for(self.mesh).exists())
        self.assertFalse(meshes.delete_mesh("Default/cat.glb"))

    def test_delete_refuses_library_outside_and_non_meshes(self) -> None:
        for bad in ("Library/abc/model.glb", "../escape.glb", "/etc/passwd", "Default/cat.glb.provenance.json", ".polypal/inputs/abc.png"):
            with self.assertRaises(meshes.MeshError, msg=bad):
                meshes.delete_mesh(bad)
        self.assertTrue((self.ws / "Library/abc/model.glb").exists())


if __name__ == "__main__":
    unittest.main()
