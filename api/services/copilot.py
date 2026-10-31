"""Copilot safety and plumbing helpers, independent of HTTP.

* Tool risk levels and the approval policy that decides which calls wait for
  the user.
* Argument validation against each tool's JSON schema (types, enums, bounds,
  unknown keys) plus workspace containment for mesh paths.
* ``ThinkFilter`` — separates inline ``<think>…</think>`` reasoning from the
  answer while tokens stream in, even when a tag is split across chunks.
* ``trim_history`` — keeps a long conversation inside the model's context.
"""

from __future__ import annotations

import json
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any, Iterable, Mapping, Optional

# read  — inspects state only, always runs.
# write — creates new files (edits are new mesh versions, so undoable).
# heavy — occupies the GPU or discards loaded state.
TOOL_RISK: dict[str, str] = {
    "list_models": "read",
    "get_mesh_info": "read",
    "get_mesh_stats": "read",
    "get_generation_status": "read",
    "list_workflows": "read",
    "list_mesh_operations": "read",
    "get_provenance": "read",
    "get_gpu_status": "read",
    "load_skill": "read",
    "read_skill_file": "read",
    "decimate_mesh": "write",
    "smooth_mesh": "write",
    "edit_mesh": "write",
    "create_workflow": "write",
    "run_workflow": "heavy",
    "unload_models": "heavy",
    "regenerate_model": "heavy",
}

POLICIES: dict[str, set[str]] = {
    "auto": set(),
    "confirm_heavy": {"heavy"},
    "confirm_all": {"write", "heavy"},
}

MAX_TOOL_CALLS_PER_TURN = 16
MAX_IDENTICAL_CALLS = 2


def risk_of(tool: str) -> str:
    # Unknown tools are treated as the most dangerous kind.
    return TOOL_RISK.get(tool, "heavy")


def needs_approval(tool: str, policy: str) -> bool:
    return risk_of(tool) in POLICIES.get(policy, POLICIES["confirm_heavy"])


class ArgumentError(ValueError):
    pass


def _coerce(name: str, schema: Mapping[str, Any], value: Any) -> Any:
    kind = schema.get("type")
    if kind == "integer":
        if isinstance(value, bool):
            raise ArgumentError(f"'{name}' must be an integer")
        try:
            number = int(float(value)) if isinstance(value, str) else int(value)
        except (TypeError, ValueError) as exc:
            raise ArgumentError(f"'{name}' must be an integer") from exc
        if isinstance(value, float) and value != int(value):
            number = int(round(value))
        value = number
    elif kind == "number":
        if isinstance(value, bool):
            raise ArgumentError(f"'{name}' must be a number")
        try:
            value = float(value)
        except (TypeError, ValueError) as exc:
            raise ArgumentError(f"'{name}' must be a number") from exc
        if value != value or value in (float("inf"), float("-inf")):
            raise ArgumentError(f"'{name}' must be finite")
    elif kind == "string":
        if not isinstance(value, str):
            raise ArgumentError(f"'{name}' must be a string")
        if len(value) > 4000:
            raise ArgumentError(f"'{name}' is too long")
    elif kind == "boolean":
        if isinstance(value, str):
            value = value.strip().lower() in ("true", "1", "yes")
        elif not isinstance(value, bool):
            raise ArgumentError(f"'{name}' must be true or false")
    elif kind == "array":
        if not isinstance(value, list):
            raise ArgumentError(f"'{name}' must be a list")
    elif kind == "object":
        if not isinstance(value, dict):
            raise ArgumentError(f"'{name}' must be an object")

    if "enum" in schema and value not in schema["enum"]:
        raise ArgumentError(f"'{name}' must be one of {', '.join(map(str, schema['enum']))}")
    if kind in ("integer", "number"):
        if schema.get("minimum") is not None and value < schema["minimum"]:
            value = type(value)(schema["minimum"])
        if schema.get("maximum") is not None and value > schema["maximum"]:
            value = type(value)(schema["maximum"])
    return value


def is_workspace_relative(path: str) -> bool:
    """True for a relative path that cannot climb out of the workspace."""
    if not path or "\x00" in path:
        return False
    for flavour in (PurePosixPath, PureWindowsPath):
        candidate = flavour(path)
        if candidate.is_absolute() or candidate.drive or ".." in candidate.parts:
            return False
    return True


