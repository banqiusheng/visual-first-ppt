import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(HERE, "../../assets/quality-contract.json");
const LAYOUTS_PATH = path.resolve(HERE, "../../assets/layout-archetypes.json");
const THEMES_PATH = path.resolve(HERE, "../../assets/theme-catalog.json");

export async function loadQualityContract() {
  const value = JSON.parse(await fs.readFile(CONTRACT_PATH, "utf8"));
  if (value.artifactType !== "qualityContract" || value.qualityContractVersion !== "1.0.0") {
    throw new Error("Unsupported visual quality contract");
  }
  return Object.freeze(value);
}

export async function loadLayoutArchetypes() {
  const value = JSON.parse(await fs.readFile(LAYOUTS_PATH, "utf8"));
  if (value.artifactType !== "layoutArchetypeCatalog" || value.grid?.columns !== 12) {
    throw new Error("Unsupported layout archetype catalog");
  }
  return Object.freeze(value);
}

export async function loadThemeCatalog() {
  const value = JSON.parse(await fs.readFile(THEMES_PATH, "utf8"));
  if (value.artifactType !== "themeCatalog"
    || value.schemaVersion !== "1.0.0"
    || !Array.isArray(value.themes)
    || value.themes.length === 0) {
    throw new Error("Unsupported theme catalog");
  }
  return Object.freeze(value);
}
