from __future__ import annotations

import hashlib
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath

from scripts.build_distribution import (
    build_distribution,
    collect_plugin_files,
    collect_skill_files,
    write_deterministic_zip,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class BuildDistributionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name) / "repository"

        (self.root / ".codex-plugin").mkdir(parents=True)
        (self.root / "skills/visual-first-ppt/scripts").mkdir(parents=True)
        (self.root / "skills/visual-first-ppt/assets").mkdir(parents=True)
        (self.root / "assets").mkdir(parents=True)
        (self.root / ".agents/plugins").mkdir(parents=True)

        manifest = {
            "name": "visual-first-ppt",
            "version": "0.2.0",
            "skills": "./skills/",
            "license": "MIT",
            "interface": {
                "logo": "./assets/logo.png",
                "screenshots": ["./assets/screenshot.png"],
            },
        }
        self._write_json(".codex-plugin/plugin.json", manifest)
        self._write("LICENSE", "MIT\n")
        self._write("skills/visual-first-ppt/SKILL.md", "# Visual-First PPT\n")
        self._write("skills/visual-first-ppt/scripts/tool.py", "print('ok')\n")
        self._write("skills/visual-first-ppt/assets/theme.json", "{}\n")
        self._write("assets/logo.png", b"logo")
        self._write("assets/screenshot.png", b"screenshot")

        # None of these repository-only or generated files may enter a package.
        self._write("assets/unreferenced.png", b"not referenced")
        self._write_json(
            ".agents/plugins/marketplace.json",
            {
                "plugins": [
                    {
                        "name": "visual-first-ppt",
                        "source": {
                            "source": "url",
                            "url": "https://github.com/banqiusheng/visual-first-ppt.git",
                            "ref": "v0.2.0",
                        },
                    }
                ]
            },
        )
        self._write("AGENTS.md", "repository instructions\n")
        self._write("README.md", "repository readme\n")
        self._write("scripts/install-skill.sh", "#!/bin/sh\n")
        self._write("tests/local-result.txt", "generated test output\n")
        self._write("skills/other-skill/SKILL.md", "# Other\n")
        self._write("skills/visual-first-ppt/__pycache__/cache.pyc", b"cache")
        self._write("skills/visual-first-ppt/scripts/compiled.pyc", b"cache")
        self._write("skills/visual-first-ppt/.DS_Store", b"metadata")
        self._write("skills/visual-first-ppt/.venv/secret.txt", "secret\n")
        self._write("skills/visual-first-ppt/tests/generated.txt", "test output\n")
        self._write("skills/visual-first-ppt/customer-materials/client.txt", "client\n")

    def _write(self, relative: str, content: str | bytes) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        return path

    def _write_json(self, relative: str, value: object) -> Path:
        return self._write(
            relative,
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        )

    def _extract_checked(self, archive_path: Path, destination: Path) -> list[str]:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            self.assertEqual(len(names), len(set(names)), "duplicate ZIP member")
            for info in infos:
                name = info.filename
                self.assertNotIn("\\", name)
                self.assertFalse(name.startswith("/"))
                self.assertFalse(PureWindowsPath(name).drive)
                self.assertFalse(name.endswith("/"))
                self.assertFalse(
                    any(part in {"", ".", ".."} for part in name.split("/"))
                )
                self.assertFalse(stat.S_ISLNK(info.external_attr >> 16))
            archive.extractall(destination)
        return names

    def test_collectors_use_fixed_allowlists_and_exclude_generated_content(self) -> None:
        skill_entries = collect_skill_files(self.root)
        plugin_entries = collect_plugin_files(self.root)

        skill_names = [archive_name for _, archive_name in skill_entries]
        plugin_names = [archive_name for _, archive_name in plugin_entries]

        self.assertEqual(
            skill_names,
            [
                "visual-first-ppt/SKILL.md",
                "visual-first-ppt/assets/theme.json",
                "visual-first-ppt/scripts/tool.py",
            ],
        )
        self.assertEqual(
            plugin_names,
            [
                ".codex-plugin/plugin.json",
                "LICENSE",
                "assets/logo.png",
                "assets/screenshot.png",
                "skills/visual-first-ppt/SKILL.md",
                "skills/visual-first-ppt/assets/theme.json",
                "skills/visual-first-ppt/scripts/tool.py",
            ],
        )
        forbidden_fragments = (
            ".agents/",
            "AGENTS.md",
            "README.md",
            "install-skill.sh",
            "other-skill",
            "__pycache__",
            ".pyc",
            ".DS_Store",
            ".venv",
            "/tests/",
            "customer-materials",
            "unreferenced.png",
        )
        for archive_name in skill_names + plugin_names:
            self.assertFalse(
                any(fragment in archive_name for fragment in forbidden_fragments),
                archive_name,
            )

    def test_repeated_builds_are_byte_identical_with_stable_zip_metadata(self) -> None:
        output_a = Path(self.temp_dir.name) / "dist-a"
        output_b = Path(self.temp_dir.name) / "dist-b"

        paths_a = build_distribution(self.root, output_a, "0.2.0")
        paths_b = build_distribution(self.root, output_b, "0.2.0")

        self.assertEqual(
            [path.name for path in paths_a],
            [
                "visual-first-ppt-skill-v0.2.0.zip",
                "visual-first-ppt-plugin-v0.2.0.zip",
                "SHA256SUMS",
            ],
        )
        for left, right in zip(paths_a, paths_b, strict=True):
            self.assertEqual(left.read_bytes(), right.read_bytes(), left.name)

        for zip_path in paths_a[:2]:
            with zipfile.ZipFile(zip_path) as archive:
                infos = archive.infolist()
                names = [info.filename for info in infos]
                self.assertEqual(names, sorted(names))
                self.assertEqual(len(names), len(set(names)))
                for info in infos:
                    self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                    self.assertEqual(info.create_system, 3)
                    mode = info.external_attr >> 16
                    self.assertTrue(stat.S_ISREG(mode))
                    self.assertEqual(stat.S_IMODE(mode), 0o644)
                    self.assertEqual(info.extra, b"")
                    self.assertEqual(info.comment, b"")

        with zipfile.ZipFile(paths_a[0]) as archive:
            self.assertTrue(archive.namelist())
            self.assertTrue(
                all(name.startswith("visual-first-ppt/") for name in archive.namelist())
            )

        with zipfile.ZipFile(paths_a[1]) as archive:
            plugin_names = archive.namelist()
            self.assertIn(".codex-plugin/plugin.json", plugin_names)
            self.assertIn("LICENSE", plugin_names)
            self.assertNotIn(".agents/plugins/marketplace.json", plugin_names)

    def test_sha256sums_uses_sorted_filenames_and_two_spaces(self) -> None:
        output = Path(self.temp_dir.name) / "dist"
        skill_zip, plugin_zip, sums_path = build_distribution(
            self.root, output, "0.2.0"
        )

        lines = sums_path.read_text(encoding="utf-8").splitlines()
        expected_paths = sorted([skill_zip, plugin_zip], key=lambda path: path.name)
        self.assertEqual(
            lines,
            [
                f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}"
                for path in expected_paths
            ],
        )
        self.assertTrue(sums_path.read_bytes().endswith(b"\n"))

    def test_archives_validate_from_clean_extraction_and_marketplace_is_separate(self) -> None:
        output = Path(self.temp_dir.name) / "clean-room-dist"
        skill_zip, plugin_zip, _sums = build_distribution(
            self.root, output, "0.2.0"
        )

        # Marketplace is repository metadata, verified independently before the
        # fixture repository becomes unavailable to the extraction checks.
        marketplace = json.loads(
            (self.root / ".agents/plugins/marketplace.json").read_text(
                encoding="utf-8"
            )
        )
        source = marketplace["plugins"][0]["source"]
        self.assertEqual(
            source["url"],
            "https://github.com/banqiusheng/visual-first-ppt.git",
        )
        self.assertEqual(source["ref"], "v0.2.0")

        hidden_repository = Path(self.temp_dir.name) / "repository-unavailable"
        self.root.rename(hidden_repository)
        self.assertFalse(self.root.exists())

        skill_root = Path(self.temp_dir.name) / "clean-skill"
        plugin_root = Path(self.temp_dir.name) / "clean-plugin"
        skill_names = self._extract_checked(skill_zip, skill_root)
        plugin_names = self._extract_checked(plugin_zip, plugin_root)

        self.assertIn("visual-first-ppt/SKILL.md", skill_names)
        self.assertTrue((skill_root / "visual-first-ppt/SKILL.md").is_file())
        self.assertNotIn(".agents/plugins/marketplace.json", plugin_names)
        self.assertTrue((plugin_root / "LICENSE").is_file())

        manifest_path = plugin_root / ".codex-plugin/plugin.json"
        self.assertTrue(manifest_path.is_file())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        skill_reference = manifest["skills"].removeprefix("./").rstrip("/")
        self.assertTrue(skill_reference)
        self.assertFalse(
            any(part in {"", ".", ".."} for part in skill_reference.split("/"))
        )
        self.assertTrue((plugin_root / skill_reference).is_dir())
        self.assertTrue(
            (plugin_root / skill_reference / "visual-first-ppt/SKILL.md").is_file()
        )

        interface = manifest.get("interface", {})
        local_assets = [
            interface[field]
            for field in ("composerIcon", "logo", "logoDark")
            if field in interface
        ]
        local_assets.extend(interface.get("screenshots", []))
        for reference in local_assets:
            self.assertTrue(reference.startswith("./assets/"), reference)
            relative = PurePosixPath(reference.removeprefix("./"))
            self.assertNotIn("..", relative.parts)
            self.assertTrue((plugin_root / Path(relative)).is_file(), reference)

    def test_repository_marketplace_pins_the_public_git_source(self) -> None:
        marketplace = json.loads(
            (REPOSITORY_ROOT / ".agents/plugins/marketplace.json").read_text(
                encoding="utf-8"
            )
        )
        plugin = marketplace["plugins"][0]
        self.assertEqual(plugin["name"], "visual-first-ppt")
        self.assertEqual(plugin["source"]["source"], "url")
        self.assertEqual(
            plugin["source"]["url"],
            "https://github.com/banqiusheng/visual-first-ppt.git",
        )
        self.assertEqual(plugin["source"]["ref"], "v0.3.0")

    def test_version_mismatch_fails_before_publishing_any_output(self) -> None:
        output = Path(self.temp_dir.name) / "not-created"

        with self.assertRaisesRegex(ValueError, "manifest version"):
            build_distribution(self.root, output, "0.2.1")

        self.assertFalse(output.exists())

    def test_symlinks_in_included_trees_are_rejected(self) -> None:
        target = self._write("outside.txt", "outside\n")
        link = self.root / "skills/visual-first-ppt/assets/link.txt"
        try:
            link.symlink_to(target)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")

        with self.assertRaisesRegex(ValueError, "symlink"):
            collect_skill_files(self.root)
        with self.assertRaisesRegex(ValueError, "symlink"):
            collect_plugin_files(self.root)

    def test_manifest_asset_escape_and_absolute_paths_are_rejected(self) -> None:
        manifest_path = self.root / ".codex-plugin/plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        manifest["interface"]["logo"] = "../outside.png"
        self._write_json(".codex-plugin/plugin.json", manifest)
        with self.assertRaisesRegex(ValueError, "relative local path"):
            collect_plugin_files(self.root)

        manifest["interface"]["logo"] = "/tmp/outside.png"
        self._write_json(".codex-plugin/plugin.json", manifest)
        with self.assertRaisesRegex(ValueError, "relative local path"):
            collect_plugin_files(self.root)

    def test_plugin_integrations_fail_closed_instead_of_expanding_allowlist(self) -> None:
        manifest_path = self.root / ".codex-plugin/plugin.json"
        original = json.loads(manifest_path.read_text(encoding="utf-8"))
        unsupported_values = {
            "apps": "./secret/app.json",
            "hooks": "./secret/hooks.json",
            "mcpServers": "./secret/mcp.json",
        }
        for field, value in unsupported_values.items():
            with self.subTest(field=field):
                manifest = dict(original)
                manifest[field] = value
                self._write_json(".codex-plugin/plugin.json", manifest)
                self._write(value.removeprefix("./"), "{}\n")

                with self.assertRaisesRegex(ValueError, "unsupported integration"):
                    collect_plugin_files(self.root)

        self._write_json(".codex-plugin/plugin.json", original)

    def test_zip_writer_rejects_ancestor_symlinks_below_trusted_bases(self) -> None:
        real_source_dir = self.root / "real-source"
        real_source = self._write("real-source/source.txt", "source\n")
        source_link = self.root / "linked-source"
        real_output_dir = self.root / "real-output"
        real_output_dir.mkdir()
        output_link = self.root / "linked-output"
        try:
            source_link.symlink_to(real_source_dir, target_is_directory=True)
            output_link.symlink_to(real_output_dir, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")

        with self.assertRaisesRegex(ValueError, "ancestor symlink"):
            write_deterministic_zip(
                [(source_link / real_source.name, "source.txt")],
                self.root / "safe-output.zip",
            )

        with self.assertRaisesRegex(ValueError, "ancestor symlink"):
            write_deterministic_zip(
                [(real_source, "source.txt")],
                output_link / "archive.zip",
            )
        self.assertFalse((real_output_dir / "archive.zip").exists())

    def test_build_rejects_a_symlink_output_directory(self) -> None:
        real_output_dir = self.root / "real-distribution"
        real_output_dir.mkdir()
        output_link = self.root / "distribution-link"
        try:
            output_link.symlink_to(real_output_dir, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")

        with self.assertRaisesRegex(ValueError, "ancestor symlink"):
            build_distribution(self.root, output_link, "0.2.0")
        self.assertEqual(list(real_output_dir.iterdir()), [])

    def test_build_rejects_a_symlink_repository_root(self) -> None:
        repository_link = Path(self.temp_dir.name) / "repository-link"
        output = Path(self.temp_dir.name) / "root-link-output"
        try:
            repository_link.symlink_to(self.root, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")

        with self.assertRaisesRegex(ValueError, "ancestor symlink"):
            build_distribution(repository_link, output, "0.2.0")
        self.assertFalse(output.exists())

    def test_zip_writer_rejects_unsafe_or_duplicate_archive_names(self) -> None:
        source = self._write("safe.txt", "safe\n")
        output = Path(self.temp_dir.name) / "unsafe.zip"

        for unsafe_name in ("../escape.txt", "/absolute.txt", "C:/absolute.txt"):
            with self.subTest(unsafe_name=unsafe_name):
                with self.assertRaisesRegex(ValueError, "archive path"):
                    write_deterministic_zip([(source, unsafe_name)], output)

        with self.assertRaisesRegex(ValueError, "duplicate archive path"):
            write_deterministic_zip(
                [(source, "safe.txt"), (source, "safe.txt")], output
            )


if __name__ == "__main__":
    unittest.main()
