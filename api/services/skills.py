"""Skills: reusable instructions the copilot follows, in the Claude Skills format.

A skill is a folder containing ``SKILL.md``::

    ---
    name: print-ready
    description: Prepare models for 3D printing. Use when the user mentions printing, slicers or STL.
    ---
    # Print-ready models
    1. Remove floating pieces …

plus any supporting files (checklists, examples) next to it.

Like Claude's skills they load progressively: the copilot always sees each
enabled skill's ``name`` and ``description``; it reads the full ``SKILL.md``
(``load_skill``) only when the task matches, and supporting files
(``read_skill_file``) only when the instructions point to them.

Skills live in ``<agent dir>/skills/<name>/``. A few built-in ones are copied
there on first use and can be edited or disabled like any other.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Optional
from urllib.request import Request, urlopen

from services import llm_server

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_DESCRIPTION = 1024
MAX_SKILL_MD = 64 * 1024
MAX_FILE_READ = 128 * 1024
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
BUILTIN_DIR = Path(__file__).resolve().parent.parent / "resources" / "skills"
_GITHUB = re.compile(r"^https://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.+))?)?/?$")


class SkillError(ValueError):
    pass


def storage_dir() -> Path:
    override = os.environ.get("POLYPAL_SKILLS_DIR")
    path = Path(override) if override else llm_server.LLM_DIR / "skills"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _state_path() -> Path:
    return storage_dir() / ".state.json"


def _load_state() -> dict[str, Any]:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return data if isinstance(data, dict) else {}


def _save_state(state: dict[str, Any]) -> None:
    tmp = _state_path().with_name(".state.json.tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(tmp, _state_path())


# ---------------------------------------------------------------------------
# SKILL.md parsing
# ---------------------------------------------------------------------------

def parse_skill_md(text: str) -> tuple[dict[str, str], str]:
    """Split front matter from the body. Supports the simple ``key: value``
    YAML that SKILL.md uses (quoted values and ``>``/``|`` blocks included)."""
    if not text.startswith("---"):
        raise SkillError("SKILL.md must start with a front matter block (---)")
    match = re.match(r"^---\s*\n(.*?)\n---\s*(?:\n|$)(.*)$", text, re.S)
    if not match:
        raise SkillError("SKILL.md front matter is not closed with ---")
    meta: dict[str, str] = {}
    lines = match.group(1).splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        kv = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
        i += 1
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        if value in (">", "|", ">-", "|-"):
            block = []
            while i < len(lines) and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            value = (" " if value.startswith(">") else "\n").join(b for b in block if b)
        elif len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        meta[key] = value
    return meta, match.group(2).strip()


def validate(meta: dict[str, str], folder_name: Optional[str] = None) -> tuple[str, str]:
    name = (meta.get("name") or "").strip()
    description = " ".join((meta.get("description") or "").split())
    if not NAME_RE.fullmatch(name):
        raise SkillError("Skill name must be lowercase letters, digits and hyphens (max 64)")
    if not description:
        raise SkillError("Skill description is required — it tells the copilot when to use the skill")
    if len(description) > MAX_DESCRIPTION:
        raise SkillError(f"Skill description must be at most {MAX_DESCRIPTION} characters")
    if folder_name is not None and folder_name != name:
        raise SkillError(f"Folder name '{folder_name}' must match the skill name '{name}'")
    return name, description


def _read_skill(folder: Path) -> Optional[dict[str, Any]]:
    md = folder / "SKILL.md"
    try:
        text = md.read_text(encoding="utf-8")
        meta, body = parse_skill_md(text)
        name, description = validate(meta, folder.name)
    except (OSError, UnicodeDecodeError, SkillError) as exc:
        return {"name": folder.name, "description": "", "valid": False, "error": str(exc), "files": []}
    files = sorted(
        p.relative_to(folder).as_posix()
        for p in folder.rglob("*")
        if p.is_file() and p.name != "SKILL.md" and not any(part.startswith(".") for part in p.relative_to(folder).parts)
    )
    return {"name": name, "description": description, "valid": True, "error": None, "body": body, "files": files,
            "license": meta.get("license"), "updated_at": datetime.fromtimestamp(md.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")}


# ---------------------------------------------------------------------------
# Listing and state
# ---------------------------------------------------------------------------

def seed_builtins() -> None:
    """Copy built-in skills in once; a user who deletes one doesn't get it back."""
    state = _load_state()
    seeded = set(state.get("_seeded", []))
    if not BUILTIN_DIR.is_dir():
        return
    changed = False
    for src in BUILTIN_DIR.iterdir():
        if not (src / "SKILL.md").is_file() or src.name in seeded:
            continue
        dest = storage_dir() / src.name
        if not dest.exists():
            shutil.copytree(src, dest)
            state.setdefault(src.name, {})["source"] = "built-in"
        seeded.add(src.name)
        changed = True
    if changed:
        state["_seeded"] = sorted(seeded)
        _save_state(state)


