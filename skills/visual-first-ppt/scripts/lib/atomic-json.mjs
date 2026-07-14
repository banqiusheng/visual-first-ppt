import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJsonAtomic(filePath, value) {
  const absolute = path.resolve(filePath);
  const parent = path.dirname(absolute);
  const temporary = `${absolute}.tmp-${process.pid}`;
  await fs.mkdir(parent, { recursive: true });

  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, absolute);
  return absolute;
}

export async function updateProjectIndex(indexPath, entry) {
  if (!entry || typeof entry.projectId !== "string" || entry.projectId === "") {
    throw new Error("Project index entry requires projectId");
  }
  if (typeof entry.workspace !== "string" || entry.workspace === "") {
    throw new Error("Project index entry requires workspace");
  }

  let index;
  try {
    index = await readJson(indexPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    index = {
      artifactType: "projectIndex",
      schemaVersion: "1.0.0",
      projects: [],
    };
  }

  const normalized = {
    ...entry,
    workspace: path.resolve(entry.workspace),
    finalOutputPath: entry.finalOutputPath ? path.resolve(entry.finalOutputPath) : null,
  };
  const projects = Array.isArray(index.projects)
    ? index.projects.filter((project) => project.projectId !== normalized.projectId)
    : [];
  projects.push(normalized);
  projects.sort((left, right) => left.projectId.localeCompare(right.projectId));
  const next = {
    artifactType: "projectIndex",
    schemaVersion: "1.0.0",
    projects,
  };
  await writeJsonAtomic(indexPath, next);
  return next;
}
