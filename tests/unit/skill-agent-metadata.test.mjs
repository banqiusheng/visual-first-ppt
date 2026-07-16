import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const METADATA_PATH = path.join(ROOT, "skills/visual-first-ppt/agents/openai.yaml");

test("Skill UI metadata is international, concise, and explicitly invokes the Skill", async () => {
  const metadata = (await fs.readFile(METADATA_PATH, "utf8")).replace(/\r\n/g, "\n").trim();

  assert.equal(
    metadata,
    [
      "interface:",
      '  display_name: "Visual-First PPT"',
      '  short_description: "Create and safely edit editable PowerPoint decks"',
      '  default_prompt: "Use $visual-first-ppt to create, template, or safely edit an editable PowerPoint deck."',
    ].join("\n"),
  );
});