def validate_arguments(
    tool: str,
    arguments: Mapping[str, Any],
    schemas: Mapping[str, Mapping[str, Any]],
    context: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Return cleaned arguments or raise ``ArgumentError`` with a model-readable reason."""
    schema = schemas.get(tool)
    if schema is None:
        raise ArgumentError(f"Unknown tool: {tool}")
    properties: Mapping[str, Any] = schema.get("properties") or {}
    clean: dict[str, Any] = {}
    for key, value in (arguments or {}).items():
        if key not in properties or value is None:
            continue  # unknown keys are dropped, never forwarded
        clean[key] = _coerce(key, properties[key], value)
    missing = [k for k in schema.get("required", []) if k not in clean]
    if missing:
        raise ArgumentError(f"Missing required argument(s): {', '.join(missing)}")

    path = clean.get("path")
    if path is not None:
        current = (context or {}).get("currentMeshPath")
        if path != current and not is_workspace_relative(path):
            raise ArgumentError("Mesh paths must be workspace-relative (use get_mesh_info for the current path)")
    return clean


def describe_call(tool: str, arguments: Mapping[str, Any]) -> str:
    """Short human sentence for an approval card."""
    a = arguments
    if tool == "run_workflow":
        return f"Run workflow {a.get('workflow_id')}"
    if tool == "unload_models":
        return "Unload all 3D models and local LLMs from memory"
    if tool == "regenerate_model":
        return "Regenerate the current model with its original settings" + (" and a new seed" if a.get("new_seed") else "")
    if tool == "decimate_mesh":
        return f"Decimate the mesh to {a.get('target_faces'):,} faces" if isinstance(a.get("target_faces"), int) else "Decimate the mesh"
    if tool == "smooth_mesh":
        return f"Smooth the mesh ({a.get('iterations')} iterations)"
    if tool == "edit_mesh":
        if a.get("steps"):
            return "Edit the mesh: " + ", ".join(str(s.get("op")) for s in a["steps"] if isinstance(s, dict))
        return f"Edit the mesh: “{a.get('instruction', '')}”"
    if tool == "create_workflow":
        return f"Create workflow “{a.get('name')}”"
    return tool.replace("_", " ").capitalize()


def call_signature(tool: str, arguments: Mapping[str, Any]) -> str:
    return tool + ":" + json.dumps(arguments, sort_keys=True, default=str)


# ---------------------------------------------------------------------------
# Streaming <think> filter
# ---------------------------------------------------------------------------

class ThinkFilter:
    """Split streamed text into (answer, reasoning) around <think> tags."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self._buffer = ""
        self._inside = False

    def feed(self, text: str) -> tuple[str, str]:
        self._buffer += text
        answer, thinking = [], []
        while self._buffer:
            tag = self.CLOSE if self._inside else self.OPEN
            index = self._buffer.find(tag)
            if index >= 0:
                (thinking if self._inside else answer).append(self._buffer[:index])
                self._buffer = self._buffer[index + len(tag):]
                self._inside = not self._inside
                continue
            # Hold back a possible partial tag at the end of the buffer.
            keep = 0
            for size in range(min(len(tag) - 1, len(self._buffer)), 0, -1):
                if tag.startswith(self._buffer[-size:]):
                    keep = size
                    break
            emit, self._buffer = self._buffer[: len(self._buffer) - keep], self._buffer[len(self._buffer) - keep:]
            (thinking if self._inside else answer).append(emit)
            break
        return "".join(answer), "".join(thinking)

    def flush(self) -> tuple[str, str]:
        rest, self._buffer = self._buffer, ""
        return ("", rest) if self._inside else (rest, "")


# ---------------------------------------------------------------------------
# Context management
# ---------------------------------------------------------------------------

DEFAULT_HISTORY_CHARS = 24_000
KEEP_IMAGES_FOR_LAST = 2


def _content_chars(message: Mapping[str, Any]) -> int:
    content = message.get("content")
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(p.get("text", "")) + (800 if p.get("type") == "image_url" else 0) for p in content)
    return 0


def trim_history(messages: list[dict[str, Any]], max_chars: int = DEFAULT_HISTORY_CHARS) -> tuple[list[dict[str, Any]], int]:
    """Keep the newest messages that fit ``max_chars``; returns (messages, dropped).

    The latest message is always kept. Images are stripped from all but the
    last few user messages, since each costs hundreds of tokens.
    """
    if not messages:
        return [], 0
    with_images = [i for i, m in enumerate(messages) if isinstance(m.get("images"), list) and m["images"]]
    keep_images = set(with_images[-KEEP_IMAGES_FOR_LAST:])
    prepared = []
    for index, message in enumerate(messages):
        if index not in keep_images and message.get("images"):
            message = {**message, "images": [],
                       "content": f"{message.get('content', '')}\n[An earlier image was attached here.]"}
        prepared.append(message)

    kept: list[dict[str, Any]] = []
    total = 0
    for message in reversed(prepared):
        size = _content_chars(message) + 800 * len(message.get("images") or [])
        if kept and total + size > max_chars:
            break
        kept.append(message)
        total += size
    kept.reverse()
    # A conversation must not open on an assistant turn.
    while len(kept) > 1 and kept[0].get("role") != "user":
        kept.pop(0)
    return kept, len(messages) - len(kept)


def summarise_tool_result(text: str, limit: int = 4000) -> str:
    """Cap tool output fed back to the model."""
    return text if len(text) <= limit else text[:limit] + f"\n…[{len(text) - limit} more characters truncated]"


def extract_schemas(tools: Iterable[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    return {t["function"]["name"]: t["function"].get("parameters") or {} for t in tools}
