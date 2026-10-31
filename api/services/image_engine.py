"""Local image generation with stable-diffusion.cpp.

stable-diffusion.cpp is to image models what llama.cpp is to chat models: one
prebuilt executable per platform (CUDA, Vulkan, Metal, CPU) with no Python or
PyTorch install. PolyPal downloads the engine and the model files on demand
into ``<agent dir>/imagegen``, then runs the engine once per picture — the
process exits afterwards, so it never keeps VRAM away from 3D generation.

Text-to-image, editing one picture (img2img) and multi-reference generation
(FLUX Kontext) all go through ``build_command``; models declare which
reference mode they support in ``resources/image_catalog.json``.
"""

from __future__ import annotations

import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.request import Request, urlopen

from services import llm_server

CATALOG_PATH = Path(__file__).resolve().parent.parent / "resources" / "image_catalog.json"
RELEASES_API = "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest"
HF_URL = "https://huggingface.co/{repo}/resolve/main/{file}"
UA = {"User-Agent": "polypal-imagegen"}
MAX_REFERENCES = 5

# Added to prompts used for 3D: image-to-3D models need one clear, whole object.
PROMPT_FOR_3D = (
    "{prompt}, single object, centered, full view, three-quarter view, "
    "soft even studio lighting, plain white background, no text"
)
NEGATIVE_FOR_3D = "multiple objects, cropped, cut off, text, watermark, busy background, scenery, shadow"


def base_dir() -> Path:
    override = os.environ.get("POLYPAL_IMAGEGEN_DIR")
    path = Path(override) if override else llm_server.LLM_DIR / "imagegen"
    path.mkdir(parents=True, exist_ok=True)
    return path


def bin_dir() -> Path:
    return base_dir() / "bin"


def models_dir() -> Path:
    return base_dir() / "models"


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

def load_catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def get_model(model_id: str) -> dict[str, Any]:
    for model in load_catalog()["models"]:
        if model["id"] == model_id:
            return model
    raise KeyError(model_id)


def model_files(model: dict[str, Any]) -> list[tuple[dict[str, Any], Path]]:
    folder = models_dir() / model["id"]
    return [(f, folder / f["file"]) for f in model["files"]]


def is_downloaded(model: dict[str, Any]) -> bool:
    return all(path.is_file() for _, path in model_files(model))


def list_models() -> list[dict[str, Any]]:
    catalog = load_catalog()
    return [{**m, "downloaded": is_downloaded(m), "default": m["id"] == catalog.get("default")} for m in catalog["models"]]


def default_model_id() -> Optional[str]:
    """The catalog default if downloaded, else the first downloaded model."""
    models = list_models()
    ready = [m for m in models if m["downloaded"]]
    if not ready:
        return None
    return next((m["id"] for m in ready if m["default"]), ready[0]["id"])


# ---------------------------------------------------------------------------
# Engine binary
# ---------------------------------------------------------------------------

_BINARY_NAMES = ("sd-cli", "sd")


def binary_path() -> Optional[Path]:
    suffix = ".exe" if sys.platform == "win32" else ""
    for name in _BINARY_NAMES:
        candidate = bin_dir() / f"{name}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def engine_installed() -> bool:
    return binary_path() is not None


def pick_asset(assets: list[dict[str, Any]], platform: str = sys.platform, nvidia: Optional[bool] = None) -> Optional[dict[str, Any]]:
    """The release archive for this machine (CUDA > Vulkan > CPU on Windows)."""
    if nvidia is None:
        nvidia = llm_server.has_nvidia_gpu()

    def matching(*needles: str) -> list[dict[str, Any]]:
        return [a for a in assets if a["name"].endswith(".zip") and all(n in a["name"].lower() for n in needles)]

    if platform == "win32":
        options = (matching("win", "cuda12", "x64") if nvidia else []) + matching("win", "vulkan", "x64") \
            + matching("win", "avx2", "x64") + matching("win", "x64")
    elif platform == "darwin":
        options = matching("darwin", "arm64") + matching("macos", "arm64") + matching("darwin")
    else:
        options = matching("linux", "vulkan") + matching("ubuntu", "x86_64") + matching("linux", "x86_64") + matching("linux")
    options = [a for a in options if "cudart" not in a["name"].lower()]
    return options[0] if options else None


