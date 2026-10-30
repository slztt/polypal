"""Persistent copilot conversations.

Stored as one JSON file per conversation under the agent directory
(``POLYPAL_LLM_DIR/conversations`` — the app's userData, not the workspace),
so chats survive restarts and workspace moves. Writes are atomic.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from services import llm_server

MAX_BYTES = 20 * 1024 * 1024
MAX_MESSAGES = 2000
TITLE_LENGTH = 60
_ID = re.compile(r"^[a-f0-9]{32}$")


class ConversationError(ValueError):
    pass


def storage_dir() -> Path:
    override = os.environ.get("POLYPAL_CONVERSATIONS_DIR")
    path = Path(override) if override else llm_server.LLM_DIR / "conversations"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _path(conversation_id: str) -> Path:
    if not _ID.fullmatch(conversation_id or ""):
        raise ConversationError("Invalid conversation id")
    return storage_dir() / f"{conversation_id}.json"


def default_title(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") == "user" and str(message.get("content", "")).strip():
            text = " ".join(str(message["content"]).split())
            return text if len(text) <= TITLE_LENGTH else text[: TITLE_LENGTH - 1].rstrip() + "…"
    return "New conversation"


def _write(path: Path, data: dict[str, Any]) -> None:
    encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_BYTES:
        raise ConversationError("Conversation is too large to save; start a new one")
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(encoded)
    os.replace(tmp, path)


def create(title: Optional[str] = None) -> dict[str, Any]:
    conversation_id = uuid.uuid4().hex
    now = _now()
    data = {"id": conversation_id, "title": title or "New conversation", "title_locked": bool(title),
            "created_at": now, "updated_at": now, "messages": []}
    _write(_path(conversation_id), data)
    return data


def load(conversation_id: str) -> dict[str, Any]:
    path = _path(conversation_id)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise KeyError(conversation_id) from exc


def save(conversation_id: str, messages: list[dict[str, Any]], title: Optional[str] = None) -> dict[str, Any]:
    if not isinstance(messages, list) or len(messages) > MAX_MESSAGES:
        raise ConversationError(f"A conversation holds at most {MAX_MESSAGES} messages")
    try:
        data = load(conversation_id)
    except KeyError:
        data = {"id": conversation_id, "created_at": _now(), "title_locked": False}
    data["messages"] = messages
    if title:
        data["title"], data["title_locked"] = title, True
    elif not data.get("title_locked"):
        data["title"] = default_title(messages)
    data["updated_at"] = _now()
    _write(_path(conversation_id), data)
    return data


def rename(conversation_id: str, title: str) -> dict[str, Any]:
    data = load(conversation_id)
    data["title"] = title.strip()[:120] or data.get("title") or "New conversation"
    data["title_locked"] = True
    data["updated_at"] = _now()
    _write(_path(conversation_id), data)
    return data


def delete(conversation_id: str) -> bool:
    try:
        _path(conversation_id).unlink()
        return True
    except FileNotFoundError:
        return False


def list_all() -> list[dict[str, Any]]:
    summaries = []
    for path in storage_dir().glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        messages = data.get("messages") or []
        last = next((m for m in reversed(messages) if m.get("role") in ("user", "assistant")), None)
        summaries.append({
            "id": data.get("id", path.stem),
            "title": data.get("title") or "New conversation",
            "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
            "message_count": len(messages),
            "preview": " ".join(str((last or {}).get("content", "")).split())[:120],
        })
    summaries.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    return summaries
