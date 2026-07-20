#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { readJson } from "./lib/atomic-json.mjs";
import { validateCurrentQaReport } from "./lib/current-qa.mjs";

const HELP = [
  "Usage: validate-current-qa.mjs --qa-report FILE [--workspace DIRECTORY]",
  "",
  "Read and validate one qaReportCurrent without modifying project or evidence files.",
].join("\n");

function parseArgs(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("All CLI arguments must use --name value pairs");
    }
    result[flag.slice(2)] = value;
  }
  return result;
}

export async function runCurrentQaValidatorCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return { help: true };
  }
  const reportPath = path.resolve(args["qa-report"] || "");
  if (!args["qa-report"]) throw new Error("--qa-report is required");
  const report = await readJson(reportPath);
  const result = await validateCurrentQaReport({
    report,
    reportPath,
    ...(args.workspace ? { workspace: path.resolve(args.workspace) } : {}),
  });
  console.log(`CURRENT_QA_VALID ${reportPath}`);
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCurrentQaValidatorCli(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