def install_engine(progress: Callable[[dict], None], cancelled: Callable[[], bool] = lambda: False) -> None:
    progress({"status": "Finding the latest image engine…", "percent": 0})
    with urlopen(Request(RELEASES_API, headers=UA), timeout=30) as resp:
        release = json.loads(resp.read())
    asset = pick_asset(release.get("assets", []))
    if asset is None:
        raise RuntimeError("No stable-diffusion.cpp build is published for this platform")
    fd, tmp_name = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        download(asset["browser_download_url"], tmp, progress, cancelled, label="image engine")
        bin_dir().mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tmp) as zf:
            for member in zf.infolist():
                name = Path(member.filename).name
                if member.is_dir() or not name:
                    continue
                keep = name.lower().endswith((".exe", ".dll", ".so", ".dylib", ".metal")) or Path(name).stem in _BINARY_NAMES
                if not keep:
                    continue
                target = bin_dir() / name
                with zf.open(member) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                if sys.platform != "win32" and not name.endswith((".so", ".dylib", ".metal")):
                    target.chmod(0o755)
    finally:
        tmp.unlink(missing_ok=True)
    if not engine_installed():
        raise RuntimeError("The engine archive did not contain the sd executable")
    progress({"status": "done", "percent": 100})


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------

class DownloadCancelled(Exception):
    pass


def download(url: str, dest: Path, progress: Callable[[dict], None], cancelled: Callable[[], bool], label: str) -> None:
    """Resumable download into ``dest`` (via ``dest.part``)."""
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    have = part.stat().st_size if part.exists() else 0
    headers = dict(UA)
    token = os.environ.get("HF_TOKEN")
    if token and "huggingface.co" in url:
        headers["Authorization"] = f"Bearer {token}"
    if have:
        headers["Range"] = f"bytes={have}-"
    with urlopen(Request(url, headers=headers), timeout=60) as resp:
        if have and getattr(resp, "status", 200) != 206:
            have = 0  # server ignored the range; start over
        total = int(resp.headers.get("Content-Length", 0)) + have
        last = 0.0
        with open(part, "ab" if have else "wb") as fh:
            while chunk := resp.read(1 << 20):
                if cancelled():
                    raise DownloadCancelled()
                fh.write(chunk)
                have += len(chunk)
                now = time.monotonic()
                if now - last > 0.5:
                    progress({"status": f"Downloading {label}", "bytesDownloaded": have, "totalBytes": total,
                              "percent": round(have / total * 100) if total else 0})
                    last = now
    os.replace(part, dest)


def download_model(model_id: str, progress: Callable[[dict], None], cancelled: Callable[[], bool] = lambda: False) -> None:
    model = get_model(model_id)
    files = model_files(model)
    for index, (spec, path) in enumerate(files):
        if path.is_file():
            continue
        label = f"{model['name']} ({index + 1}/{len(files)}: {spec['file']})"
        download(HF_URL.format(repo=spec["repo"], file=spec["file"]), path, progress, cancelled, label)
    progress({"status": "done", "percent": 100})


def delete_model(model_id: str) -> bool:
    folder = models_dir() / get_model(model_id)["id"]
    if not folder.exists():
        return False
    shutil.rmtree(folder)
    return True


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

@dataclass
class ImageRequest:
    prompt: str
    model_id: str
    negative: str = ""
    references: list[Path] = field(default_factory=list)
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    strength: float = 0.6
    purpose: str = "image"  # "image" | "3d"


_help_cache: dict[str, str] = {}