def list_skills() -> list[dict[str, Any]]:
    seed_builtins()
    state = _load_state()
    skills = []
    for folder in sorted(storage_dir().iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        info = _read_skill(folder)
        if info is None:
            continue
        meta = state.get(folder.name, {})
        info.pop("body", None)
        info["enabled"] = bool(meta.get("enabled", True)) and info["valid"]
        info["source"] = meta.get("source", "local")
        skills.append(info)
    return skills


def enabled_skills() -> list[dict[str, Any]]:
    return [s for s in list_skills() if s["enabled"]]


def get_skill(name: str) -> dict[str, Any]:
    folder = _folder(name)
    info = _read_skill(folder)
    if info is None or not folder.is_dir():
        raise KeyError(name)
    info["content"] = (folder / "SKILL.md").read_text(encoding="utf-8") if (folder / "SKILL.md").is_file() else ""
    meta = _load_state().get(name, {})
    info["enabled"] = bool(meta.get("enabled", True)) and info["valid"]
    info["source"] = meta.get("source", "local")
    return info


def _folder(name: str) -> Path:
    if not NAME_RE.fullmatch(name or ""):
        raise SkillError("Invalid skill name")
    return storage_dir() / name


def set_enabled(name: str, enabled: bool) -> dict[str, Any]:
    if not _folder(name).is_dir():
        raise KeyError(name)
    state = _load_state()
    state.setdefault(name, {})["enabled"] = bool(enabled)
    _save_state(state)
    return get_skill(name)


def delete_skill(name: str) -> bool:
    folder = _folder(name)
    if not folder.is_dir():
        return False
    shutil.rmtree(folder)
    state = _load_state()
    state.pop(name, None)
    _save_state(state)
    return True


# ---------------------------------------------------------------------------
# Creating and installing
# ---------------------------------------------------------------------------

def save_skill(content: str, original_name: Optional[str] = None) -> dict[str, Any]:
    """Create or replace a skill from SKILL.md text (renames move the folder)."""
    if len(content.encode("utf-8")) > MAX_SKILL_MD:
        raise SkillError("SKILL.md is too large (64 KB max)")
    meta, _ = parse_skill_md(content)
    name, _ = validate(meta)
    target = _folder(name)
    if original_name and original_name != name:
        source = _folder(original_name)
        if target.exists():
            raise SkillError(f"A skill named '{name}' already exists")
        if source.is_dir():
            source.rename(target)
            state = _load_state()
            if original_name in state:
                state[name] = state.pop(original_name)
                _save_state(state)
    target.mkdir(parents=True, exist_ok=True)
    tmp = target / ".SKILL.md.tmp"
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, target / "SKILL.md")
    return get_skill(name)


