import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const AGENT_ENTRY = path.join(ROOT, "AGENTS.md");

const requiredAgentText = [
  "skills/visual-first-ppt/SKILL.md",
  "inspect",
  "install",
  "use",
  "maintain",
  "release",
  "v0.2.0",
  "EXISTING_INSTALLATION",
  "EXISTING_INSTALLATION_NOT_FOUND",
  "RELEASE_NOT_FOUND",
  "$skill-installer",
  "$visual-first-ppt",
  "Do not overwrite",
  "next Codex turn",
  "start a new Codex task",
  "SETUP_TARGET",
  "SETUP_VERIFIED",
  "UPGRADE_APPROVED",
  "ROLLBACK",
];

test("root Agent entry exposes the complete pinned distribution contract", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.doesNotMatch(
    agentEntry,
    /\b(?:installation_verification|resume_point_after_verification)\b/,
    "AGENTS.md must not expose frozen evaluation field names",
  );

  for (const text of requiredAgentText) {
    assert.ok(agentEntry.includes(text), `AGENTS.md is missing: ${text}`);
  }

  const routeHeadings = ["inspect", "install", "use", "maintain", "release"];
  let previousIndex = -1;
  for (const route of routeHeadings) {
    const currentIndex = agentEntry.indexOf(`### ${route}`);
    assert.ok(currentIndex > previousIndex, `${route} route is missing or out of order`);
    previousIndex = currentIndex;
  }
});

test("repository guidance works before installation and keeps the installed Skill self-contained", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(agentEntry, /Read this repository guide before any Skill or Plugin installation\./);
  assert.match(agentEntry, /installed Skill is self-contained/i);
  assert.match(agentEntry, /AGENTS\.md is not a runtime dependency/i);
  assert.match(agentEntry, /unique execution entrypoint.*skills\/visual-first-ppt\/SKILL\.md/is);
});

test("activation boundaries distinguish Skill turns from Plugin tasks", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(
    agentEntry,
    /Skill installation.*next Codex turn.*\$visual-first-ppt.*not discovered.*start a new Codex task/is,
  );
  assert.match(
    agentEntry,
    /Plugin installation or update.*start a new Codex task/is,
  );
});

test("Agent entry fails closed and grants no remote release authority", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(agentEntry, /EXISTING_INSTALLATION.*Do not overwrite/is);
  assert.match(agentEntry, /RELEASE_NOT_FOUND.*do not fall back to `main`/is);
  assert.match(agentEntry, /does not authorize.*git push.*tag.*GitHub Release/is);
  assert.match(agentEntry, /Marketplace.*does not mean.*submission.*authorized/is);
});

test("ambiguous beginner requests separate setup from presentation production", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(
    agentEntry,
    /ambiguous.*SETUP_TARGET.*Plugin.*Skill-only.*existing.*unknown/is,
  );
  assert.match(
    agentEntry,
    /setup.*verified.*before.*create.*template.*edit/is,
  );
  assert.match(agentEntry, /Do not guess.*install/is);
});

test("installation success requires entrypoint, doctor, and activation evidence", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(agentEntry, /SETUP_VERIFIED.*installed entrypoint.*doctor.*activation/is);
  assert.match(agentEntry, /doctor\.mjs.*--skill-root.*--json/is);
  assert.match(agentEntry, /Do not claim.*installed.*ready.*verification/is);
});

test("every installation answer has a required verification result shape", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");
  const start = agentEntry.indexOf("#### Required installation response");
  const end = agentEntry.indexOf("#### Skill-only recovery", start);

  assert.ok(start >= 0, "AGENTS.md must define the required installation response shape");
  assert.ok(end > start, "the required installation response must stay inside the install route");
  const responseContract = agentEntry.slice(start, end);
  const fields = [
    "verification_plan",
    "installed_target",
    "doctor_command",
    "expected_doctor_result",
    "doctor_result",
    "activation_check",
    "setup_status",
  ];
  let previousIndex = -1;
  for (const field of fields) {
    const currentIndex = responseContract.indexOf(field);
    assert.ok(currentIndex > previousIndex, `${field} is missing or out of order`);
    previousIndex = currentIndex;
  }
  assert.match(
    responseContract,
    /node "\$SKILL_ROOT\/scripts\/doctor\.mjs" --skill-root "\$SKILL_ROOT" --json/,
  );
  assert.match(
    responseContract,
    /including.*guidance-only.*no installation.*run/is,
  );
  assert.match(responseContract, /expected_doctor_result[\s\S]*exit 0[\s\S]*PASS/);
  assert.match(responseContract, /expected_doctor_result[\s\S]*exit 2[\s\S]*WARN/);
  assert.match(responseContract, /doctor_result[\s\S]*NOT_RUN[\s\S]*NOT_AVAILABLE/);
  assert.match(responseContract, /activation_check[\s\S]*\$visual-first-ppt/);
  assert.match(responseContract, /setup_status[\s\S]*SETUP_NOT_VERIFIED[\s\S]*SETUP_VERIFIED/);
});

