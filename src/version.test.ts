// `coco --version` prints CLI_VERSION, and the published package carries the
// version in package.json. The two are bumped together by
// scripts/mirror/bump-version.mjs; this pins them so a hand edit to one
// cannot ship a binary that reports a different version from its tarball.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "./program.js";

describe("CLI_VERSION", () => {
  it("matches the package.json version", () => {
    const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
    expect(CLI_VERSION).toBe(manifest.version);
  });
});
