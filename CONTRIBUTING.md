# Contributing

Thank you for helping improve Visual-First PPT. Keep changes small, testable, and safe for a public repository.

## Public-data boundary

Use synthetic fixtures and neutral examples. Never commit customer materials, private presentation content, generated customer deliverables, raw agent logs, credentials, or machine-specific paths.

Do not include tokens, passwords, account identifiers, personal absolute paths, or customer decks.

## Branch and change scope

- Use a focused `codex/*` feature branch.
- Keep one concern per change and avoid unrelated formatting rewrites.
- Treat generated archives and local diagnostic output as disposable; do not add them to source control.
- Update tests before implementation when behavior changes.

## Local validation

Create the development environment once:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

Run the deterministic test suites:

```bash
node --test tests/unit/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests/unit -p 'test_*.py' -v
```

Run the public-candidate audit and official validators before requesting review:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python scripts/audit_public_candidate.py --root . --candidate tracked

SKILL_CREATOR="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator"
.venv/bin/python "$SKILL_CREATOR/scripts/quick_validate.py" skills/visual-first-ppt

PLUGIN_CREATOR="${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator"
.venv/bin/python "$PLUGIN_CREATOR/scripts/validate_plugin.py" .
```

Finish with `git diff --check` and review every changed file for private data.

## Authorization gates

The controlled maintainer workflow treats every action below as an independent gate:

- **Local edit:** permission to change local files does not authorize source-control or publication actions.
- **Commit:** requires explicit authorization and includes an appropriate changelog update.
- **Push:** requires explicit authorization after the local commit has been reviewed.
- **Pull request:** requires explicit authorization and must record scope and validation evidence.
- **Marketplace:** registration or submission requires separate explicit authorization.
- **Tag:** creating or moving a tag requires separate explicit authorization.
- **Release:** publishing a release or its artifacts requires separate explicit authorization.
- **Installation:** a real Skill or Plugin install requires separate explicit authorization and is never a repository test step.

Do not infer a later gate from approval of an earlier one. External contributors may work in repositories they control and propose a reviewable change, but only project maintainers with explicit authorization decide whether repository changes are accepted or published.

Ordinary contributors do not publish releases, Marketplace entries, tags, or distribution artifacts.

## Review expectations

A review request should summarize scope, list changed files, record the exact validation commands and results, and call out any remaining limitation. Security reports must use the private path in [SECURITY.md](SECURITY.md), not a contribution branch or public issue.