def _install_folder(src: Path, source: str) -> str:
    meta, _ = parse_skill_md((src / "SKILL.md").read_text(encoding="utf-8"))
    name, _ = validate(meta)
    dest = _folder(name)
    staging = Path(tempfile.mkdtemp(dir=storage_dir(), prefix=".install-"))
    try:
        shutil.copytree(src, staging / name, ignore=shutil.ignore_patterns(".git", "__pycache__", ".*"))
        if dest.exists():
            shutil.rmtree(dest)
        (staging / name).rename(dest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    state = _load_state()
    state.setdefault(name, {}).update(source=source, enabled=True)
    _save_state(state)
    return name


def install_from_folder(path: str, source: Optional[str] = None) -> list[str]:
    """Install a skill folder, or every skill folder found inside ``path``."""
    root = Path(path).expanduser()
    if not root.is_dir():
        raise SkillError("Folder not found")
    candidates = [root] if (root / "SKILL.md").is_file() else [p.parent for p in root.rglob("SKILL.md")]
    if not candidates:
        raise SkillError("No SKILL.md found in that folder")
    return [_install_folder(c, source or f"folder:{root}") for c in candidates[:50]]


def install_from_archive(data: bytes, source: str, subpath: Optional[str] = None) -> list[str]:
    if len(data) > MAX_ARCHIVE_BYTES:
        raise SkillError("Archive is too large (20 MB max)")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp).resolve()
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                total = 0
                for member in zf.infolist():
                    target = (tmp_root / member.filename).resolve()
                    if tmp_root not in target.parents and target != tmp_root:
                        raise SkillError("Archive contains unsafe paths")
                    total += member.file_size
                    if total > MAX_ARCHIVE_BYTES * 3:
                        raise SkillError("Archive expands to more than 60 MB")
                zf.extractall(tmp_root)
        except zipfile.BadZipFile as exc:
            raise SkillError("Not a valid zip archive") from exc
        search = tmp_root
        if subpath:
            matches = [p for p in tmp_root.glob(f"*/{subpath}") if p.is_dir()]
            if not matches:
                raise SkillError(f"Path '{subpath}' not found in the repository")
            search = matches[0]
        return install_from_folder(str(search), source)


def parse_github_url(url: str) -> tuple[str, str, str, Optional[str]]:
    match = _GITHUB.match(url.strip())
    if not match:
        raise SkillError("Use a GitHub URL like https://github.com/owner/repo or …/tree/main/skills/my-skill")
    owner, repo, ref, subpath = match.groups()
    return owner, repo, ref or "HEAD", subpath


def install_from_github(url: str, fetch: Optional[Callable[[str], bytes]] = None) -> list[str]:
    owner, repo, ref, subpath = parse_github_url(url)
    archive_url = f"https://codeload.github.com/{owner}/{repo}/zip/{ref}"

    def _fetch(target: str) -> bytes:
        with urlopen(Request(target, headers={"User-Agent": "polypal-skills"}), timeout=60) as resp:
            data = resp.read(MAX_ARCHIVE_BYTES + 1)
        return data

    data = (fetch or _fetch)(archive_url)
    return install_from_archive(data, f"github:{owner}/{repo}", subpath)


# ---------------------------------------------------------------------------
# Copilot access (progressive disclosure)
# ---------------------------------------------------------------------------

def prompt_section() -> str:
    skills = enabled_skills()
    if not skills:
        return ""
    lines = "\n".join(f"- **{s['name']}** — {s['description']}" for s in skills)
    return (
        "## Skills\n"
        "Skills are instructions the user installed. When a request matches a skill's description, "
        "call load_skill(name) first and follow its instructions; open its supporting files with "
        "read_skill_file only when the instructions refer to them.\n" + lines
    )


def load_for_agent(name: str) -> str:
    info = get_skill(name)
    if not info["enabled"]:
        raise SkillError(f"Skill '{name}' is disabled")
    files = "\n".join(f"- {f}" for f in info["files"]) or "(none)"
    return f"# Skill: {info['name']}\n\n{info['body']}\n\nSupporting files:\n{files}"


def read_file_for_agent(name: str, rel_path: str) -> str:
    folder = _folder(name)
    if not _load_state().get(name, {}).get("enabled", True):
        raise SkillError(f"Skill '{name}' is disabled")
    rel = PurePosixPath(rel_path.replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts:
        raise SkillError("File path must stay inside the skill folder")
    target = (folder / rel).resolve()
    if folder.resolve() not in target.parents or not target.is_file():
        raise SkillError(f"No file '{rel_path}' in skill '{name}'")
    data = target.read_bytes()[:MAX_FILE_READ]
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SkillError("Only text files can be read") from exc
