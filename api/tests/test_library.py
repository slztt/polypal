import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import services.generator_registry as registry
from services import library, provenance

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20
PNG_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


class LibraryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name).resolve()
        self._patch = patch.object(registry, "WORKSPACE_DIR", self.ws)
        self._patch.start()
        (self.ws / "Default").mkdir()
        self.mesh = self.ws / "Default" / "cat.glb"
        self.mesh.write_bytes(b"glTF-data")
        provenance.sidecar_for(self.mesh).write_text(json.dumps({"kind": "generation", "units": "m", "generation": {"model_name": "TripoSG"}}))

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def test_save_copies_model_sidecar_and_thumbnail(self) -> None:
        item = library.save_item("/workspace/Default/cat.glb", name="  My   cat ", category="Animals", tags=["cute", "cute", ""], thumbnail=PNG_URL)
        folder = self.ws / "Library" / item["id"]
        self.assertEqual(item["name"], "My cat")
        self.assertEqual(item["tags"], ["cute"])
        self.assertEqual(item["model_name"], "TripoSG")
        self.assertEqual(item["units"], "m")
        self.assertEqual((folder / "model.glb").read_bytes(), b"glTF-data")
        self.assertTrue(provenance.sidecar_for(folder / "model.glb").is_file())
        self.assertEqual(item["url"], f"/workspace/Library/{item['id']}/model.glb")
        self.assertTrue(item["thumbnail_url"].endswith("thumbnail.png"))
        self.assertIn("Animals", library.list_categories())
        # The library holds a copy: deleting the source keeps the item.
        self.mesh.unlink()
        self.assertEqual(len(library.list_items()), 1)

    def test_search_filter_update_and_delete(self) -> None:
        a = library.save_item("Default/cat.glb", name="Cat", category="Animals")
        b = library.save_item("Default/cat.glb", name="Chair", category="Furniture", notes="oak")
        self.assertEqual([i["id"] for i in library.list_items(query="oak")], [b["id"]])
        self.assertEqual([i["id"] for i in library.list_items(category="Animals")], [a["id"]])
        updated = library.update_item(a["id"], name="Tabby", tags=["pet"])
        self.assertEqual((updated["name"], updated["tags"]), ("Tabby", ["pet"]))
        self.assertTrue(library.delete_item(a["id"]))
        self.assertFalse(library.delete_item(a["id"]))
        with self.assertRaises(KeyError):
            library.get_item(a["id"])

    def test_categories_lifecycle(self) -> None:
        library.add_category("Props")
        item = library.save_item("Default/cat.glb", name="x", category="Props")
        self.assertEqual(library.list_categories()[0], library.DEFAULT_CATEGORY)
        library.remove_category("Props")
        self.assertNotIn("Props", library.list_categories())
        self.assertEqual(library.get_item(item["id"])["category"], library.DEFAULT_CATEGORY)
        with self.assertRaises(library.LibraryError):
            library.remove_category(library.DEFAULT_CATEGORY)

    def test_rejects_bad_input(self) -> None:
        with self.assertRaises(library.LibraryError):
            library.save_item("../../etc/passwd.glb", name="x")
        with self.assertRaises(library.LibraryError):
            library.get_item("../x")
        with self.assertRaises(library.LibraryError):
            library.save_item("Default/cat.glb", name="x", thumbnail="data:image/jpeg;base64,AAAA")
        (self.ws / "Default" / "notes.txt").write_text("hi")
        with self.assertRaises(library.LibraryError):
            library.save_item("Default/notes.txt", name="x")
        # A failed save leaves no half-written item behind.
        self.assertEqual(library.list_items(), [])


if __name__ == "__main__":
    unittest.main()
