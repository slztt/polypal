import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from services import skills

SKILL = """---
name: tidy-up
description: >
  Clean meshes before export.
  Use when the user says tidy.
license: MIT
---
# Tidy up
Remove floaters, then see notes.md.
"""


class SkillsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._env = mock.patch.dict(os.environ, {"POLYPAL_SKILLS_DIR": self._tmp.name})
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def test_front_matter_parsing_and_validation(self) -> None:
        meta, body = skills.parse_skill_md(SKILL)
        self.assertEqual(meta["description"], "Clean meshes before export. Use when the user says tidy.")
        self.assertEqual(meta["license"], "MIT")
        self.assertTrue(body.startswith("# Tidy up"))
        for bad in ("no front matter", "---\nname: x\n", "---\nname: Bad Name\ndescription: d\n---\n", "---\nname: ok\n---\n"):
            with self.assertRaises(skills.SkillError):
                skills.validate(skills.parse_skill_md(bad)[0])

    def test_builtins_are_seeded_once(self) -> None:
        names = {s["name"] for s in skills.list_skills()}
        self.assertTrue({"print-ready", "game-ready-asset", "describe-for-3d"} <= names)
        skills.delete_skill("print-ready")
        self.assertNotIn("print-ready", {s["name"] for s in skills.list_skills()})

    def test_create_rename_toggle_and_agent_access(self) -> None:
        skills.save_skill(SKILL)
        (Path(self._tmp.name) / "tidy-up" / "notes.md").write_text("tips")
        info = skills.get_skill("tidy-up")
        self.assertEqual(info["files"], ["notes.md"])
        self.assertIn("**tidy-up**", skills.prompt_section())
        self.assertIn("Remove floaters", skills.load_for_agent("tidy-up"))
        self.assertEqual(skills.read_file_for_agent("tidy-up", "notes.md"), "tips")
        with self.assertRaises(skills.SkillError):
            skills.read_file_for_agent("tidy-up", "../.state.json")

        skills.set_enabled("tidy-up", False)
        self.assertNotIn("tidy-up", skills.prompt_section())
        with self.assertRaises(skills.SkillError):
            skills.load_for_agent("tidy-up")

        renamed = skills.save_skill(SKILL.replace("name: tidy-up", "name: clean-up"), original_name="tidy-up")
        self.assertEqual(renamed["name"], "clean-up")
        self.assertFalse(renamed["enabled"])  # state moves with the rename
        self.assertTrue((Path(self._tmp.name) / "clean-up" / "notes.md").is_file())

    def test_install_from_github_archive_with_subpath(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("repo-main/README.md", "x")
            zf.writestr("repo-main/skills/tidy-up/SKILL.md", SKILL)
            zf.writestr("repo-main/skills/tidy-up/notes.md", "tips")
            zf.writestr("repo-main/skills/other/SKILL.md", SKILL.replace("tidy-up", "other"))
        fetched = []
        names = skills.install_from_github(
            "https://github.com/acme/repo/tree/main/skills/tidy-up",
            fetch=lambda url: fetched.append(url) or buf.getvalue(),
        )
        self.assertEqual(names, ["tidy-up"])
        self.assertEqual(fetched, ["https://codeload.github.com/acme/repo/zip/main"])
        self.assertEqual(skills.get_skill("tidy-up")["source"], "github:acme/repo")
        all_names = skills.install_from_github("https://github.com/acme/repo", fetch=lambda url: buf.getvalue())
        self.assertEqual(sorted(all_names), ["other", "tidy-up"])

    def test_rejects_unsafe_archives_and_urls(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("../evil/SKILL.md", SKILL)
        with self.assertRaises(skills.SkillError):
            skills.install_from_archive(buf.getvalue(), "test")
        with self.assertRaises(skills.SkillError):
            skills.parse_github_url("https://example.com/acme/repo")
        with self.assertRaises(skills.SkillError):
            skills.get_skill("../../etc")


class AgentSkillToolTests(unittest.TestCase):
    def test_skill_tools_are_read_only_and_listed(self) -> None:
        import routers.agent as agent
        from services import copilot

        names = {t["function"]["name"] for t in agent.TOOLS}
        self.assertTrue({"load_skill", "read_skill_file"} <= names)
        self.assertEqual(copilot.risk_of("load_skill"), "read")


if __name__ == "__main__":
    unittest.main()
