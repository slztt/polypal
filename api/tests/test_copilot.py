import os
import tempfile

# Keep the copilot's skills folder out of the real agent directory.
os.environ.setdefault("POLYPAL_SKILLS_DIR", tempfile.mkdtemp(prefix="polypal-skills-test-"))

import asyncio
import json
import os
import tempfile
import unittest
from unittest import mock

import httpx

import routers.agent as agent
from services import conversations, copilot


def _assistant(content: str = "", tool_calls=None) -> dict:
    msg: dict = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg}]}


def _call(name: str, arguments: dict, call_id: str = "c1") -> dict:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


def _sse(*chunks) -> bytes:
    lines = [f"data: {json.dumps(c)}\n\n" for c in chunks] + ["data: [DONE]\n\n"]
    return "".join(lines).encode()


class _Server:
    """Scripted provider + PolyPal API on one MockTransport."""

    def __init__(self, chat, api=None) -> None:
        self.chat = list(chat)
        self.api = api or {}
        self.requests: list[dict] = []
        self.api_calls: list[str] = []
        self._real = httpx.AsyncClient

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            self.requests.append(json.loads(request.content))
            item = self.chat.pop(0)
            if isinstance(item, bytes):
                return httpx.Response(200, content=item, headers={"content-type": "text/event-stream"})
            return httpx.Response(200, json=item)
        self.api_calls.append(f"{request.method} {request.url.path}")
        responder = self.api.get(request.url.path)
        if responder is None:
            return httpx.Response(404, json={"detail": "nope"})
        return responder(request)

    def client(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self.handler)
        return self._real(*args, **kwargs)


def _external(messages=None, **kwargs) -> agent.AgentChatRequest:
    return agent.AgentChatRequest(
        messages=messages or [agent.ChatMessage(role="user", content="hi")],
        model="m",
        provider=agent.ProviderConfig(type="external", base_url="https://llm.test/v1", api_key="k"),
        **kwargs,
    )


def _events(server: _Server, request, stream=True) -> list[dict]:
    async def collect():
        return [e async for e in agent._agent_events(request, stream=stream)]
    with mock.patch.object(agent.httpx, "AsyncClient", server.client):
        return asyncio.run(collect())


class StreamingTests(unittest.TestCase):
    def test_tokens_reasoning_and_tool_calls_stream(self) -> None:
        stream_round = _sse(
            {"choices": [{"delta": {"content": "<thi"}}]},
            {"choices": [{"delta": {"content": "nk>plan it</think>Checking"}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "get_mesh_info", "arguments": ""}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{}"}}]}}]},
        )
        final_round = _sse({"choices": [{"delta": {"content": "It has "}}]}, {"choices": [{"delta": {"content": "12 faces."}}]})
        server = _Server([stream_round, final_round])
        events = _events(server, _external(context={"currentMeshPath": "Default/a.glb", "meshTriangles": 12}))

        kinds = [e["type"] for e in events]
        self.assertEqual(kinds[0], "start")
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "token"), "CheckingIt has 12 faces.")
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "thinking"), "plan it")
        call = next(e for e in events if e["type"] == "tool_call")
        self.assertEqual((call["tool"], call["call_id"]), ("get_mesh_info", "t1"))
        result = next(e for e in events if e["type"] == "tool_result")["action"]
        self.assertEqual(result["status"], "ok")
        self.assertIn("Default/a.glb", result["result"])
        done = events[-1]
        self.assertEqual(done["type"], "done")
        self.assertEqual(done["message"], "Checking\n\nIt has 12 faces.")
        self.assertTrue(server.requests[0]["stream"])
        self.assertEqual(server.requests[1]["messages"][-1]["tool_call_id"], "t1")

    def test_stream_endpoint_emits_sse(self) -> None:
        server = _Server([_sse({"choices": [{"delta": {"content": "ok"}}]})])

        async def read():
            response = await agent.agent_chat_stream(_external())
            return b"".join([chunk.encode() if isinstance(chunk, str) else chunk async for chunk in response.body_iterator])

        with mock.patch.object(agent.httpx, "AsyncClient", server.client):
            body = asyncio.run(read()).decode()
        payloads = [json.loads(line[6:]) for line in body.split("\n\n") if line.startswith("data: ")]
        self.assertEqual(payloads[-1]["type"], "done")
        self.assertEqual(payloads[-1]["message"], "ok")

    def test_provider_ignoring_stream_flag_still_works(self) -> None:
        server = _Server([_assistant(content="plain json")])
        events = _events(server, _external())
        self.assertEqual(events[-1]["message"], "plain json")


