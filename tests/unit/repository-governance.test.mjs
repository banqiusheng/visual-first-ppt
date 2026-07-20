import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const safetyNotice =
  "Do not include tokens, passwords, account identifiers, personal absolute paths, or customer decks.";
const privateReportingUrl =
  "https://github.com/banqiusheng/visual-first-ppt/security/advisories/new";

const governanceFiles = [
  "SUPPORT.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  ".github/ISSUE_TEMPLATE/install-help.yml",
  ".github/ISSUE_TEMPLATE/bug-report.yml",
  ".github/ISSUE_TEMPLATE/feature-request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/dependabot.yml",
];

const issueForms = [
  ".github/ISSUE_TEMPLATE/install-help.yml",
  ".github/ISSUE_TEMPLATE/bug-report.yml",
  ".github/ISSUE_TEMPLATE/feature-request.yml",
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function markdownSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.ok(start >= 0, `missing section ${heading}`);
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next < 0 ? undefined : next);
}

function fieldIds(yaml) {
  return [...yaml.matchAll(/^\s{4}id:\s*([a-z][a-z0-9_-]*)\s*$/gm)].map(
    (match) => match[1],
  );
}

function pythonWithPinnedYaml() {
  const candidates = [
    process.env.PYTHON,
    path.join(repoRoot, ".venv/bin/python"),
    "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-c", "import yaml,sys; sys.exit(0 if yaml.__version__ == '6.0.2' else 1)"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return candidate;
  }
  throw new Error("PyYAML==6.0.2 is required; install requirements-dev.txt");
}

test("all public repository governance files exist", () => {
  for (const relativePath of governanceFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(absolutePath), `missing ${relativePath}`);
    assert.ok(fs.statSync(absolutePath).isFile(), `${relativePath} must be a file`);
  }
});

