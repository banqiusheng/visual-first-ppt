#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  return "Usage: hash-artifacts.mjs OUTPUT_JSON FILE [FILE ...]";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function main(argv) {
  const [outputPath, ...files] = argv;
  if (!outputPath || files.length === 0 || outputPath === "--help") {
    console.log(usage());
    return;
  }
  const entries = [];
  for (const file of [...files].sort()) {
    const absolute = path.resolve(file);
    const bytes = await fs.readFile(absolute);
    entries.push({ path: absolute, sha256: sha256(bytes), size: bytes.length });
  }
  const manifest = { schemaVersion: "1.0.0", files: entries };
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), payload);
  console.log(sha256(Buffer.from(payload)));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
