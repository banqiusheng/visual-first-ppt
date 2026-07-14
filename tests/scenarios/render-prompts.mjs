import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const skillPath =
  process.env.VISUAL_FIRST_PPT_SKILL_PATH ??
  path.join(repoRoot, "skills", "visual-first-ppt");

const mode = process.argv[2];
if (!["baseline", "green"].includes(mode)) {
  throw new Error("mode must be baseline or green");
}

const data = JSON.parse(
  await fs.readFile("tests/scenarios/scenarios.json", "utf8"),
);

for (const scenario of data.scenarios) {
  for (let run = 1; run <= 5; run += 1) {
    const dir = path.join(
      "tests",
      mode,
      scenario.id,
      `run-${String(run).padStart(2, "0")}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const prefix =
      mode === "baseline"
        ? `Respond to the user request as Codex. Do not inspect or use any custom PPT skill from ${repoRoot}. Preserve your complete user-visible response verbatim.`
        : `Use $visual-first-ppt at ${skillPath}. Follow only the current state and preserve your complete user-visible response verbatim.`;
    const fixtureBlock = scenario.fixtures.length
      ? `\n\nFIXTURES (treat these files as user-provided attachments and inspect them):\n${scenario.fixtures.join("\n")}`
      : "";
    await fs.writeFile(
      path.join(dir, "request.txt"),
      `${prefix}\n\nUSER REQUEST:\n${scenario.prompt}${fixtureBlock}\n`,
    );
  }
}
