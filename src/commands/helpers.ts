// Shared command plumbing: every leaf command carries the global options
// (so `coco spaces list --json` works, not only `coco --json spaces list`),
// resolves its CommandContext from the merged flags, and reads free-form
// content from --file, `--file -`, or piped stdin.

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { createContext, type CommandContext, type GlobalOptions } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { readStdin } from "../prompt.js";
import type { CliRuntime } from "../runtime.js";

/** Adds the global options; called on the root and on every leaf command. */
export function attachGlobals(command: Command): Command {
  return command
    .option("--profile <name>", "config profile to use (default: the active profile)")
    .option("--base-url <url>", "API origin; beats COCO_BASE_URL and the profile")
    .option("--org-slug <slug>", "org context on multi-tenant deployments; beats COCO_ORG_SLUG")
    .option("--json", "print the raw API JSON on stdout, nothing else")
    .option("--quiet", "suppress informational messages on stderr");
}

/** The merged (leaf > root) global options of an invocation. */
export function globalsOf(command: Command): GlobalOptions {
  const merged = command.optsWithGlobals() as Record<string, unknown>;
  return {
    profile: merged.profile as string | undefined,
    baseUrl: merged.baseUrl as string | undefined,
    orgSlug: merged.orgSlug as string | undefined,
    json: merged.json === true,
    quiet: merged.quiet === true,
  };
}

export function contextFor(runtime: CliRuntime, command: Command): CommandContext {
  return createContext(runtime, globalsOf(command));
}

/** Commander accumulator for repeatable flags (`--filter a --filter b`). */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Commander parser for numeric option values. */
export function integer(flag: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new CliError(`${flag} expects a non-negative integer, got "${value}".`, EXIT.usage);
    }
    return parsed;
  };
}

/**
 * Content for put-style commands: --file <path> or `--file -` for stdin.
 * When `implicitStdin` is set (the command cannot proceed without content),
 * a non-TTY stdin is read even without `--file -`, so piping "just works".
 * Commands where content is optional must NOT set it — blocking on an open
 * but silent stdin (a script that didn't redirect) would hang them.
 */
export async function readContent(
  runtime: CliRuntime,
  file: string | undefined,
  options: { implicitStdin?: boolean } = {},
): Promise<string | undefined> {
  if (file === "-") return readStdin(runtime);
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new CliError(`Could not read ${file}: ${(error as Error).message}`, EXIT.usage);
    }
  }
  if (options.implicitStdin && runtime.stdin.isTTY !== true) {
    const piped = await readStdin(runtime);
    return piped === "" ? undefined : piped;
  }
  return undefined;
}

/** Truncates long free-text cells so tables stay one line per row. */
export function ellipsize(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
