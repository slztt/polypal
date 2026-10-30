import threading
import time
import unittest

from services import gpu
from services.priority_queue import PriorityJobQueue, normalize_priority


class PriorityQueueTests(unittest.TestCase):
    def _blocked_queue(self):
        """A queue whose worker is busy until `release` is set."""
        queue = PriorityJobQueue("test-queue")
        started, release = threading.Event(), threading.Event()

        def blocker():
            started.set()
            release.wait(5)
            return "blocker"

        first = queue.submit("blocker", "normal", blocker)
        self.assertTrue(started.wait(2))
        return queue, release, first

    def test_runs_by_priority_then_arrival(self) -> None:
        queue, release, first = self._blocked_queue()
        order: list[str] = []
        futures = [
            queue.submit(name, priority, order.append, name)
            for name, priority in (("low-1", "low"), ("normal-1", "normal"), ("high-1", "high"), ("normal-2", "normal"))
        ]
        snapshot = queue.snapshot()
        self.assertEqual(snapshot["running"], "blocker")
        self.assertEqual([q["job_id"] for q in snapshot["queued"]], ["high-1", "normal-1", "normal-2", "low-1"])
        release.set()
        for future in [first, *futures]:
            future.result(timeout=2)
        self.assertEqual(order, ["high-1", "normal-1", "normal-2", "low-1"])

    def test_reprioritize_moves_a_waiting_job(self) -> None:
        queue, release, _ = self._blocked_queue()
        order: list[str] = []
        a = queue.submit("a", "normal", order.append, "a")
        b = queue.submit("b", "low", order.append, "b")
        self.assertEqual(queue.position("b"), 2)
        self.assertTrue(queue.reprioritize("b", "high"))
        self.assertEqual(queue.position("b"), 1)
        self.assertFalse(queue.reprioritize("missing", "high"))
        release.set()
        a.result(2), b.result(2)
        self.assertEqual(order, ["b", "a"])

    def test_cancelled_waiter_is_skipped(self) -> None:
        queue, release, _ = self._blocked_queue()
        ran: list[str] = []
        cancelled = queue.submit("x", "high", ran.append, "x")
        kept = queue.submit("y", "normal", ran.append, "y")
        self.assertTrue(cancelled.cancel())
        self.assertNotIn("x", [q["job_id"] for q in queue.snapshot()["queued"]])
        release.set()
        kept.result(2)
        self.assertEqual(ran, ["y"])

    def test_exceptions_reach_the_caller(self) -> None:
        queue = PriorityJobQueue("errors")

        def boom():
            raise RuntimeError("nope")

        with self.assertRaises(RuntimeError):
            queue.submit("e", "normal", boom).result(2)
        # The worker survives and keeps serving.
        self.assertEqual(queue.submit("ok", "normal", lambda: 5).result(2), 5)

    def test_priority_names_are_normalised(self) -> None:
        self.assertEqual(normalize_priority("HIGH"), "high")
        self.assertEqual(normalize_priority("urgent"), "normal")
        self.assertEqual(normalize_priority(None), "normal")


class GpuPlanningTests(unittest.TestCase):
    GPU = [{"index": 0, "name": "RTX", "vendor": "nvidia", "total_mb": 12288, "used_mb": 8288, "free_mb": 4000}]

    def test_parse_nvidia_smi(self) -> None:
        out = "0, NVIDIA GeForce RTX 4070, 12282, 1024, 11258\n1, Bad, x, 1, 2\n"
        gpus = gpu.parse_nvidia_smi(out)
        self.assertEqual(len(gpus), 1)
        self.assertEqual(gpus[0]["free_mb"], 11258)

    def test_query_falls_back_to_empty_without_nvidia_smi(self) -> None:
        def missing():
            raise FileNotFoundError("nvidia-smi")
        self.assertEqual(gpu.query_gpus(force=True, runner=missing), [])

    def test_texture_adds_declared_or_default_overhead(self) -> None:
        self.assertEqual(gpu.estimate_generation_mb({"vram_gb": 4}), 4096)
        self.assertEqual(gpu.estimate_generation_mb({"vram_gb": 4, "vram_texture_gb": 2}, {"enable_texture": True}), 6144)
        self.assertEqual(gpu.estimate_generation_mb({"vram_gb": 4}, {"enable_texture": "true"}), 5120)
        self.assertIsNone(gpu.estimate_generation_mb({}))

    def test_verdicts(self) -> None:
        plan = gpu.plan_launch("m", {"vram_gb": 3}, {}, self.GPU, [])
        self.assertEqual(plan.verdict, "fits")

        resident = [
            {"kind": "llm", "id": "qwen", "mb": 5000, "is_target": False},
            {"kind": "generator", "id": "other", "mb": 1000, "is_target": False},
        ]
        plan = gpu.plan_launch("m", {"vram_gb": 6}, {}, self.GPU, resident)
        self.assertEqual(plan.verdict, "fits_after_unload")
        self.assertEqual([u["id"] for u in plan.unload], ["qwen"])

        plan = gpu.plan_launch("m", {"vram_gb": 10}, {}, self.GPU, resident)
        self.assertEqual(plan.verdict, "tight")

        plan = gpu.plan_launch("m", {"vram_gb": 24}, {}, self.GPU, resident)
        self.assertEqual(plan.verdict, "exceeds")

        loaded = [{"kind": "generator", "id": "m", "mb": 9000, "is_target": True}]
        self.assertEqual(gpu.plan_launch("m", {"vram_gb": 9}, {}, self.GPU, loaded).verdict, "fits")
        self.assertEqual(gpu.plan_launch("m", {}, {}, self.GPU, []).verdict, "unknown")
        self.assertEqual(gpu.plan_launch("m", {"vram_gb": 2}, {}, [], []).verdict, "unknown")

    def test_idle_policy(self) -> None:
        saved = (gpu.policy.unload_before_launch, gpu.policy.idle_unload_minutes)
        try:
            gpu.policy.update(idle_unload_minutes=10, unload_before_launch="bogus")
            self.assertEqual(gpu.policy.unload_before_launch, saved[0])
            now = time.monotonic()
            gpu.touch_generator("old", now - 3600)
            gpu.touch_generator("fresh", now - 60)
            gpu.touch_generator("busy", now - 3600)
            self.assertEqual(gpu.idle_generators_to_unload(["old", "fresh", "busy", "never"], {"busy"}, now), ["old"])
            gpu.policy.update(idle_unload_minutes=0)
            self.assertEqual(gpu.idle_generators_to_unload(["old"], set(), now), [])
        finally:
            gpu.policy.unload_before_launch, gpu.policy.idle_unload_minutes = saved


if __name__ == "__main__":
    unittest.main()
