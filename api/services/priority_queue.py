"""A single-worker job queue ordered by priority, then arrival.

Replaces the FIFO single-thread executor behind pinned generations. Semantics
the generation router relies on are unchanged:

* one job runs at a time (model switch/load/generate stay serialized);
* a queued job's ``Future`` can be cancelled and is then skipped, without
  disturbing the job that is running;
* work items are queue entries, not threads blocked on a lock, so waiting jobs
  never starve the default executor.

On top of that, jobs carry a priority (``high`` > ``normal`` > ``low``) that can
be changed while they wait.
"""

from __future__ import annotations

import heapq
import itertools
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

PRIORITIES = {"high": 0, "normal": 1, "low": 2}


def normalize_priority(value: Optional[str]) -> str:
    # Non-strings (e.g. an unresolved FastAPI Form default) fall back to normal.
    value = (value if isinstance(value, str) else "normal").strip().lower()
    return value if value in PRIORITIES else "normal"


@dataclass(order=True)
class _Entry:
    rank: int
    seq: int
    job_id: str = field(compare=False)
    priority: str = field(compare=False)
    fn: Callable[..., Any] = field(compare=False)
    args: tuple = field(compare=False)
    future: Future = field(compare=False)
    enqueued_at: float = field(compare=False)
    stale: bool = field(default=False, compare=False)


class PriorityJobQueue:
    def __init__(self, name: str = "polypal-priority-queue") -> None:
        self._name = name
        self._heap: list[_Entry] = []
        self._entries: dict[str, _Entry] = {}
        self._seq = itertools.count()
        self._cond = threading.Condition()
        self._worker: Optional[threading.Thread] = None
        self._running_job: Optional[str] = None
        self._running_since: Optional[float] = None

    # -- submission ---------------------------------------------------------

    def submit(self, job_id: str, priority: str, fn: Callable[..., Any], *args: Any) -> Future:
        priority = normalize_priority(priority)
        future: Future = Future()
        entry = _Entry(PRIORITIES[priority], next(self._seq), job_id, priority, fn, args, future, time.time())
        with self._cond:
            self._entries[job_id] = entry
            heapq.heappush(self._heap, entry)
            self._ensure_worker()
            self._cond.notify()
        return future

    def _ensure_worker(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._loop, name=self._name, daemon=True)
            self._worker.start()

    # -- worker -------------------------------------------------------------

    def _next(self) -> _Entry:
        with self._cond:
            while True:
                while self._heap and self._heap[0].stale:
                    heapq.heappop(self._heap)
                if self._heap:
                    entry = heapq.heappop(self._heap)
                    self._entries.pop(entry.job_id, None)
                    return entry
                self._cond.wait()

    def _loop(self) -> None:
        while True:
            entry = self._next()
            if not entry.future.set_running_or_notify_cancel():
                continue  # cancelled while queued
            with self._cond:
                self._running_job, self._running_since = entry.job_id, time.time()
            try:
                result = entry.fn(*entry.args)
            except BaseException as exc:  # noqa: BLE001 — forwarded to the awaiting caller
                entry.future.set_exception(exc)
            else:
                entry.future.set_result(result)
            finally:
                with self._cond:
                    self._running_job, self._running_since = None, None

    # -- inspection & control -------------------------------------------------

    def reprioritize(self, job_id: str, priority: str) -> bool:
        priority = normalize_priority(priority)
        with self._cond:
            entry = self._entries.get(job_id)
            if entry is None or entry.future.cancelled():
                return False
            entry.stale = True  # lazily dropped from the heap
            replacement = _Entry(
                PRIORITIES[priority], entry.seq, job_id, priority,
                entry.fn, entry.args, entry.future, entry.enqueued_at,
            )
            self._entries[job_id] = replacement
            heapq.heappush(self._heap, replacement)
            self._cond.notify()
        return True

    def snapshot(self) -> dict[str, Any]:
        with self._cond:
            waiting = sorted(
                (e for e in self._entries.values() if not e.stale and not e.future.cancelled()),
            )
            return {
                "running": self._running_job,
                "running_since": self._running_since,
                "queued": [
                    {"job_id": e.job_id, "priority": e.priority, "position": i + 1, "enqueued_at": e.enqueued_at}
                    for i, e in enumerate(waiting)
                ],
            }

    def position(self, job_id: str) -> Optional[int]:
        for item in self.snapshot()["queued"]:
            if item["job_id"] == job_id:
                return item["position"]
        return None
