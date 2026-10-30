import unittest

from services.edit_planner import (
    PlanError,
    parse_instruction,
    planner_tool,
    summarise_plan,
    validate_plan,
)
from services.mesh_ops import mesh_ops_registry


def ops(text, stats=None):
    return [(s["op"], s["params"]) for s in parse_instruction(text, stats or {"faces": 100_000})]


class PhraseRuleTests(unittest.TestCase):
    def test_decimate_counts_and_percentages(self) -> None:
        self.assertEqual(ops("reduce to 5k triangles"), [("decimate", {"target_faces": 5000})])
        self.assertEqual(ops("simplify to 12,500 faces"), [("decimate", {"target_faces": 12500})])
        self.assertEqual(ops("reduce the triangle count by 30%"), [("decimate", {"target_faces": 70000})])
        self.assertEqual(ops("decimate to 25%"), [("decimate", {"target_faces": 25000})])
        self.assertEqual(ops("make it low poly"), [("decimate", {"target_faces": 50000})])

    def test_real_world_sizes(self) -> None:
        self.assertEqual(ops("make it 20 cm tall"), [("scale_to_size", {"dimension": "height", "size": 20.0, "unit": "cm"})])
        self.assertEqual(ops("150mm wide"), [("scale_to_size", {"dimension": "width", "size": 150.0, "unit": "mm"})])
        self.assertEqual(ops("resize to 3 inches"), [("scale_to_size", {"dimension": "longest", "size": 3.0, "unit": "in"})])
        self.assertEqual(ops("1,5 m long"), [("scale_to_size", {"dimension": "longest", "size": 1.5, "unit": "m"})])

    def test_rotation_mirroring_and_ambiguous_units(self) -> None:
        self.assertEqual(ops("rotate 45 degrees around x"), [("rotate", {"axis": "x", "degrees": 45.0})])
        self.assertEqual(ops("turn it a quarter turn clockwise"), [("rotate", {"axis": "y", "degrees": -90})])
        self.assertEqual(ops("it's upside down"), [("rotate", {"axis": "x", "degrees": 180})])
        self.assertEqual(ops("mirror it horizontally"), [("mirror", {"axis": "x"})])
        # "45 in x" must read as an axis, not 45 inches.
        self.assertEqual(ops("rotate 45 in x"), [("rotate", {"axis": "x", "degrees": 45.0})])

    def test_cleanup_and_multi_step_order(self) -> None:
        plan = ops("remove the floating bits, fill holes and then smooth it slightly, finally center it")
        self.assertEqual([op for op, _ in plan], ["remove_small_components", "repair", "smooth", "recenter"])
        self.assertEqual(plan[2][1]["iterations"], 2)
        self.assertEqual(ops("keep only the largest piece"), [("remove_small_components", {"keep_largest_only": True})])
        self.assertEqual(ops("the normals look inside-out"), [("fix_normals", {})])

    def test_unrecognised_request_yields_nothing(self) -> None:
        self.assertEqual(parse_instruction("paint it blue"), [])


class ValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.operations = mesh_ops_registry.describe()

    def test_coerces_clamps_and_drops_unknown_params(self) -> None:
        steps, warnings = validate_plan(
            [
                {"op": "decimate", "params": {"target_faces": "50", "colour": "red"}},
                {"op": "rotate", "params": {"axis": "X", "degrees": "720"}},
                {"op": "remove_small_components", "params": {"keep_largest_only": "yes"}},
            ],
            self.operations,
        )
        self.assertEqual(steps[0]["params"], {"target_faces": 100})
        self.assertEqual(steps[1]["params"], {"axis": "x", "degrees": 360.0})
        self.assertIs(steps[2]["params"]["keep_largest_only"], True)
        self.assertEqual(len(warnings), 1)
        self.assertIn("colour", warnings[0])

    def test_rejects_unknown_ops_bad_selects_and_empty_plans(self) -> None:
        with self.assertRaises(PlanError):
            validate_plan([{"op": "delete_everything"}], self.operations)
        with self.assertRaises(PlanError):
            validate_plan([{"op": "mirror", "params": {"axis": "w"}}], self.operations)
        with self.assertRaises(PlanError):
            validate_plan([], self.operations)
        with self.assertRaises(PlanError):
            validate_plan([{"op": "scale", "params": {"factor": "nan"}}], self.operations)

    def test_planner_tool_enumerates_registry_ops(self) -> None:
        tool = planner_tool(self.operations)
        enum = tool["function"]["parameters"]["properties"]["steps"]["items"]["properties"]["op"]["enum"]
        self.assertEqual(set(enum), {op["id"] for op in self.operations})

    def test_summary_reads_naturally(self) -> None:
        summary = summarise_plan([
            {"op": "decimate", "params": {"target_faces": 5000}},
            {"op": "scale_to_size", "params": {"dimension": "height", "size": 20, "unit": "cm"}},
        ])
        self.assertEqual(summary, "Decimate to 5,000 triangles, then set height to 20 cm.")


if __name__ == "__main__":
    unittest.main()
