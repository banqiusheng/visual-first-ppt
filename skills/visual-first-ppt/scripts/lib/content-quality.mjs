import crypto from "node:crypto";
import fs from "node:fs/promises";

export function normalizeCriticalText(text) {
  return String(text)
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertNativeCriticalContent(items) {
  if (!Array.isArray(items)) {
    throw new Error("nativeCriticalContent must be an array");
  }
  const contentIds = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("every nativeCriticalContent item must be an object");
    }
    if (typeof item.contentId !== "string" || !item.contentId.trim()) {
      throw new Error("nativeCriticalContent contentId must be a nonempty string");
    }
    if (contentIds.has(item.contentId)) {
      throw new Error("nativeCriticalContent contentId values must be unique");
    }
    contentIds.add(item.contentId);
    if (typeof item.text !== "string" || !item.text.trim()) {
      throw new Error("nativeCriticalContent text must be a nonempty string");
    }
    if (item.objectId !== undefined
      && (typeof item.objectId !== "string"
        || !/^slide-[1-9][0-9]*:shape-[1-9][0-9]*$/.test(item.objectId))) {
      throw new Error("nativeCriticalContent objectId must bind a canonical OOXML object");
    }
    if (item.typographyRole !== undefined
      && !["title", "body", "caption", "source", "pageNumber"].includes(item.typographyRole)) {
      throw new Error("nativeCriticalContent typographyRole is unsupported");
    }
  }
  return items;
}

export function criticalContentHash(items) {
  const canonical = [...assertNativeCriticalContent(items)]
    .map(({ contentId, text, objectId, typographyRole }) => [
      contentId,
      normalizeCriticalText(text),
      objectId ?? null,
      typographyRole ?? null,
    ])
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return `sha256:${crypto.createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
}

export async function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex")}`;
}