class SafetyTests(unittest.TestCase):
    def test_heavy_tools_wait_for_approval_under_confirm_policy(self) -> None:
        server = _Server([
            _assistant(tool_calls=[_call("unload_models", {})]),
            _assistant(content="I'd like to unload the models — approve to continue."),
        ])
        events = _events(server, _external(tool_policy="confirm_heavy"))
        action = next(e for e in events if e["type"] == "tool_result")["action"]
        self.assertEqual(action["status"], "pending")
        self.assertEqual(action["payload"]["type"], "confirmation_required")
        self.assertEqual(action["payload"]["risk"], "heavy")
        self.assertNotIn("POST /model/unload-all", server.api_calls)

    def test_read_tools_run_even_under_strictest_policy(self) -> None:
        server = _Server([_assistant(tool_calls=[_call("get_mesh_info", {})]), _assistant(content="done")])
        events = _events(server, _external(tool_policy="confirm_all"))
        self.assertEqual(next(e for e in events if e["type"] == "tool_result")["action"]["status"], "ok")

    def test_invalid_arguments_are_reported_not_executed(self) -> None:
        server = _Server([
            _assistant(tool_calls=[_call("decimate_mesh", {"path": "../../secret.glb", "target_faces": 10})]),
            _assistant(content="sorry"),
        ])
        events = _events(server, _external())
        action = next(e for e in events if e["type"] == "tool_result")["action"]
        self.assertEqual(action["status"], "error")
        self.assertIn("workspace-relative", action["result"])
        self.assertEqual(server.api_calls, [])

    def test_identical_call_loops_are_cut_off(self) -> None:
        loop = [_assistant(tool_calls=[_call("list_models", {}, f"c{i}")]) for i in range(4)]
        server = _Server(loop + [_assistant(content="fine")], api={
            "/model/all": lambda r: httpx.Response(200, json=[]),
        })
        events = _events(server, _external())
        statuses = [e["action"]["status"] for e in events if e["type"] == "tool_result"]
        self.assertEqual(statuses, ["ok", "ok", "skipped", "skipped"])

    def test_approved_tool_executes_with_revalidation(self) -> None:
        server = _Server([], api={"/model/unload-all": lambda r: httpx.Response(200, json={"unloaded": True})})
        with mock.patch.object(agent.httpx, "AsyncClient", server.client):
            ok = asyncio.run(agent.execute_approved_tool(agent.ExecuteToolRequest(name="unload_models")))
            bad = asyncio.run(agent.execute_approved_tool(agent.ExecuteToolRequest(name="smooth_mesh", arguments={"path": "/etc/x"})))
        self.assertEqual(ok.status, "ok")
        self.assertEqual(bad.status, "error")

    def test_edit_mesh_tool_plans_and_applies(self) -> None:
        def plan(request):
            return httpx.Response(200, json={"steps": [{"op": "smooth", "params": {"iterations": 2}}]})

        def apply(request):
            body = json.loads(request.content)
            self.assertEqual(body["path"], "Default/a.glb")
            self.assertEqual(body["source"], "copilot")
            return httpx.Response(200, json={"url": "/workspace/Default/a_edit.glb", "summary": "Smooth (2 passes).", "stats": {"faces": 900}})

        server = _Server([], api={"/edit/plan": plan, "/edit/apply": apply})
        with mock.patch.object(agent.httpx, "AsyncClient", server.client):
            text, payload = asyncio.run(agent.execute_tool("edit_mesh", {"instruction": "smooth a bit"}, {"currentMeshPath": "Default/a.glb"}))
        self.assertEqual(payload["type"], "mesh_update")
        self.assertEqual(payload["url"], "/workspace/Default/a_edit.glb")
        self.assertIn("900", text)


