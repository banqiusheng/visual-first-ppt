import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), "utf8"));
}

test("Plugin manifest points at the single Skill source with approved metadata", async () => {
  const plugin = await readJson(".codex-plugin/plugin.json");

  assert.equal(plugin.name, "visual-first-ppt");
  assert.equal(plugin.version, "0.3.0");
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.license, "MIT");
  assert.equal(plugin.repository, "https://github.com/banqiusheng/visual-first-ppt");
  assert.deepEqual(plugin.interface.capabilities, ["Read", "Write"]);
  assert.ok(plugin.interface.defaultPrompt.some((item) => item.includes("$visual-first-ppt")));

  await assert.doesNotReject(fs.access(path.join(ROOT, "skills/visual-first-ppt/SKILL.md")));
  await assert.rejects(fs.access(path.join(ROOT, "plugins/visual-first-ppt/SKILL.md")));
});

test("Plugin manifest omits unused integrations and unsupported entrypoints", async () => {
  const plugin = await readJson(".codex-plugin/plugin.json");

  for (const forbiddenField of ["hooks", "apps", "mcpServers", "main", "id", "pluginId"]) {
    assert.equal(
      Object.hasOwn(plugin, forbiddenField),
      false,
      `plugin manifest must not declare ${forbiddenField}`,
    );
  }
  assert.deepEqual(
    Object.keys(plugin).sort(),
    [
      "author",
      "description",
      "homepage",
      "interface",
      "keywords",
      "license",
      "name",
      "repository",
      "skills",
      "version",
    ].sort(),
  );
});

test("repository Marketplace uses the pinned Git-backed v0.3.0 Plugin source", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json");

  assert.equal(marketplace.name, "visual-first-ppt-marketplace");
  assert.equal(marketplace.interface.displayName, "Visual-First PPT");
  assert.equal(marketplace.plugins.length, 1);

  const entry = marketplace.plugins[0];
  assert.equal(entry.name, "visual-first-ppt");
  assert.equal(entry.source.source, "url");
  assert.equal(entry.source.url, "https://github.com/banqiusheng/visual-first-ppt.git");
  assert.equal(entry.source.ref, "v0.3.0");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(entry.category, "Productivity");

  assert.deepEqual(Object.keys(entry).sort(), ["category", "name", "policy", "source"].sort());
  assert.deepEqual(Object.keys(entry.source).sort(), ["ref", "source", "url"].sort());
  assert.equal(Object.hasOwn(entry, "id"), false);
  assert.equal(Object.hasOwn(entry, "pluginId"), false);
});
