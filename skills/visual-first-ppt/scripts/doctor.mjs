#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MINIMUM_NODE_VERSION = [20, 0, 0];
const MINIMUM_PYTHON_VERSION = [3, 10, 0];

const REQUIRED_SKILL_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/generation-contract.md",
  "references/intake-and-research.md",
  "references/qa-and-delivery.md",
  "references/themes.md",
  "references/workflow.md",
  "schemas/project-artifacts.schema.json",
  "scripts/build-qa-report.mjs",
  "scripts/validate-current-qa.mjs",
  "scripts/compare_untouched_slides.py",
  "scripts/package_delivery.py",
  "scripts/project-state.mjs",
  "scripts/verify_handoff_paths.py",
  "assets/theme-catalog.json",
  "assets/quality-contract.json",
  "assets/layout-archetypes.json",
  "schemas/quality-evidence.schema.json",
  "scripts/validate-slide-specs.mjs",
  "scripts/audit_pptx_quality.py",
  "scripts/lib/atomic-json.mjs",
  "scripts/lib/quality-contract.mjs",
  "scripts/lib/content-quality.mjs",
  "scripts/lib/quality-evidence.mjs",
  "scripts/lib/schema-validator.mjs",
  "scripts/lib/current-qa.mjs",
  "scripts/lib/visual-contract.mjs",
  "scripts/lib/prebuild-approval.mjs",
  "scripts/lib/zip_safety.py",
];

const CAPABILITIES = ["presentations", "imagegen"];
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

const HELP = `Usage:
  node skills/visual-first-ppt/scripts/doctor.mjs [--json] [--skill-root PATH]

Run read-only checks for the Visual-First PPT Skill and its local requirements.
This includes visual-quality runtime files such as validate-slide-specs.mjs and audit_pptx_quality.py.

Options:
  --json             Print a machine-readable report.
  --skill-root PATH  Check a specific Visual-First PPT Skill directory.
  -h, --help         Show this help.

Exit codes:
  0  PASS: all required checks are confirmed.
  2  WARN: local requirements pass, but optional capability paths are not exposed.
  1  FAIL: a required file, runtime, or explicitly exposed capability is missing.
`;

