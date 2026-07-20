import assert from "node:assert/strict";
import test from "node:test";

import { loadLayoutArchetypes } from "../../skills/visual-first-ppt/scripts/lib/quality-contract.mjs";

const REQUIRED_IDS = [
  "cover-hero-left",
  "cover-hero-right",
  "poem-focus",
  "split-visual-analysis",
  "three-block-analysis",
  "structure-map",
  "data-focus",
  "ending-thesis"
];

const REQUIRED_BUDGETS = {
  "cover-hero-left": { maxContentBlocks: 4, maxLinesPerBlock: 2 },
  "cover-hero-right": { maxContentBlocks: 4, maxLinesPerBlock: 2 },
  "poem-focus": { maxContentBlocks: 2, maxLinesPerBlock: 4 },
  "split-visual-analysis": { maxContentBlocks: 4, maxLinesPerBlock: 4 },
  "three-block-analysis": { maxContentBlocks: 3, maxLinesPerBlock: 3 },
  "structure-map": { maxContentBlocks: 4, maxLinesPerBlock: 3 },
  "data-focus": { maxContentBlocks: 3, maxLinesPerBlock: 3 },
  "ending-thesis": { maxContentBlocks: 2, maxLinesPerBlock: 3 }
};

test("layout catalog supplies the eight enforced archetypes on a 12-column grid", async () => {
  const catalog = await loadLayoutArchetypes();

  assert.equal(catalog.grid.columns, 12);
  assert.equal(catalog.grid.gutterInches, 0.20);
  assert.deepEqual(catalog.layouts.map((layout) => layout.id).sort(), REQUIRED_IDS.sort());
});

test("enforced layouts partition text and visual columns with explicit budgets", async () => {
  const catalog = await loadLayoutArchetypes();
  const overlapAllowed = new Set(["poem-focus", "ending-thesis"]);

  for (const layout of catalog.layouts) {
    assert.ok(layout.pageRoles.length > 0, `${layout.id} has page roles`);
    assert.ok(Number.isInteger(layout.maxContentBlocks) && layout.maxContentBlocks > 0, `${layout.id} has a block budget`);
    assert.ok(Number.isInteger(layout.maxLinesPerBlock) && layout.maxLinesPerBlock > 0, `${layout.id} has a line budget`);
    assert.ok(Array.isArray(layout.textColumns) && Array.isArray(layout.visualColumns), `${layout.id} declares columns`);

    const text = new Set(layout.textColumns);
    const visual = new Set(layout.visualColumns);
    for (const column of [...text, ...visual]) {
      assert.ok(Number.isInteger(column) && column >= 1 && column <= 12, `${layout.id} column is in grid`);
    }
    if (!overlapAllowed.has(layout.id)) {
      assert.equal([...text].filter((column) => visual.has(column)).length, 0, `${layout.id} has no text/visual overlap`);
    }
  }
});

test("each layout locks its exact content-block and line budgets", async () => {
  const catalog = await loadLayoutArchetypes();

  assert.deepEqual(
    Object.fromEntries(catalog.layouts.map((layout) => [layout.id, {
      maxContentBlocks: layout.maxContentBlocks,
      maxLinesPerBlock: layout.maxLinesPerBlock
    }])),
    REQUIRED_BUDGETS
  );
});
