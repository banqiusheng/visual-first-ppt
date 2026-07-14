#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  initProject,
  transitionProject,
  validateProject,
} from "../../../skills/visual-first-ppt/scripts/project-state.mjs";

function usage() {
  return [
    "Usage:",
    "  state-driver.mjs init WORKSPACE ROUTE TITLE [INPUT_HASHES_JSON]",
    "  state-driver.mjs transition WORKSPACE TARGET [APPROVAL_JSON]",
    "  state-driver.mjs validate WORKSPACE",
  ].join("\n");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const [workspace, route, title, inputHashesPath] = args;
    if (!workspace || !route || !title) throw new Error(usage());
    const inputHashes = inputHashesPath ? await readJson(inputHashesPath) : {};
    const result = await initProject({ workspace, route, title, inputHashes });
    console.log(JSON.stringify({ projectId: result.projectId, status: result.state.status }));
    return;
  }

  if (command === "transition") {
    const [workspace, to, approvalPath] = args;
    if (!workspace || !to) throw new Error(usage());
    const approval = approvalPath ? await readJson(approvalPath) : undefined;
    const state = await transitionProject({ workspace, to, approval });
    console.log(JSON.stringify({ projectId: state.projectId, status: state.status }));
    return;
  }

  if (command === "validate") {
    const [workspace] = args;
    if (!workspace) throw new Error(usage());
    console.log(JSON.stringify(await validateProject(workspace)));
    return;
  }

  throw new Error(usage());
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