/** @returns {number[] | null} */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/(?:^|[^0-9])(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

/** @returns {-1 | 0 | 1} */
export function compareVersion(actual, minimum) {
  const length = Math.max(actual.length, minimum.length);
  for (let index = 0; index < length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart < minimumPart) return -1;
    if (actualPart > minimumPart) return 1;
  }
  return 0;
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function uniquePaths(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function upwardAgentSkillsRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (true) {
    const candidate = path.join(current, ".agents", "skills");
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** @returns {string[]} */
export function candidateDiscoveryRoots(env, home) {
  const candidates = [];
  if (env.CODEX_HOME) candidates.push(path.join(env.CODEX_HOME, "skills"));
  candidates.push(path.join(home, ".codex", "skills"));
  candidates.push(path.join(home, ".agents", "skills"));

  const repositoryAgentSkills = upwardAgentSkillsRoot(env.PWD || process.cwd());
  if (repositoryAgentSkills) candidates.push(repositoryAgentSkills);
  return uniquePaths(candidates);
}

function discoveryRootsForSkill(skillRoot, env, home) {
  return uniquePaths([
    path.resolve(skillRoot),
    ...candidateDiscoveryRoots(env, home),
  ]);
}

function versionText(version) {
  return version.join(".");
}

function nodeCheck(env) {
  const rawVersion = env.VISUAL_FIRST_PPT_TEST_NODE_VERSION ?? process.version;
  const actual = parseVersion(rawVersion);
  if (!actual) {
    return {
      id: "node",
      status: "FAIL",
      detail: "The Node.js version could not be parsed.",
      nextAction: "Install Node.js 20 or later, then run the doctor again.",
    };
  }
  if (compareVersion(actual, MINIMUM_NODE_VERSION) < 0) {
    return {
      id: "node",
      status: "FAIL",
      detail: `Node.js ${versionText(actual)} is below the required 20.0.0.`,
      nextAction: "Use Node.js 20 or later; the doctor does not install runtimes.",
    };
  }
  return {
    id: "node",
    status: "PASS",
    detail: `Node.js ${versionText(actual)} satisfies the 20.0.0 minimum.`,
    nextAction: "No action required.",
  };
}

function substitutedPythonResults(raw) {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return [];
    return Object.entries(parsed)
      .filter(([command, output]) => command && typeof output === "string")
      .map(([command, output]) => ({ command, status: 0, stdout: output, stderr: "" }));
  } catch {
    return [];
  }
}

function pythonCheck(env, spawnSyncImpl) {
  const substituted = substitutedPythonResults(env.VISUAL_FIRST_PPT_TEST_PYTHON_COMMANDS);
  const candidates = substituted ?? ["python3", "python"];

  const detected = [];
  for (const candidate of candidates) {
    const result = substituted
      ? candidate
      : {
          command: candidate,
          ...spawnSyncImpl(candidate, ["--version"], {
            encoding: "utf8",
            timeout: 5_000,
            windowsHide: true,
          }),
        };
    if (result.status !== 0) continue;
    const version = parseVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (!version) continue;
    detected.push({ command: result.command, version });
    if (compareVersion(version, MINIMUM_PYTHON_VERSION) >= 0) {
      return {
        id: "python",
        status: "PASS",
        detail: `${result.command} reports Python ${versionText(version)}, satisfying the 3.10.0 minimum.`,
        nextAction: "No action required.",
      };
    }
  }

  if (detected.length > 0) {
    const detectedText = detected
      .map(({ command, version }) => `${command} ${versionText(version)}`)
      .join(", ");
    return {
      id: "python",
      status: "FAIL",
      detail: `Detected Python commands are below 3.10.0: ${detectedText}.`,
      nextAction: "Use Python 3.10 or later; the doctor does not install runtimes.",
    };
  }

  return {
    id: "python",
    status: "FAIL",
    detail: "No usable Python 3 command was detected.",
    nextAction: "Install Python 3.10 or later, then run the doctor again.",
  };
}

function skillFilesCheck(skillRoot) {
  const missing = REQUIRED_SKILL_FILES.filter(
    (relativePath) => !isFile(path.join(skillRoot, relativePath)),
  );
  if (missing.length > 0) {
    return {
      id: "skill-files",
      status: "FAIL",
      detail: `Missing required Skill files at ${skillRoot}: ${missing.join(", ")}.`,
      nextAction: "Restore the complete versioned Skill directory; do not merge it with a partial copy.",
    };
  }
  return {
    id: "skill-files",
    status: "PASS",
    detail: `All ${REQUIRED_SKILL_FILES.length} required Skill files are present at ${skillRoot}.`,
    nextAction: "No action required.",
  };
}

function capabilityFile(root, capability) {
  const fixedCandidates = [
    path.join(root, capability, "SKILL.md"),
    path.join(root, ".system", capability, "SKILL.md"),
  ];
  for (const candidate of fixedCandidates) {
    if (isFile(candidate)) return candidate;
  }

  if (!isDirectory(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const matchingEntry = entries.find(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === capability,
  );
  if (!matchingEntry) return null;
  const candidate = path.join(root, matchingEntry.name, "SKILL.md");
  return isFile(candidate) ? candidate : null;
}

function capabilityCheck(capability, roots, env) {
  for (const root of roots) {
    const evidence = capabilityFile(root, capability);
    if (evidence) {
      return {
        id: `capability-${capability}`,
        status: "PASS",
        detail: `${capability} is visible at ${evidence}.`,
        nextAction: "No action required.",
      };
    }
  }

  if (env.CODEX_HOME) {
    const exposedRoot = path.resolve(env.CODEX_HOME, "skills");
    return {
      id: `capability-${capability}`,
      status: "FAIL",
      detail: `CODEX_HOME explicitly exposes ${exposedRoot}, but ${capability} is not present in the approved discovery roots.`,
      nextAction: `Provide the ${capability} capability in the current Codex environment; this repository does not bundle it.`,
    };
  }

  return {
    id: `capability-${capability}`,
    status: "WARN",
    detail: `The current runtime does not expose an authoritative capability path, so ${capability} cannot be confirmed from approved discovery roots.`,
    nextAction: `Confirm that ${capability} is available in Codex before starting PPT production.`,
  };
}

/** @returns {{id:string,status:"PASS"|"WARN"|"FAIL",detail:string,nextAction:string}[]} */
export function runChecks({ skillRoot, env, home, spawnSyncImpl = spawnSync }) {
  const resolvedSkillRoot = path.resolve(skillRoot);
  const roots = discoveryRootsForSkill(resolvedSkillRoot, env, home);
  return [
    skillFilesCheck(resolvedSkillRoot),
    nodeCheck(env),
    pythonCheck(env, spawnSyncImpl),
    ...CAPABILITIES.map((capability) => capabilityCheck(capability, roots, env)),
  ];
}

/** @returns {"PASS" | "WARN" | "FAIL"} */
export function overallStatus(checks) {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (checks.some((check) => check.status === "WARN")) return "WARN";
  return "PASS";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeText(value, home) {
  let sanitized = String(value);
  if (home) {
    const normalizedHome = path.resolve(home);
    sanitized = sanitized.replace(
      new RegExp(`${escapeRegExp(normalizedHome)}(?=$|[\\/])`, "g"),
      "~",
    );
  }
  sanitized = sanitized.replace(/\/Users\/[^/\s]+/g, "/Users/<redacted>");
  sanitized = sanitized.replace(/\/home\/[^/\s]+/g, "/home/<redacted>");
  sanitized = sanitized.replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, "$1<redacted>");
  return sanitized;
}

function sanitizeReport(report, home) {
  return {
    status: report.status,
    checks: report.checks.map((check) => ({
      id: check.id,
      status: check.status,
      detail: sanitizeText(check.detail, home),
      nextAction: sanitizeText(check.nextAction, home),
    })),
    discoveryRoots: report.discoveryRoots.map((root) => sanitizeText(root, home)),
  };
}

function parseArguments(argv) {
  const options = { json: false, skillRoot: DEFAULT_SKILL_ROOT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--skill-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--skill-root requires PATH");
      }
      options.skillRoot = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHumanReport(report) {
  process.stdout.write(`Visual-First PPT doctor: ${report.status}\n`);
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.id}: ${check.detail}\n`);
    if (check.status !== "PASS") {
      process.stdout.write(`  Next: ${check.nextAction}\n`);
    }
  }
  process.stdout.write("Discovery roots:\n");
  for (const root of report.discoveryRoots) process.stdout.write(`- ${root}\n`);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const home = env.VISUAL_FIRST_PPT_TEST_HOME || env.HOME || process.cwd();
  const checks = runChecks({
    skillRoot: options.skillRoot,
    env,
    home,
    spawnSyncImpl: spawnSync,
  });
  const report = sanitizeReport(
    {
      status: overallStatus(checks),
      checks,
      discoveryRoots: discoveryRootsForSkill(options.skillRoot, env, home),
    },
    home,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
  }
  return report.status === "PASS" ? 0 : report.status === "WARN" ? 2 : 1;
}

function sameExecutablePath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

if (process.argv[1] && sameExecutablePath(process.argv[1], SCRIPT_PATH)) {
  process.exitCode = main();
}
