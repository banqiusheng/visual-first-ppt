import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const README_FILES = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
];
const LANGUAGE_MARKER = "<!-- README_LANGUAGES: en | zh-CN | ja | ko -->";

function extractBashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

test("all localized READMEs expose the same release and workflow contract", async () => {
  const canonicalReadme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const canonicalBashBlocks = extractBashBlocks(canonicalReadme);

  for (const readmeFile of README_FILES) {
    const readme = await fs.readFile(path.join(ROOT, readmeFile), "utf8");

    assert.ok(readme.includes(LANGUAGE_MARKER), `${readmeFile} is missing the language marker`);
    assert.equal((readme.match(/^## /gm) ?? []).length, 13, `${readmeFile} has a section mismatch`);
    assert.deepEqual(
      extractBashBlocks(readme),
      canonicalBashBlocks,
      `${readmeFile} has commands that differ from README.md`,
    );
    for (const linkedReadme of README_FILES) {
      assert.ok(readme.includes(`](${linkedReadme})`), `${readmeFile} does not link to ${linkedReadme}`);
    }

    for (const route of ["create", "template", "edit"]) {
      assert.match(readme, new RegExp(`\\b${route}\\b`), `${readmeFile} is missing route ${route}`);
    }
    for (const gate of [
      "[OUTLINE_APPROVED]",
      "[VISUAL_LOCKED]",
      "[SCOPE_APPROVED]",
      "[FINAL_APPROVED]",
    ]) {
      assert.ok(readme.includes(gate), `${readmeFile} is missing gate ${gate}`);
    }

    for (const requiredText of [
      "visual-first-ppt",
      "verify_handoff_paths.py",
      "project-state.mjs",
      "https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.1.0",
      "CHANGELOG.md",
      "LICENSE",
    ]) {
      assert.ok(readme.includes(requiredText), `${readmeFile} is missing ${requiredText}`);
    }

    assert.doesNotMatch(readme, /After this repository is published/i);

    for (const link of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = link[1].split("#", 1)[0];
      if (!target || /^https?:\/\//.test(target)) continue;
      await assert.doesNotReject(
        fs.access(path.join(ROOT, target)),
        `${readmeFile} links to missing path ${target}`,
      );
    }
  }
});
