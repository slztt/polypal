"""GPU memory management for 3D generation.

* ``query_gpus`` — live VRAM figures (NVIDIA via nvidia-smi; empty elsewhere).
* ``plan_launch`` — "will this generation fit?" verdict computed *before* a job
  starts, from the model's declared footprint, the free VRAM and what PolyPal
  itself could release (other generators, local LLMs).
* ``GpuPolicy`` + ``IdleGeneratorReaper`` — automatic resource unloading:
  release VRAM before a launch that would not otherwise fit, and unload 3D
  generators left idle for too long.

Estimates come from extension manifests (``vram_gb`` and the optional
``vram_texture_gb``); a model that declares nothing yields an "unknown"
verdict rather than a guess.
"""

from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Optional

_CACHE_TTL = 2.0
_cache: dict[str, Any] = {"at": 0.0, "gpus": None}
_cache_lock = threading.Lock()

# Fraction of free VRAM a launch may plan to use; the rest absorbs allocator
# fragmentation and the desktop compositor.
HEADROOM = 0.92
TEXTURE_OVERHEAD = 0.25  # used when a manifest has no vram_texture_gb


def _run_nvidia_smi() -> str:
    return subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=index,name,memory.total,memory.used,memory.free",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True, text=True, timeout=5,
    ).stdout


def parse_nvidia_smi(stdout: str) -> list[dict[str, Any]]:
    gpus = []
    for line in stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            index, total, used, free = int(parts[0]), float(parts[2]), float(parts[3]), float(parts[4])
        except ValueError:
            continue
        gpus.append({
            "index": index, "name": parts[1], "vendor": "nvidia",
            "total_mb": int(total), "used_mb": int(used), "free_mb": int(free),
        })
    return gpus


def query_gpus(force: bool = False, runner: Callable[[], str] = _run_nvidia_smi) -> list[dict[str, Any]]:
    """Live VRAM per GPU. Cached briefly; [] when no NVIDIA GPU is visible."""
    with _cache_lock:
        if not force and _cache["gpus"] is not None and time.monotonic() - _cache["at"] < _CACHE_TTL:
            return [dict(g) for g in _cache["gpus"]]
    try:
        gpus = parse_nvidia_smi(runner())
    except (OSError, subprocess.SubprocessError):
        gpus = []
    with _cache_lock:
        _cache.update(at=time.monotonic(), gpus=gpus)
    return [dict(g) for g in gpus]


# ---------------------------------------------------------------------------
# Estimation
# ---------------------------------------------------------------------------

def estimate_generation_mb(manifest: dict[str, Any], params: Optional[dict[str, Any]] = None) -> Optional[int]:
    """Peak VRAM a generation is expected to need, in MiB (None = undeclared)."""
    base_gb = manifest.get("vram_gb")
    if not isinstance(base_gb, (int, float)) or base_gb <= 0:
        return None
    total_gb = float(base_gb)
    params = params or {}
    if params.get("enable_texture") in (True, "true", "1", 1):
        extra = manifest.get("vram_texture_gb")
        total_gb += float(extra) if isinstance(extra, (int, float)) and extra > 0 else total_gb * TEXTURE_OVERHEAD
    return int(total_gb * 1024)


