#!/usr/bin/env node
// Seal the release tarball and prove it holds only what the synced source
// says it should. The mirror's release workflow runs this right after the
// build, before tests or anything else from the dependency tree executes:
// the tree must still be exactly the synced commit (nothing modified,
// nothing added but the ignored build output), and the tarball may contain
// only the manifest, the README, the license files and dist/.
//
// Zero dependencies — Node >= 20, git and npm on PATH.
//
//   node scripts/verify-pack.mjs <destination dir>

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Files npm always includes, besides the build output. */
export const ALLOWED_FILES = new Set(["package.json", "README.md", "LICENSE", "NOTICE"]);
/** Without these the tarball is not this package. */
export const REQUIRED_FILES = ["package.json", "README.md", "dist/index.js"];

/** Paths in the tarball that are neither allowed nor under dist/. */
export function unexpectedFiles(paths) {
  return paths.filter((path) => !ALLOWED_FILES.has(path) && !path.startsWith("dist/"));
}

/** Required paths the tarball lacks. */
export function missingFiles(paths) {
  return REQUIRED_FILES.filter((required) => !paths.includes(required));
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

function main() {
  const destination = resolve(process.argv[2] ?? "pack");
  const dirty = run("git", ["status", "--porcelain"]).trim();
  if (dirty) {
    throw new Error(
      `the working tree changed during the build; a release builds only the ignored dist/:\n${dirty}`,
    );
  }
  mkdirSync(destination, { recursive: true });
  const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", destination]));
  const paths = info.files.map((file) => file.path);
  const unexpected = unexpectedFiles(paths);
  if (unexpected.length > 0) {
    throw new Error(`the tarball contains files it must not: ${unexpected.join(", ")}`);
  }
  const missing = missingFiles(paths);
  if (missing.length > 0) {
    throw new Error(`the tarball lacks: ${missing.join(", ")}`);
  }
  console.log(`${info.filename}: ${paths.length} files, ${info.integrity}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`verify-pack failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
