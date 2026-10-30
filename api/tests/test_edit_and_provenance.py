import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException

import services.generator_registry as registry
from services import provenance

try:
    import trimesh
    HAVE_TRIMESH = True
except ImportError:  # pragma: no cover
    HAVE_TRIMESH = False


class _WorkspaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name).resolve()
        self._patch = patch.object(registry, "WORKSPACE_DIR", self.workspace)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()


class SeedResolutionTests(unittest.TestCase):
    def test_random_seeds_are_pinned(self) -> None:
        for value in (-1, None, "random", "-5"):
            params, deterministic = provenance.resolve_seed({"seed": value})
            self.assertTrue(deterministic)
            self.assertIsInstance(params["seed"], int)
            self.assertGreaterEqual(params["seed"], 0)

    def test_explicit_seed_is_kept_and_schema_default_is_materialised(self) -> None:
        self.assertEqual(provenance.resolve_seed({"seed": 42})[0]["seed"], 42)
        params, deterministic = provenance.resolve_seed({}, [{"id": "seed", "default": 7}])
        self.assertEqual(params["seed"], 7)
        self.assertTrue(deterministic)
        params, _ = provenance.resolve_seed({}, [{"id": "seed", "default": -1}])
        self.assertGreaterEqual(params["seed"], 0)

    def test_models_without_seed_are_flagged_non_deterministic(self) -> None:
        params, deterministic = provenance.resolve_seed({"steps": 30})
        self.assertFalse(deterministic)
        self.assertNotIn("seed", params)


