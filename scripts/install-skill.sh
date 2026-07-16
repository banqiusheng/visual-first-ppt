#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  printf '%s\n' 'UNSUPPORTED_ARGUMENTS: this installer accepts no arguments.' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE_SKILL="$REPOSITORY_ROOT/skills/visual-first-ppt"

if [[ ! -f "$SOURCE_SKILL/SKILL.md" ]]; then
  printf '%s\n' "INVALID_SOURCE: missing $SOURCE_SKILL/SKILL.md" >&2
  exit 4
fi

if [[ -n "${VISUAL_FIRST_PPT_SKILLS_DIR:-}" ]]; then
  SKILLS_ROOT="$VISUAL_FIRST_PPT_SKILLS_DIR"
elif [[ -n "${CODEX_HOME:-}" ]]; then
  SKILLS_ROOT="$CODEX_HOME/skills"
elif [[ -n "${HOME:-}" ]]; then
  SKILLS_ROOT="$HOME/.codex/skills"
else
  printf '%s\n' 'INVALID_TARGET: HOME is not set.' >&2
  exit 2
fi

DESTINATION="$SKILLS_ROOT/visual-first-ppt"

if ! mkdir -p "$SKILLS_ROOT"; then
  printf '%s\n' "INSTALLATION_FAILED: cannot create target root $SKILLS_ROOT" >&2
  exit 5
fi

if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  printf '%s\n' "EXISTING_INSTALLATION: $DESTINATION already exists; nothing was changed." >&2
  exit 3
fi

if ! mkdir "$DESTINATION"; then
  if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
    printf '%s\n' "EXISTING_INSTALLATION: $DESTINATION appeared during installation; nothing was changed." >&2
    exit 3
  fi
  printf '%s\n' "INSTALLATION_FAILED: cannot acquire target $DESTINATION" >&2
  exit 5
fi

destination_owned=1
cleanup_incomplete_destination() {
  local status=$?
  trap - EXIT
  if (( destination_owned == 1 )); then
    if ! rm -rf -- "$DESTINATION"; then
      printf '%s\n' "CLEANUP_FAILED: remove the incomplete target manually: $DESTINATION" >&2
    fi
  fi
  exit "$status"
}
trap cleanup_incomplete_destination EXIT

cp -R "$SOURCE_SKILL/." "$DESTINATION/"

if [[ ! -f "$DESTINATION/SKILL.md" ]]; then
  printf '%s\n' "INVALID_INSTALLATION: copied target is missing $DESTINATION/SKILL.md" >&2
  exit 5
fi

set +e
DOCTOR_OUTPUT="$(
  CODEX_HOME="" node "$DESTINATION/scripts/doctor.mjs" \
    --skill-root "$DESTINATION" \
    --json 2>&1
)"
DOCTOR_STATUS=$?
set -e

DOCTOR_EVIDENCE_VALID=0
if (( DOCTOR_STATUS == 0 || DOCTOR_STATUS == 2 )); then
  if printf '%s' "$DOCTOR_OUTPUT" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let evidence;
  try {
    evidence = JSON.parse(input);
  } catch {
    process.exitCode = 1;
    return;
  }

  const isObject = evidence !== null
    && typeof evidence === "object"
    && !Array.isArray(evidence);
  const checks = isObject && Array.isArray(evidence.checks)
    ? evidence.checks
    : null;
  const expectedStatus = process.argv[1] === "0" ? "PASS" : "WARN";
  const requiredCheckIds = ["skill-files", "node", "python"];
  const hasRequiredChecks = checks !== null && requiredCheckIds.every(
    (id) => checks.some(
      (check) => check !== null
        && typeof check === "object"
        && !Array.isArray(check)
        && check.id === id
        && check.status === "PASS",
    ),
  );
  const hasFailure = checks !== null && checks.some(
    (check) => check !== null
      && typeof check === "object"
      && !Array.isArray(check)
      && check.status === "FAIL",
  );

  if (!isObject
    || checks === null
    || evidence.status !== expectedStatus
    || !hasRequiredChecks
    || hasFailure) {
    process.exitCode = 1;
  }
});
' "$DOCTOR_STATUS"; then
    DOCTOR_EVIDENCE_VALID=1
  fi
fi

if (( DOCTOR_EVIDENCE_VALID != 1 )); then
  printf '%s\n' "$DOCTOR_OUTPUT" >&2
  printf '%s\n' \
    "INSTALLATION_VERIFICATION_FAILED: doctor rejected the copied target $DESTINATION" >&2
  exit 5
fi

destination_owned=0
trap - EXIT

printf '%s\n' "$DOCTOR_OUTPUT"
printf '%s\n' "INSTALLED_FILES_VERIFIED: $DESTINATION"
printf '%s\n' "DOCTOR_EXIT_CODE: $DOCTOR_STATUS"
if (( DOCTOR_STATUS == 2 )); then
  printf '%s\n' \
    'CAPABILITIES_UNCONFIRMED: required local files passed, but optional production capabilities were not exposed.'
fi
printf '%s\n' \
  'SETUP_VERIFICATION_REQUIRED: activation must still be confirmed in Codex; this script does not claim SETUP_VERIFIED.'
printf '%s\n' 'NEXT_STEP: in your next Codex turn, explicitly invoke $visual-first-ppt.'
printf '%s\n' 'If the Skill is not discovered on that next turn, start a new Codex task.'
