// Secret input that never touches argv: an interactive hidden prompt on a
// TTY, or piped stdin for scripts (`coco auth login --key < keyfile`).
// Also plain stdin reading for `--file -` style content input.

import { CliError, EXIT } from "./errors.js";
import type { CliRuntime } from "./runtime.js";

/** Reads all of stdin (piped input). */
export function readStdin(runtime: CliRuntime): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    runtime.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    runtime.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    runtime.stdin.on("error", reject);
  });
}

/**
 * Prompts for a secret with echo off (TTY), or reads stdin when piped.
 * The secret is trimmed of the trailing newline only.
 */
export async function promptSecret(runtime: CliRuntime, promptText: string): Promise<string> {
  if (!runtime.stdin.isTTY) {
    const piped = (await readStdin(runtime)).replace(/\r?\n$/, "");
    if (piped === "") {
      throw new CliError("No key on stdin. Pipe the key in, or run interactively.", EXIT.usage);
    }
    return piped;
  }

  runtime.stderr.write(promptText);
  const stdin = runtime.stdin as NodeJS.ReadStream;
  stdin.setRawMode?.(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let secret = "";
    const done = (error?: Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      runtime.stderr.write("\n");
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          // Ctrl-C
          done(new CliError("Aborted.", EXIT.unexpected));
          return;
        }
        if (char === "\r" || char === "\n") {
          done();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += char;
      }
    };
    stdin.on("data", onData);
  });
}
