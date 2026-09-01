// The CLI's seam to the outside world: environment, fetch, streams, browser
// launching, and time. Commands never touch process.* or globalThis.fetch
// directly — everything flows through a CliRuntime so tests can inject a mock
// fetch, a fake environment, and captured output streams.

import { spawn } from "node:child_process";
import type { FetchLike } from "coconut-sdk";

export interface CliRuntime {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Opens the system browser at a URL; failure is non-fatal (URL is printed). */
  openBrowser: (url: string) => Promise<boolean>;
  now: () => number;
}

/** Only web URLs may reach the platform opener — never file:, javascript:, … */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Opens a URL with the platform opener; resolves false if that fails (the
 * caller prints the URL either way). Refuses non-http(s) URLs, and never
 * routes the URL through a shell: on Windows `cmd /c start` would let
 * cmd.exe metacharacters (| > < & ^) in a hostile URL execute commands, so
 * the URL handler is invoked via rundll32 instead.
 */
export async function openSystemBrowser(url: string): Promise<boolean> {
  if (!isOpenableUrl(url)) return false;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function createDefaultRuntime(): CliRuntime {
  const fetchImpl = globalThis.fetch as FetchLike | undefined;
  if (!fetchImpl) {
    throw new Error("This CLI requires Node.js >= 20 (global fetch is missing).");
  }
  return {
    env: process.env,
    fetch: (input, init) => fetchImpl(input, init),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    openBrowser: openSystemBrowser,
    now: () => Date.now(),
  };
}
