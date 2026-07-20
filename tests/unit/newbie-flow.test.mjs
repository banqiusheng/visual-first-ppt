import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SVG_PATH = path.join(ROOT, "docs/assets/newbie-quick-start.svg");
const STAGE_LABELS = [
  "1  Plugin v0.3.0",
  "2  $visual-first-ppt",
  "3  create | template | edit",
  "4  PPTX + PDF + ZIP",
];

test("newbie flow SVG is accessible, language-neutral, and privacy-safe", async () => {
  const svg = await fs.readFile(SVG_PATH, "utf8");

  assert.match(svg, /<svg\b[^>]*\bwidth="1200"[^>]*\bheight="360"[^>]*>/);
  assert.match(svg, /<title\b[^>]*\bid="newbie-title"[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc\b[^>]*\bid="newbie-desc"[^>]*>[^<]+<\/desc>/);
  assert.match(svg, /\baria-labelledby="newbie-title newbie-desc"/);

  for (const token of [
    "v0.3.0",
    "$visual-first-ppt",
    "create | template | edit",
    "PPTX + PDF + ZIP",
  ]) {
    assert.ok(svg.includes(token), `newbie flow SVG is missing ${token}`);
  }

  const visibleLabels = [...svg.matchAll(/<text\b[^>]*>([^<]+)<\/text>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(visibleLabels, STAGE_LABELS, "SVG must use only the four approved stage labels");

  assert.doesNotMatch(svg, /<script\b/i);
  assert.doesNotMatch(svg, /https?:\/\//i);
  assert.doesNotMatch(svg, /\/Users\//);
  assert.doesNotMatch(svg, /\b(?:banqiusheng|nianfuyinian)\b/i);
  assert.doesNotMatch(svg, /(?:customer|client|school|客户|学校)/i);
  assert.doesNotMatch(svg, /\b(?:href|xlink:href)\s*=/i);
});