class ProvenanceRecordTests(_WorkspaceTest):
    def test_generation_then_edits_form_a_lineage(self) -> None:
        mesh = self.workspace / "Default" / "cat.glb"
        mesh.parent.mkdir()
        mesh.write_bytes(b"glb")
        input_info = provenance.store_input_image(b"\x89PNG fake", "cat.png")
        self.assertTrue((self.workspace / input_info["stored_path"]).is_file())
        provenance.record_generation(
            mesh, model_id="demo/gen", manifest={"name": "Demo", "version": "1.2"},
            params={"seed": 3}, deterministic=True, input_info=input_info,
            collection="Default", started_at=0.0,
        )

        sized = mesh.with_name("cat_sized.glb")
        sized.write_bytes(b"glb")
        provenance.record_edit(sized, mesh, steps=[{
            "op": "scale_to_size", "params": {"size": 20, "unit": "cm"},
            "details": {"units": "m", "real_world": {"size": 20, "unit": "cm"}},
        }])
        smoothed = mesh.with_name("cat_smooth.glb")
        smoothed.write_bytes(b"glb")
        provenance.record_edit(smoothed, sized, steps=[{"op": "smooth", "params": {}}])

        chain = provenance.lineage(smoothed)
        self.assertEqual([r["kind"] for r in chain], ["generation", "edit", "edit"])
        self.assertEqual(chain[0]["generation"]["model_version"], "1.2")
        # Real-world units carry through later edits.
        self.assertEqual(provenance.units_for(smoothed), "m")
        root = provenance.root_generation(smoothed)
        self.assertEqual(root["output"], "Default/cat.glb")
        self.assertEqual(provenance.load_input_image(root), b"\x89PNG fake")

    def test_tampered_input_is_refused(self) -> None:
        info = provenance.store_input_image(b"\x89PNG original")
        (self.workspace / info["stored_path"]).write_bytes(b"changed")
        record = {"generation": {"input": info}}
        self.assertIsNone(provenance.load_input_image(record))

    def test_lineage_survives_a_cycle(self) -> None:
        a, b = self.workspace / "a.glb", self.workspace / "b.glb"
        for path, parent in ((a, "b.glb"), (b, "a.glb")):
            path.write_bytes(b"x")
            provenance.sidecar_for(path).write_text(json.dumps({"kind": "edit", "output": path.name, "parent": parent}))
        self.assertEqual(len(provenance.lineage(a)), 2)

    def test_files_outside_the_workspace_get_no_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as other:
            outside = Path(other) / "x.glb"
            outside.write_bytes(b"x")
            self.assertIsNone(provenance.record_edit(outside, outside, steps=[]))
            self.assertFalse(provenance.sidecar_for(outside).exists())


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class EditRouteTests(_WorkspaceTest):
    def _mesh(self) -> Path:
        path = self.workspace / "Default" / "box.glb"
        path.parent.mkdir(exist_ok=True)
        trimesh.creation.box(extents=[1, 2, 1]).export(str(path))
        return path

    def test_stats_route(self) -> None:
        from routers import edit
        self._mesh()
        stats = asyncio.run(edit.mesh_stats("/workspace/Default/box.glb"))
        self.assertTrue(stats["watertight"])
        self.assertEqual(stats["faces"], 12)
        self.assertIsNone(stats["units"])

    def test_plan_with_rules_then_apply_atomically(self) -> None:
        from routers import edit
        self._mesh()
        plan = asyncio.run(edit.plan_edit(edit.PlanRequest(
            instruction="rotate 90 degrees around z and make it 50 cm tall", path="Default/box.glb",
        )))
        self.assertEqual(plan.source, "rules")
        self.assertEqual([s["op"] for s in plan.steps], ["rotate", "scale_to_size"])

        result = asyncio.run(edit.apply_edit(edit.ApplyRequest(
            path="Default/box.glb", steps=[edit.PlanStep(**s) for s in plan.steps], instruction="x",
        )))
        out = self.workspace / result["path"]
        self.assertTrue(out.is_file())
        self.assertAlmostEqual(result["stats"]["extents"][1], 0.5, places=5)
        self.assertEqual(result["stats"]["units"], "m")
        record = provenance.read_record(out)
        self.assertEqual(record["parent"], "Default/box.glb")
        self.assertEqual([s["op"] for s in record["edit"]["steps"]], ["rotate", "scale_to_size"])
        # Only the final mesh lands in the workspace — no step files.
        glbs = sorted(p.name for p in (self.workspace / "Default").glob("*.glb"))
        self.assertEqual(len(glbs), 2)

    def test_failed_step_writes_nothing(self) -> None:
        from routers import edit
        self._mesh()
        with patch("services.mesh_ops.transforms.MAX_SUBDIVIDED_FACES", 1):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(edit.apply_edit(edit.ApplyRequest(
                    path="Default/box.glb",
                    steps=[edit.PlanStep(op="recenter"), edit.PlanStep(op="subdivide")],
                )))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(len(list((self.workspace / "Default").glob("*.glb"))), 1)

    def test_paths_cannot_escape_the_workspace(self) -> None:
        from routers import edit
        with self.assertRaises(HTTPException) as ctx:
            edit.resolve_mesh_path("../../etc/passwd")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_unmatched_instruction_returns_no_steps(self) -> None:
        from routers import edit
        plan = asyncio.run(edit.plan_edit(edit.PlanRequest(instruction="paint it blue")))
        self.assertEqual(plan.steps, [])
        self.assertEqual(plan.source, "none")