@dataclass
class LaunchPlan:
    model_id: str
    estimate_mb: Optional[int]
    total_mb: Optional[int]
    free_mb: Optional[int]
    reclaimable_mb: int
    already_loaded: bool
    verdict: str            # fits | fits_after_unload | tight | exceeds | unknown
    unload: list[dict[str, Any]]
    message: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def plan_launch(
    model_id: str,
    manifest: dict[str, Any],
    params: Optional[dict[str, Any]],
    gpus: list[dict[str, Any]],
    resident: list[dict[str, Any]],
) -> LaunchPlan:
    """Decide whether ``model_id`` fits, and what to release if it doesn't.

    ``resident`` lists PolyPal-owned allocations that could be freed:
    ``{"kind": "generator"|"llm", "id": str, "mb": int, "is_target": bool}``.
    """
    estimate = estimate_generation_mb(manifest, params)
    gpu = gpus[0] if gpus else None
    target_loaded = any(r.get("is_target") for r in resident)
    releasable = [r for r in resident if not r.get("is_target")]
    reclaimable = sum(int(r.get("mb") or 0) for r in releasable)

    def make(verdict: str, message: str, unload: Optional[list] = None) -> LaunchPlan:
        return LaunchPlan(
            model_id=model_id, estimate_mb=estimate,
            total_mb=gpu["total_mb"] if gpu else None,
            free_mb=gpu["free_mb"] if gpu else None,
            reclaimable_mb=reclaimable, already_loaded=target_loaded,
            verdict=verdict, unload=unload or [], message=message,
        )

    if gpu is None:
        return make("unknown", "VRAM can't be measured on this GPU; launching without a check.")
    if estimate is None:
        return make("unknown", "This model doesn't declare its VRAM needs.")
    if target_loaded:
        return make("fits", "The model is already loaded on the GPU.")

    free = gpu["free_mb"]
    if estimate <= free * HEADROOM:
        return make("fits", f"Needs ~{estimate / 1024:.1f} GB; {free / 1024:.1f} GB free.")

    # Release the largest PolyPal allocations first until the launch fits.
    to_unload: list[dict[str, Any]] = []
    projected = free
    for item in sorted(releasable, key=lambda r: -(r.get("mb") or 0)):
        if estimate <= projected * HEADROOM:
            break
        to_unload.append(item)
        projected += int(item.get("mb") or 0)
    if to_unload and estimate <= projected * HEADROOM:
        names = ", ".join(i["id"] for i in to_unload)
        return make("fits_after_unload", f"Needs ~{estimate / 1024:.1f} GB; unloading {names} frees enough.", to_unload)
    if estimate <= gpu["total_mb"] * HEADROOM:
        return make(
            "tight",
            f"Needs ~{estimate / 1024:.1f} GB but only {projected / 1024:.1f} GB can be freed — other apps are using VRAM.",
            to_unload,
        )
    return make(
        "exceeds",
        f"Needs ~{estimate / 1024:.1f} GB; this GPU has {gpu['total_mb'] / 1024:.1f} GB. Expect CPU offload or an out-of-memory error.",
        to_unload,
    )


# ---------------------------------------------------------------------------
# Policy & idle reaper
# ---------------------------------------------------------------------------

@dataclass
class GpuPolicy:
    # "auto": free VRAM before a launch that wouldn't fit; "never": leave it.
    unload_before_launch: str = "auto"
    # Unload a 3D generator nobody has used for this long (0 = never).
    idle_unload_minutes: int = 15

    def update(self, **changes: Any) -> "GpuPolicy":
        if changes.get("unload_before_launch") in ("auto", "never"):
            self.unload_before_launch = changes["unload_before_launch"]
        minutes = changes.get("idle_unload_minutes")
        if isinstance(minutes, (int, float)) and not isinstance(minutes, bool):
            self.idle_unload_minutes = max(0, min(int(minutes), 24 * 60))
        return self


policy = GpuPolicy()

_last_used: dict[str, float] = {}
_last_used_lock = threading.Lock()


def touch_generator(model_id: str, now: Optional[float] = None) -> None:
    with _last_used_lock:
        _last_used[model_id] = time.monotonic() if now is None else now


def idle_seconds(model_id: str, now: Optional[float] = None) -> Optional[float]:
    with _last_used_lock:
        last = _last_used.get(model_id)
    if last is None:
        return None
    return (time.monotonic() if now is None else now) - last


class IdleGeneratorReaper:
    """Unloads 3D generators that have sat idle past ``policy.idle_unload_minutes``."""

    def __init__(self, interval: float = 30.0) -> None:
        self.interval = interval
        self._started = False
        self._lock = threading.Lock()

    def start(self, reap: Callable[[], list[str]]) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True

        def loop() -> None:
            while True:
                time.sleep(self.interval)
                try:
                    reap()
                except Exception:  # noqa: BLE001 — a reaper crash must not kill the thread
                    pass

        threading.Thread(target=loop, daemon=True, name="generator-idle-reaper").start()


def idle_generators_to_unload(
    loaded: list[str], busy: set[str], now: Optional[float] = None,
) -> list[str]:
    """Which loaded generators have been idle longer than the policy allows."""
    if policy.idle_unload_minutes <= 0:
        return []
    limit = policy.idle_unload_minutes * 60
    result = []
    for model_id in loaded:
        if model_id in busy:
            continue
        idle = idle_seconds(model_id, now)
        if idle is not None and idle > limit:
            result.append(model_id)
    return result


reaper = IdleGeneratorReaper()
