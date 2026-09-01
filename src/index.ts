#!/usr/bin/env node
// coco — command-line client for the Coco (Coconut Context) HTTP API.
// The documented contract lives in openapi.yaml at the repository root; all API
// calls go through coconut-sdk.

import { runCli } from "./program.js";
import { createDefaultRuntime } from "./runtime.js";

// A closed pipe (e.g. `coco … | head`) is a normal way to stop reading, not
// a crash. Swallow EPIPE on the standard streams and end quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

const exitCode = await runCli(createDefaultRuntime(), process.argv.slice(2));
process.exitCode = exitCode;
