#!/usr/bin/env node
// Wait until the coconut-sdk version this package depends on is on the npm
// registry. The SDK and the CLI are released together from the Coconut
// monorepo and published by their own repositories' workflows, so the CLI's
// install can race the SDK's publish by a few minutes; this closes the race
// without a token or a cross-repository trigger.
//
// Zero dependencies — Node >= 20 (global fetch).
//
//   node scripts/wait-for-sdk.mjs
//   WAIT_FOR_SDK_TIMEOUT_MS=600000 node scripts/wait-for-sdk.mjs

import { readFileSync } from "node:fs";

const PACKAGE = "coconut-sdk";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const range = manifest.dependencies?.[PACKAGE];
if (typeof range !== "string") {
  console.error(`package.json has no dependency on ${PACKAGE}`);
  process.exit(1);
}
// The sync pins a caret range on the exact version released alongside the CLI.
const version = range.replace(/^[\^~=]/, "");
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`cannot derive an exact version from the ${PACKAGE} range "${range}"`);
  process.exit(1);
}

const timeoutMs = Number(process.env.WAIT_FOR_SDK_TIMEOUT_MS ?? 15 * 60 * 1000);
const intervalMs = Number(process.env.WAIT_FOR_SDK_INTERVAL_MS ?? 20 * 1000);
const url = `https://registry.npmjs.org/${PACKAGE}/${version}`;
const deadline = Date.now() + timeoutMs;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (;;) {
  let status;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    status = response.status;
    if (response.ok) {
      console.log(`${PACKAGE}@${version} is on the registry.`);
      process.exit(0);
    }
  } catch (error) {
    status = error instanceof Error ? error.message : String(error);
  }
  if (Date.now() >= deadline) {
    console.error(`Gave up waiting for ${PACKAGE}@${version} (last response: ${status}).`);
    console.error("Has the coconut-sdk release of this version run? See CONTRIBUTING.md.");
    process.exit(1);
  }
  console.log(
    `${PACKAGE}@${version} not on the registry yet (${status}); retrying in ${intervalMs / 1000}s…`,
  );
  await sleep(intervalMs);
}
