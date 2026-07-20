import crypto from "node:crypto";

const VISUAL_APPROVAL_ROUTES = new Set(["create", "template"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function visualContractProjection(themeLock) {
  if (!themeLock || typeof themeLock !== "object" || Array.isArray(themeLock)) {
    throw new Error("themeLock must be an object for visual contract hashing");
  }
  const projection = JSON.parse(JSON.stringify(themeLock));
  delete projection.approval;
  delete projection.approvalHash;
  return projection;
}

export function visualContractHash(themeLock) {
  return `sha256:${crypto.createHash("sha256")
    .update(stableJson(visualContractProjection(themeLock)), "utf8")
    .digest("hex")}`;
}

export function assertVisualContractApproval({
  themeLock,
  route,
  stateVisualApproval,
  label = "visual contract",
}) {
  const hash = visualContractHash(themeLock);
  if (!VISUAL_APPROVAL_ROUTES.has(route)) return hash;
  if (themeLock.approval?.approvedArtifactHash !== hash) {
    throw new Error(`${label} themeLock.approval.approvedArtifactHash must equal ${hash}`);
  }
  if (stateVisualApproval?.approvedArtifactHash !== hash) {
    throw new Error(`${label} state visual approval must equal ${hash}`);
  }
  return hash;
}