test("missing production capabilities expose an exact post-verification resume point", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");
  const useStart = agentEntry.indexOf("### use");
  const maintainStart = agentEntry.indexOf("### maintain", useStart);

  assert.ok(useStart >= 0, "AGENTS.md must define the use route");
  assert.ok(maintainStart > useStart, "the capability contract must stay inside the use route");
  const useContract = agentEntry.slice(useStart, maintainStart);
  const fields = [
    "capability_status",
    "missing_capabilities",
    "resume_after_capabilities_ready",
    "resume_without_manifest",
    "resume_with_manifest",
  ];
  let previousIndex = -1;
  for (const field of fields) {
    const currentIndex = useContract.indexOf(field);
    assert.ok(currentIndex > previousIndex, `${field} is missing or out of order`);
    previousIndex = currentIndex;
  }

  assert.match(useContract, /capability_status[\s\S]*BLOCKED_CAPABILITY/);
  assert.match(useContract, /missing_capabilities[\s\S]*Presentations[\s\S]*imagegen/);
  assert.match(
    useContract,
    /resume_after_capabilities_ready[\s\S]*both capabilities[\s\S]*new Codex task[\s\S]*\$visual-first-ppt/is,
  );
  assert.match(useContract, /resume_without_manifest[\s\S]*ROUTE_SELECTION_OR_BRIEF[\s\S]*create[\s\S]*template[\s\S]*edit/is);
  assert.match(useContract, /resume_with_manifest[\s\S]*project-manifest\.json[\s\S]*project ID[\s\S]*RECORDED_GATE/is);
});

test("the default Skill doctor example is directly executable", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(
    agentEntry,
    /```bash\nSKILL_ROOT="\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt"\nnode "\$SKILL_ROOT\/scripts\/doctor\.mjs" --skill-root "\$SKILL_ROOT" --json\n```/,
  );
  assert.doesNotMatch(agentEntry, /node SKILL_ROOT\/scripts\/doctor\.mjs/);
});

test("Skill-only recovery uses comparison, exact approval, backup, and rollback", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");
  const skillOnlyStart = agentEntry.indexOf("#### Skill-only recovery");
  const pluginStart = agentEntry.indexOf("#### Plugin recovery");

  assert.ok(skillOnlyStart >= 0, "AGENTS.md must define a Skill-only recovery route");
  assert.ok(pluginStart > skillOnlyStart, "Plugin recovery must follow Skill-only recovery");
  const skillOnly = agentEntry.slice(skillOnlyStart, pluginStart);

  assert.match(skillOnly, /read-only version or content comparison/is);
  assert.match(skillOnly, /path-specific `UPGRADE_APPROVED`/is);
  assert.match(skillOnly, /timestamped sibling backup/is);
  assert.match(skillOnly, /fresh destination.*verify/is);
  assert.match(skillOnly, /ROLLBACK.*restor.*backup/is);
  assert.match(skillOnly, /Never merge or recursively delete/is);
});

test("Plugin recovery uses only supported controls and never moves managed storage", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");
  const pluginStart = agentEntry.indexOf("#### Plugin recovery");
  const nextRoute = agentEntry.indexOf("### use", pluginStart);

  assert.ok(pluginStart >= 0, "AGENTS.md must define a Plugin recovery route");
  assert.ok(nextRoute > pluginStart, "Plugin recovery must stay inside the install route");
  const plugin = agentEntry.slice(pluginStart, nextRoute);

  assert.match(plugin, /Codex-supported Plugin management, update, and rollback controls/is);
  assert.match(plugin, /Never guess, move, rename, or recursively delete Plugin-managed storage/is);
  assert.match(plugin, /no supported recoverable update\/rollback path.*stop.*blocker/is);
  assert.match(plugin, /do not ask for or consume `UPGRADE_APPROVED`/is);
  assert.doesNotMatch(plugin, /timestamped sibling backup|fresh destination/is);
});

test("a similarly named data directory is not treated as an installed target", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");

  assert.match(
    agentEntry,
    /EXISTING_INSTALLATION_NOT_FOUND.*project-data directory.*not.*installed target/is,
  );
  assert.match(agentEntry, /checked locations.*candidate.*v0\.2\.0/is);
  assert.match(agentEntry, /ask.*exact path.*fresh install/is);
  assert.match(agentEntry, /Do not request UPGRADE_APPROVED.*target/is);
});

test("an active setup task never starts nested Codex and checks the bounded Skill path first", async () => {
  const agentEntry = await fs.readFile(AGENT_ENTRY, "utf8");
  const noNestedStart = agentEntry.indexOf("## No nested Codex processes");
  const routingStart = agentEntry.indexOf("## Request routing", noNestedStart);
  const skillOnlyStart = agentEntry.indexOf("#### Skill-only recovery");
  const pluginStart = agentEntry.indexOf("#### Plugin recovery", skillOnlyStart);
  const nextRoute = agentEntry.indexOf("### use", pluginStart);

  assert.ok(noNestedStart >= 0, "AGENTS.md must define the no-nested-Codex rule");
  assert.ok(routingStart > noNestedStart, "request routes must follow the no-nested-Codex rule");
  assert.ok(skillOnlyStart >= 0, "AGENTS.md must define bounded Skill-only recovery");
  assert.ok(pluginStart > skillOnlyStart, "Plugin recovery must follow Skill-only recovery");
  assert.ok(nextRoute > pluginStart, "Plugin recovery must stay inside the install route");

  const noNested = agentEntry.slice(noNestedStart, routingStart);
  const skillOnly = agentEntry.slice(skillOnlyStart, pluginStart);
  const plugin = agentEntry.slice(pluginStart, nextRoute);

  assert.match(
    noNested,
    /commands.*manual fallback.*active Codex.*never run the `codex` executable.*wrapper/is,
  );
  assert.match(skillOnly, /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt/i);
  assert.match(skillOnly, /read-only/i);
  assert.match(skillOnly, /v0\.2\.0/i);
  assert.match(skillOnly, /different absolute Skill path.*only when the user supplied it explicitly/is);
  assert.match(skillOnly, /do not read.*auth(?:entication)?.*files/is);
  assert.match(skillOnly, /do not enumerate.*unrelated environment/is);
  assert.match(skillOnly, /setup or upgrade request.*do not invoke.*\$visual-first-ppt/is);
  assert.match(plugin, /host-provided Plugin management controls.*directly.*Codex host/is);
  assert.match(plugin, /do not run `codex plugin/is);
});