class RegenerateRouteTests(_WorkspaceTest):
    def test_regenerate_replays_root_generation_settings(self) -> None:
        from routers import generation

        mesh = self.workspace / "Default" / "out.glb"
        mesh.parent.mkdir()
        mesh.write_bytes(b"glb")
        info = provenance.store_input_image(b"\x89PNG source", "src.png")
        provenance.record_generation(
            mesh, model_id="demo/gen", manifest={}, params={"seed": 99, "steps": 12},
            deterministic=True, input_info=info, collection="Default", started_at=0.0,
        )
        edited = mesh.with_name("out_edit.glb")
        edited.write_bytes(b"glb")
        provenance.record_edit(edited, mesh, steps=[{"op": "smooth", "params": {}}])

        class _Registry:
            def get_generator(self, model_id):
                return object()

            def get_manifest(self, model_id):
                return {"output": "mesh"}

            def params_schema(self, model_id):
                return []

        tasks = BackgroundTasks()
        with patch.object(generation, "generator_registry", _Registry()):
            response = asyncio.run(generation.regenerate(
                generation.RegenerateRequest(path="Default/out_edit.glb", priority="high"), tasks,
            ))
        self.assertEqual(response["seed"], 99)
        self.assertEqual(response["priority"], "high")
        queued = tasks.tasks[0]
        image_bytes, params, collection = queued.args[1], queued.args[2], queued.args[3]
        self.assertEqual(image_bytes, b"\x89PNG source")
        self.assertEqual(params, {"seed": 99, "steps": 12})
        self.assertEqual(collection, "Default")
        self.assertEqual(queued.args[7]["regenerated_from"], "Default/out.glb")

    def test_regenerate_without_history_is_404(self) -> None:
        from routers import generation

        mesh = self.workspace / "plain.glb"
        mesh.write_bytes(b"x")
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(generation.regenerate(generation.RegenerateRequest(path="plain.glb"), BackgroundTasks()))
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_TRIMESH, "trimesh not installed")
class RealWorldExportTests(_WorkspaceTest):
    def _sized_mesh(self) -> Path:
        mesh = self.workspace / "Default" / "part.glb"
        mesh.parent.mkdir()
        trimesh.creation.box(extents=[0.02, 0.18, 0.02]).export(str(mesh))  # 18 cm tall
        provenance.record_edit(mesh, mesh, steps=[{"op": "scale_to_size", "params": {}, "details": {"units": "m"}}])
        return mesh

    def test_slicer_export_uses_millimetres_for_sized_models(self) -> None:
        import base64
        from routers import export as export_router

        self._sized_mesh()
        token = base64.urlsafe_b64encode(b"Default/part.glb").decode().rstrip("=")
        response = export_router.export_for_slicer("stl", token, "model.stl")
        exported = trimesh.load(trimesh.util.wrap_as_stream(response.body), file_type="stl")
        # 180 mm tall (Y-up rotated to Z-up), not normalised to 50 mm.
        self.assertAlmostEqual(float(max(exported.extents)), 180.0, places=3)

    def test_optimize_export_unit_conversion(self) -> None:
        from routers import optimize

        self._sized_mesh()
        response = optimize.export_mesh("Default/part.glb", "stl", units="mm")
        exported = trimesh.load(trimesh.util.wrap_as_stream(response.body), file_type="stl")
        self.assertAlmostEqual(float(max(exported.extents)), 180.0, places=3)
        with self.assertRaises(HTTPException):
            optimize.export_mesh("Default/part.glb", "stl", units="parsecs")


class LlmPlannerTests(unittest.TestCase):
    def _plan(self, handler, mode="auto"):
        import httpx
        from routers import edit

        real = httpx.AsyncClient
        request = edit.PlanRequest(
            instruction="make the cat print-ready and 12 cm tall", mode=mode,
            provider=edit.PlannerProvider(type="external", base_url="https://llm.test/v1", api_key="k", model="m"),
        )
        with patch.object(httpx, "AsyncClient", lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k)):
            return asyncio.run(edit.plan_edit(request))

    def test_llm_plan_is_validated(self) -> None:
        def handler(request):
            import httpx
            body = json.loads(request.content)
            self.assertEqual(body["tool_choice"]["function"]["name"], "propose_edit_plan")
            args = {"summary": "Clean up and size.", "steps": [
                {"op": "remove_small_components"},
                {"op": "scale_to_size", "params": {"size": "12", "unit": "CM", "bogus": 1}},
            ]}
            return httpx.Response(200, json={"choices": [{"message": {"tool_calls": [
                {"id": "1", "function": {"name": "propose_edit_plan", "arguments": json.dumps(args)}},
            ]}}]})

        plan = self._plan(handler)
        self.assertEqual(plan.source, "llm")
        self.assertEqual(plan.steps[1]["params"], {"size": 12.0, "unit": "cm"})
        self.assertTrue(any("bogus" in w for w in plan.warnings))

    def test_llm_failure_falls_back_to_rules_in_auto_mode(self) -> None:
        import httpx

        plan = self._plan(lambda request: httpx.Response(500, text="down"))
        self.assertEqual(plan.source, "rules")
        self.assertEqual([s["op"] for s in plan.steps], ["scale_to_size"])
        self.assertTrue(plan.warnings)

    def test_llm_failure_is_an_error_in_llm_mode(self) -> None:
        import httpx

        with self.assertRaises(HTTPException) as ctx:
            self._plan(lambda request: httpx.Response(500, text="down"), mode="llm")
        self.assertEqual(ctx.exception.status_code, 502)