def _engine_help(binary: Path) -> str:
    key = str(binary)
    if key not in _help_cache:
        try:
            out = subprocess.run([str(binary), "--help"], capture_output=True, text=True, timeout=30)
            _help_cache[key] = (out.stdout or "") + (out.stderr or "")
        except (OSError, subprocess.SubprocessError):
            _help_cache[key] = ""
    return _help_cache[key]


def build_command(binary: Path, request: ImageRequest, output: Path) -> list[str]:
    model = get_model(request.model_id)
    files = {spec["role"]: path for spec, path in model_files(model)}
    size = model.get("resolution", 512)
    width = int(request.width or size)
    height = int(request.height or size)
    prompt = request.prompt.strip()
    negative = request.negative.strip()
    if request.purpose == "3d":
        prompt = PROMPT_FOR_3D.format(prompt=prompt)
        negative = ", ".join(filter(None, [negative, NEGATIVE_FOR_3D]))

    cmd = [str(binary)]
    if "model" in files:
        cmd += ["-m", str(files["model"])]
    for role, flag in (("diffusion-model", "--diffusion-model"), ("vae", "--vae"), ("clip_l", "--clip_l"), ("t5xxl", "--t5xxl")):
        if role in files:
            cmd += [flag, str(files[role])]
    cmd += ["-p", prompt, "-W", str(width), "-H", str(height),
            "--steps", str(int(request.steps or model.get("steps", 20))),
            "--cfg-scale", str(model.get("cfg", 7.0)),
            "--sampling-method", model.get("sampler", "euler_a"),
            "-s", str(request.seed if request.seed is not None else random.randint(0, 2**31 - 1)),
            "-o", str(output)]
    if negative and model.get("cfg", 7.0) > 1.0:
        cmd += ["-n", negative]
    if model.get("guidance") is not None:
        cmd += ["--guidance", str(model["guidance"])]

    references = request.references[:MAX_REFERENCES]
    if references:
        if model.get("references") == "multi":
            for ref in references:
                cmd += ["-r", str(ref)]
        else:
            # Single-picture models edit the first reference (img2img).
            # Older engine builds need an explicit mode; newer ones infer it.
            if re.search(r"\bimg2img\b", _engine_help(binary)) and "img_gen" not in _engine_help(binary):
                cmd += ["-M", "img2img"]
            cmd += ["-i", str(references[0]), "--strength", str(max(0.05, min(request.strength, 0.95)))]
    if model.get("vram_gb", 0) >= 10:
        cmd.append("--vae-tiling")  # keeps decode memory down on large models
    return cmd


_PROGRESS = re.compile(r"(\d+)\s*/\s*(\d+)")


def run(request: ImageRequest, output: Path, progress: Callable[[int, str], None],
        cancel: Optional[threading.Event] = None) -> Path:
    binary = binary_path()
    if binary is None:
        raise RuntimeError("The image engine is not installed yet")
    model = get_model(request.model_id)
    if not is_downloaded(model):
        raise RuntimeError(f"{model['name']} is not downloaded yet")
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = build_command(binary, request, output)
    progress(2, f"Starting {model['name']}…")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", bufsize=1, cwd=str(bin_dir()))
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        if cancel is not None and cancel.is_set():
            proc.kill()
            raise RuntimeError("Cancelled")
        line = line.strip()
        if not line:
            continue
        tail = (tail + [line])[-12:]
        if "sampling" in line.lower() or "|" in line:
            match = _PROGRESS.search(line)
            if match and int(match.group(2)) > 0:
                done, total = int(match.group(1)), int(match.group(2))
                progress(5 + int(90 * done / total), f"Drawing… step {done}/{total}")
        elif "decod" in line.lower():
            progress(96, "Finishing…")
        elif "load" in line.lower():
            progress(3, "Loading the image model…")
    code = proc.wait()
    if code != 0 or not output.is_file():
        raise RuntimeError("Image generation failed:\n" + "\n".join(tail[-8:]))
    progress(100, "Done")
    return output
