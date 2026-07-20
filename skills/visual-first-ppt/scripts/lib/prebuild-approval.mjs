import crypto from "node:crypto";

const STRICT_SHA256 = /^sha256:[0-9a-f]{64}$/;
const PREBUILD_READY_STATUSES = Object.freeze({
  create: new Set(["VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW", "DELIVERED"]),
  template: new Set(["VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW", "DELIVERED"]),
  edit: new Set(["CHANGE_PREVIEW", "BUILDING", "QA", "FINAL_REVIEW", "DELIVERED"]),
});
const BLOCKABLE_PREBUILD_STATUSES = Object.freeze({
  create: new Set(["VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW"]),
  template: new Set(["VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW"]),
  edit: new Set(["CHANGE_PREVIEW", "BUILDING", "QA", "FINAL_REVIEW"]),
});
const BLOCKED_STATUS_FOR_ROUTE = Object.freeze({
  create: "BLOCKED_SOURCE",
  template: "BLOCKED_SOURCE",
  edit: "BLOCKED_COMPATIBILITY",
});
const APPROVAL_KEYS = new Set(["outline", "visual", "scope", "diffPreview", "final"]);
const APPROVAL_KEYS_BY_ROUTE = Object.freeze({
  create: new Set(["outline", "visual", "final"]),
  template: new Set(["outline", "visual", "final"]),
  edit: new Set(["scope", "diffPreview", "final"]),
});

export function normalizeApprovalReason(reason) {
  return String(reason).trim().replace(/\s+/g, " ");
}

export function diffPreviewApprovalHash(approval, { required = false } = {}) {
  if (approval !== undefined
    && (!approval || typeof approval !== "object" || Array.isArray(approval))) {
    throw new Error("diff-preview approval requires approvedArtifactHash or notApplicableReason");
  }
  const hasHashField = approval !== undefined && Object.hasOwn(approval, "approvedArtifactHash");
  const hasReasonField = approval !== undefined && Object.hasOwn(approval, "notApplicableReason");
  if (hasHashField
    && (typeof approval.approvedArtifactHash !== "string"
      || !STRICT_SHA256.test(approval.approvedArtifactHash))) {
    throw new Error("diff-preview approvedArtifactHash must be a lowercase SHA-256 digest");
  }
  if (hasReasonField
    && (typeof approval.notApplicableReason !== "string"
      || approval.notApplicableReason.trim() === "")) {
    throw new Error("diff-preview notApplicableReason must be a nonempty string");
  }
  const hasHash = hasHashField;
  const hasReason = hasReasonField;
  if (hasHash && hasReason) {
    throw new Error("diff-preview approval must use approvedArtifactHash or notApplicableReason, not both");
  }
  if (hasHash) {
    return approval.approvedArtifactHash;
  }
  if (hasReason) {
    return `sha256:${crypto.createHash("sha256")
      .update(normalizeApprovalReason(approval.notApplicableReason), "utf8")
      .digest("hex")}`;
  }
  if (required || approval !== undefined) {
    throw new Error("diff-preview approval requires approvedArtifactHash or notApplicableReason");
  }
  return undefined;
}

function effectivePrebuildStatus(state) {
  const allowed = PREBUILD_READY_STATUSES[state?.route];
  if (!allowed) {
    throw new Error(`unsupported prebuild route: ${String(state?.route)}`);
  }
  const blockedStatuses = new Set(["BLOCKED_SOURCE", "BLOCKED_COMPATIBILITY"]);
  if (!blockedStatuses.has(state.status)) {
    if (!allowed.has(state.status)) {
      throw new Error(
        `prebuild status ${String(state.status)} is outside the build boundary for route ${state.route}`,
      );
    }
    if (state.blockedFrom !== undefined) {
      throw new Error(`blockedFrom is not allowed on non-blocked prebuild status ${state.status}`);
    }
    if (state.blockers !== undefined
      && (!Array.isArray(state.blockers) || state.blockers.length > 0)) {
      throw new Error(`active blockers are not allowed on non-blocked prebuild status ${state.status}`);
    }
    return state.status;
  }

  const expectedBlockedStatus = BLOCKED_STATUS_FOR_ROUTE[state.route];
  if (state.status !== expectedBlockedStatus) {
    throw new Error(
      `blocked route ${state.route} requires blocker type ${expectedBlockedStatus}, received ${state.status}`,
    );
  }
  if (!BLOCKABLE_PREBUILD_STATUSES[state.route].has(state.blockedFrom)) {
    throw new Error(
      `blockedFrom ${String(state.blockedFrom)} is not a legal prebuild state for route ${state.route}`,
    );
  }
  if (!Array.isArray(state.blockers) || state.blockers.length === 0
    || state.blockers.some((blocker) => blocker?.type !== expectedBlockedStatus)) {
    throw new Error(
      `blocked route ${state.route} requires an active ${expectedBlockedStatus} blocker`,
    );
  }
  return state.blockedFrom;
}

export function currentPrebuildApprovalHashes(state, prospectiveDiffPreview) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("state is required to resolve prebuild approval hashes");
  }
  const effectiveStatus = effectivePrebuildStatus(state);
  if (prospectiveDiffPreview !== undefined
    && (state.route !== "edit" || effectiveStatus !== "CHANGE_PREVIEW")) {
    throw new Error("prospectiveDiffPreview is allowed only for edit/CHANGE_PREVIEW");
  }
  const approvals = state.approvals;
  if (!approvals || typeof approvals !== "object" || Array.isArray(approvals)) {
    throw new Error("state.approvals must be an object for prebuild approval binding");
  }
  const allowedApprovalKeys = APPROVAL_KEYS_BY_ROUTE[state.route];
  for (const key of Object.keys(approvals)) {
    if (!APPROVAL_KEYS.has(key)) {
      throw new Error(`unknown prebuild approval key ${key}`);
    }
    if (!allowedApprovalKeys.has(key)) {
      throw new Error(`${key} approval is not allowed for route ${state.route}`);
    }
  }
  const hashes = {};
  for (const [key, value] of Object.entries(approvals)) {
    if (["final", "diffPreview"].includes(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${key} approval approvedArtifactHash must be a lowercase SHA-256 digest`);
    }
    const hash = value.approvedArtifactHash;
    if (typeof hash !== "string" || !STRICT_SHA256.test(hash)) {
      throw new Error(`${key} approval approvedArtifactHash must be a lowercase SHA-256 digest`);
    }
    hashes[key] = hash;
  }

  for (const required of state.route === "edit" ? ["scope"] : ["outline", "visual"]) {
    if (!Object.hasOwn(hashes, required)) {
      throw new Error(`${required} approval is required before prebuild PASS`);
    }
  }

  const diffPreview = prospectiveDiffPreview !== undefined
    ? prospectiveDiffPreview
    : approvals.diffPreview;
  const binding = diffPreviewApprovalHash(diffPreview, {
    required: state.route === "edit",
  });
  if (binding) hashes.diffPreview = binding;
  return hashes;
}