test("all governance YAML parses and satisfies its top-level schema", () => {
  const validator = String.raw`
import re
import sys
from pathlib import Path
import yaml

for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    with path.open(encoding="utf-8") as stream:
        value = yaml.safe_load(stream)
    assert isinstance(value, dict), path
    if path.name == "dependabot.yml":
        assert value.get("version") == 2, path
        updates = value.get("updates")
        assert isinstance(updates, list) and len(updates) == 1, path
        update = updates[0]
        assert update.get("package-ecosystem") == "github-actions", path
        assert update.get("directory") == "/", path
        assert update.get("schedule") == {"interval": "weekly"}, path
    elif path.name == "config.yml":
        assert value.get("blank_issues_enabled") is False, path
        links = value.get("contact_links")
        assert isinstance(links, list) and links, path
        for link in links:
            assert set(link) == {"name", "url", "about"}, path
            assert all(isinstance(link[key], str) and link[key].strip() for key in link), path
            assert link["url"].startswith("https://"), path
    else:
        for key in ("name", "description", "title"):
            assert isinstance(value.get(key), str) and value[key].strip(), (path, key)
        assert isinstance(value.get("labels"), list), path
        body = value.get("body")
        assert isinstance(body, list) and body, path
        ids = []
        for item in body:
            assert isinstance(item, dict), path
            kind = item.get("type")
            assert kind in {"markdown", "input", "dropdown", "textarea", "checkboxes"}, path
            attributes = item.get("attributes")
            assert isinstance(attributes, dict), path
            if kind == "markdown":
                assert isinstance(attributes.get("value"), str), path
                continue
            field_id = item.get("id")
            assert isinstance(field_id, str) and re.fullmatch(r"[a-z][a-z0-9_-]*", field_id), path
            ids.append(field_id)
            assert isinstance(attributes.get("label"), str) and attributes["label"].strip(), path
            validations = item.get("validations", {})
            assert isinstance(validations, dict), path
            if "required" in validations:
                assert isinstance(validations["required"], bool), path
            if kind == "dropdown":
                options = attributes.get("options")
                assert isinstance(options, list) and all(isinstance(option, str) and option for option in options), path
            if kind == "checkboxes":
                options = attributes.get("options")
                assert isinstance(options, list) and options, path
                for option in options:
                    assert isinstance(option, dict), path
                    assert isinstance(option.get("label"), str) and option["label"].strip(), path
                    assert option.get("required") is True, path
        assert len(ids) == len(set(ids)), path
`;
  const yamlPaths = governanceFiles
    .filter((relativePath) => relativePath.endsWith(".yml"))
    .map((relativePath) => path.join(repoRoot, relativePath));
  const result = spawnSync(pythonWithPinnedYaml(), ["-c", validator, ...yamlPaths], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("support, security, contribution, and issue guidance repeat the disclosure boundary", () => {
  for (const relativePath of [
    "SUPPORT.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    ...issueForms,
  ]) {
    assert.ok(
      read(relativePath).includes(safetyNotice),
      `${relativePath} must contain the exact safety notice`,
    );
  }
});

test("security reports have one private reporting destination", () => {
  const security = read("SECURITY.md");
  assert.ok(security.includes(privateReportingUrl));
  assert.doesNotMatch(security, /github\.com\/banqiusheng\/visual-first-ppt\/issues\/new/i);
  assert.match(security, /Private Vulnerability Reporting/i);
});

test("support runbook follows the required diagnostic order", () => {
  const support = read("SUPPORT.md");
  const checkpoints = [
    "Confirm the version",
    "Confirm the Codex surface",
    "Run doctor",
    "Check for an existing installation",
    "Check dependencies",
    "Request redacted installation help",
  ];
  let previous = -1;
  for (const checkpoint of checkpoints) {
    const current = support.indexOf(checkpoint);
    assert.ok(current > previous, `${checkpoint} must appear in the required order`);
    previous = current;
  }
});

test("doctor guidance covers every installation path without inventing output", () => {
  const support = read("SUPPORT.md");
  for (const pathLabel of [
    "Repository checkout",
    "Skill-only default installation",
    "Skill-only custom installation",
    "Plugin installation",
  ]) {
    assert.match(support, new RegExp(`\\*\\*${pathLabel}\\.\\*\\*`), pathLabel);
  }
  assert.ok(
    support.includes(
      '{"status":"NOT_AVAILABLE","reason":"installation stopped before doctor became available"}',
    ),
  );
  assert.match(support, /Do not invent or reconstruct doctor output/i);
});

test("support runbook keeps Skill-only recovery comparison-first and recoverable", () => {
  const support = markdownSection(read("SUPPORT.md"), "## 4. Check for an existing installation");
  const skillOnlyStart = support.indexOf("### Skill-only recovery");
  const pluginStart = support.indexOf("### Plugin recovery");

  assert.ok(skillOnlyStart >= 0, "SUPPORT.md must define a Skill-only recovery route");
  assert.ok(pluginStart > skillOnlyStart, "Plugin recovery must follow Skill-only recovery");
  const skillOnly = support.slice(skillOnlyStart, pluginStart);
  const checkpoints = [
    "read-only version or content comparison",
    "UPGRADE_APPROVED",
    "timestamped sibling backup",
    "fresh destination",
    "SETUP_VERIFIED",
    "ROLLBACK",
    "restore the backup",
  ];
  let previous = -1;
  for (const checkpoint of checkpoints) {
    const current = skillOnly.indexOf(checkpoint);
    assert.ok(current > previous, `${checkpoint} must appear in the recovery order`);
    previous = current;
  }
  assert.match(skillOnly, /Never merge or recursively delete/i);
});

test("support runbook keeps Plugin recovery inside Codex-supported controls", () => {
  const support = markdownSection(read("SUPPORT.md"), "## 4. Check for an existing installation");
  const pluginStart = support.indexOf("### Plugin recovery");

  assert.ok(pluginStart >= 0, "SUPPORT.md must define a Plugin recovery route");
  const plugin = support.slice(pluginStart);

  assert.match(plugin, /Codex-supported Plugin management, update, and rollback controls/is);
  assert.match(plugin, /Never guess, move, rename, or recursively delete Plugin-managed storage/is);
  assert.match(plugin, /no supported recoverable update\/rollback path.*stop.*blocker/is);
  assert.match(plugin, /do not ask for or consume `UPGRADE_APPROVED`/is);
  assert.doesNotMatch(plugin, /timestamped sibling backup|fresh destination/is);
});

test("support distinguishes manual commands from nested Codex execution", () => {
  const support = read("SUPPORT.md");
  assert.match(support, /manual user commands.*active Codex Agent.*must not.*`codex` executable/is);
  assert.match(
    support,
    /default Skill root.*\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt/is,
  );
  assert.match(support, /different absolute Skill path only when the user supplied it explicitly/is);
  assert.match(support, /do not read authentication files.*do not enumerate unrelated environment/is);
  assert.match(support, /do not invoke the installed.*\$visual-first-ppt.*workflow/is);
  assert.match(support, /Plugin.*host.*directly exposes.*do not run `codex plugin/is);
});

test("the copyable Plugin doctor prompt uses only host-exposed information and fails closed", () => {
  const support = read("SUPPORT.md");
  const pluginStart = support.indexOf("**Plugin installation.**");
  const unavailableStart = support.indexOf("If installation stopped", pluginStart);
  assert.ok(pluginStart >= 0 && unavailableStart > pluginStart, "Plugin doctor prompt is missing");
  const pluginPrompt = support.slice(pluginStart, unavailableStart);

  assert.match(pluginPrompt, /Skill root and Plugin information exposed directly by the current host/is);
  assert.match(pluginPrompt, /host does not expose that root.*stop.*blocker/is);
  assert.match(pluginPrompt, /Do not guess or scan Plugin-managed storage/is);
  assert.match(pluginPrompt, /Do not run the codex executable.*codex plugin/is);
});

test("support runbook stops without approval when no real installation is found", () => {
  const support = markdownSection(read("SUPPORT.md"), "## 4. Check for an existing installation");

  assert.match(
    support,
    /EXISTING_INSTALLATION_NOT_FOUND.*project-data directory.*checked locations.*v0\.3\.0/is,
  );
  assert.match(support, /exact path.*fresh install/is);
  assert.match(support, /Do not request `UPGRADE_APPROVED`/is);
});

test("installation help form collects only the required redacted diagnostics", () => {
  const installHelp = read(".github/ISSUE_TEMPLATE/install-help.yml");
  assert.deepEqual(fieldIds(installHelp), [
    "security_routing",
    "version",
    "codex_surface",
    "operating_system",
    "install_method",
    "reproduction_steps",
    "expected_result",
    "doctor_output",
    "disclosure_check",
  ]);
  assert.equal(
    [...installHelp.matchAll(/^\s{4}validations:\s*$\n\s{6}required:\s*true\s*$/gm)].length,
    7,
    "all seven input, dropdown, and textarea fields must be required",
  );
  assert.match(
    installHelp,
    /^\s{8}- label: Do not include tokens, passwords, account identifiers, personal absolute paths, or customer decks\.\s*$\n\s{10}required:\s*true\s*$/m,
  );
  assert.ok(
    installHelp.includes(
      '{"status":"NOT_AVAILABLE","reason":"installation stopped before doctor became available"}',
    ),
    "the required doctor field must accept the truthful NOT_AVAILABLE record",
  );
});

test("every public issue form starts with a required private-security routing check", () => {
  for (const relativePath of issueForms) {
    const yaml = read(relativePath);
    assert.match(
      yaml,
      /^body:\s*$\n\s{2}- type:\s*checkboxes\s*$\n\s{4}id:\s*security_routing\s*$/m,
      `${relativePath}: security routing must be first`,
    );
    assert.match(yaml, /not a security vulnerability/i);
    assert.match(yaml, /GitHub Private Vulnerability Reporting/i);
    assert.ok(yaml.includes(privateReportingUrl), `${relativePath}: exact private URL`);
    assert.match(
      yaml,
      /^\s{8}- label:\s*"[^"]*GitHub Private Vulnerability Reporting:[^"]*"\s*$\n\s{10}required:\s*true\s*$/m,
      `${relativePath}: routing acknowledgement must be required`,
    );
  }
});

test("issue forms use the GitHub form schema without personal defaults or upload requests", () => {
  const allowedTypes = new Set(["markdown", "input", "dropdown", "textarea", "checkboxes"]);
  for (const relativePath of issueForms) {
    const yaml = read(relativePath);
    assert.match(yaml, /^name:\s*.+$/m, `${relativePath}: name`);
    assert.match(yaml, /^description:\s*.+$/m, `${relativePath}: description`);
    assert.match(yaml, /^title:\s*".*"\s*$/m, `${relativePath}: title`);
    assert.match(yaml, /^labels:\s*\[[^\]]+\]\s*$/m, `${relativePath}: labels`);
    assert.match(yaml, /^body:\s*$/m, `${relativePath}: body`);
    assert.doesNotMatch(yaml, /^\s+value:\s*.+$/m, `${relativePath}: no personal defaults`);
    const withoutSafetyNotice = yaml.replaceAll(safetyNotice, "");
    assert.doesNotMatch(withoutSafetyNotice, /\b(upload|attach|attachment)\b|\.pptx?\b/i);
    assert.doesNotMatch(withoutSafetyNotice, /customer (deck|material|file|presentation)/i);
    assert.doesNotMatch(withoutSafetyNotice, /screen ?shots?|download links?/i);
    assert.doesNotMatch(
      withoutSafetyNotice,
      /\b(share|provide|paste|post|send)\b[^\n]{0,60}\b(deck|slides?|presentation|customer (?:data|material|files?))\b/i,
      `${relativePath}: must not request public presentation or customer evidence`,
    );

    const types = [...yaml.matchAll(/^\s{2}- type:\s*([a-z]+)\s*$/gm)].map(
      (match) => match[1],
    );
    assert.ok(types.length > 0, `${relativePath}: at least one body item`);
    for (const type of types) {
      assert.ok(allowedTypes.has(type), `${relativePath}: unsupported body type ${type}`);
    }

    const ids = fieldIds(yaml);
    assert.equal(new Set(ids).size, ids.length, `${relativePath}: field ids must be unique`);
  }
});

test("issue chooser disables blank issues and points to support and private security reporting", () => {
  const config = read(".github/ISSUE_TEMPLATE/config.yml");
  assert.match(config, /^blank_issues_enabled:\s*false\s*$/m);
  assert.match(config, /https:\/\/github\.com\/banqiusheng\/visual-first-ppt\/blob\/main\/SUPPORT\.md/);
  assert.match(config, /https:\/\/github\.com\/banqiusheng\/visual-first-ppt\/blob\/main\/SECURITY\.md/);
  assert.ok(config.includes(privateReportingUrl));
  assert.equal([...config.matchAll(/^\s{4}url:\s*https:\/\//gm)].length, 3);
});

test("contribution policy contains validation, branch, customer-data, and authorization gates", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /node --test tests\/unit\/\*\.test\.mjs/);
  assert.match(contributing, /python -m unittest discover -s tests\/unit -p ['"]test_\*\.py['"]/);
  assert.match(contributing, /codex\/\*/);
  assert.match(contributing, /customer materials/i);
  for (const gate of [
    "Local edit",
    "Commit",
    "Push",
    "Pull request",
    "Marketplace",
    "Tag",
    "Release",
    "Installation",
  ]) {
    assert.match(contributing, new RegExp(`^- \\*\\*${gate}:`, "m"), `${gate} gate`);
  }
  assert.match(contributing, /audit_public_candidate\.py --root \. --candidate tracked/);
  assert.match(contributing, /quick_validate\.py/);
  assert.match(contributing, /validate_plugin\.py/);
  assert.doesNotMatch(contributing, /contributors? (?:can|may|should) (?:publish|release)/i);
});

test("Dependabot is limited to weekly GitHub Actions updates", () => {
  const dependabot = read(".github/dependabot.yml");
  assert.match(dependabot, /^version:\s*2\s*$/m);
  assert.equal([...dependabot.matchAll(/^updates:\s*$/gm)].length, 1);
  const ecosystems = [...dependabot.matchAll(/package-ecosystem:\s*"?([^"\s]+)"?/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(ecosystems, ["github-actions"]);
  assert.match(dependabot, /^\s{4}directory:\s*"\/"\s*$/m);
  assert.match(dependabot, /interval:\s*"?weekly"?/);
  assert.doesNotMatch(dependabot, /npm|pip|bundler|docker|maven|gradle/i);
});