class HelperTests(unittest.TestCase):
    def test_validation_coerces_clamps_and_drops(self) -> None:
        schemas = agent.TOOL_SCHEMAS
        clean = copilot.validate_arguments("decimate_mesh", {"path": "a/b.glb", "target_faces": "5", "x": 1}, schemas)
        self.assertEqual(clean, {"path": "a/b.glb", "target_faces": 100})
        with self.assertRaises(copilot.ArgumentError):
            copilot.validate_arguments("decimate_mesh", {"path": "a.glb"}, schemas)
        with self.assertRaises(copilot.ArgumentError):
            copilot.validate_arguments("create_workflow", {"name": "x", "input_type": "video", "steps": []}, schemas)
        # The exact current-mesh path is allowed even if it is not relative.
        ctx = {"currentMeshPath": "/optimize/serve-file?path=/tmp/a.glb"}
        copilot.validate_arguments("smooth_mesh", {"path": ctx["currentMeshPath"], "iterations": 3}, schemas, ctx)
        self.assertFalse(copilot.is_workspace_relative("C:\\Windows\\x.glb"))
        self.assertFalse(copilot.is_workspace_relative("a/../../b"))
        self.assertTrue(copilot.is_workspace_relative("Default/cat.glb"))

    def test_policies(self) -> None:
        self.assertFalse(copilot.needs_approval("edit_mesh", "auto"))
        self.assertFalse(copilot.needs_approval("edit_mesh", "confirm_heavy"))
        self.assertTrue(copilot.needs_approval("edit_mesh", "confirm_all"))
        self.assertTrue(copilot.needs_approval("run_workflow", "confirm_heavy"))
        self.assertTrue(copilot.needs_approval("made_up_tool", "confirm_heavy"))
        self.assertTrue(set(copilot.TOOL_RISK) >= {t["function"]["name"] for t in agent.TOOLS})

    def test_think_filter_handles_split_tags(self) -> None:
        f = copilot.ThinkFilter()
        out = [f.feed(chunk) for chunk in ["Hi <", "think", ">secret</th", "ink> there"]]
        answer = "".join(a for a, _ in out) + f.flush()[0]
        thinking = "".join(t for _, t in out)
        self.assertEqual(answer, "Hi  there")
        self.assertEqual(thinking, "secret")

    def test_trim_history_keeps_newest_and_starts_on_user(self) -> None:
        msgs = []
        for i in range(10):
            msgs.append({"role": "user", "content": f"q{i} " + "x" * 100, "images": ["data:a"] if i < 9 else []})
            msgs.append({"role": "assistant", "content": f"a{i} " + "y" * 100})
        kept, dropped = copilot.trim_history(msgs, max_chars=700)
        self.assertGreater(dropped, 0)
        self.assertEqual(kept[0]["role"], "user")
        self.assertEqual(kept[-1]["content"][:2], "a9")
        images = [m for m in kept if m.get("images")]
        self.assertLessEqual(len(images), copilot.KEEP_IMAGES_FOR_LAST)


class ConversationStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._env = mock.patch.dict(os.environ, {"POLYPAL_CONVERSATIONS_DIR": self._tmp.name})
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def test_lifecycle(self) -> None:
        created = conversations.create()
        saved = conversations.save(created["id"], [
            {"role": "user", "content": "Make the dragon print ready at 15 cm please, and smooth it"},
            {"role": "assistant", "content": "Done."},
        ])
        self.assertTrue(saved["title"].startswith("Make the dragon"))
        self.assertLessEqual(len(saved["title"]), conversations.TITLE_LENGTH)
        listed = conversations.list_all()
        self.assertEqual(listed[0]["message_count"], 2)
        self.assertEqual(listed[0]["preview"], "Done.")

        conversations.rename(created["id"], "Dragon")
        conversations.save(created["id"], [{"role": "user", "content": "other"}])
        self.assertEqual(conversations.load(created["id"])["title"], "Dragon")  # renamed titles stick
        self.assertTrue(conversations.delete(created["id"]))
        self.assertFalse(conversations.delete(created["id"]))

    def test_ids_cannot_traverse(self) -> None:
        with self.assertRaises(conversations.ConversationError):
            conversations.load("../../etc/passwd")

    def test_routes(self) -> None:
        from fastapi import HTTPException

        created = asyncio.run(agent.create_conversation())
        asyncio.run(agent.save_conversation(created["id"], agent.ConversationSave(messages=[{"role": "user", "content": "hello"}])))
        loaded = asyncio.run(agent.get_conversation(created["id"]))
        self.assertEqual(loaded["messages"][0]["content"], "hello")
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(agent.get_conversation("0" * 32))
        self.assertEqual(ctx.exception.status_code, 404)
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(agent.get_conversation("bad-id"))
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
