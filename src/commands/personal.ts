// coco personal list | get | put | delete — the caller's private context.
// Paths here are relative to the personal space (notes/today, not
// personal/notes/today); `coco page …` accepts the personal/ prefix too.

import type { Command } from "commander";
import { CocoNotFoundError } from "coconut-sdk";
import { CliError, EXIT } from "../errors.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor, integer, readContent } from "./helpers.js";
import { foldForWrite } from "./page.js";

export function registerPersonalCommands(root: Command, runtime: CliRuntime): void {
  const personal = root
    .command("personal")
    .description("your private context (paths relative to the personal space)")
    .addHelpText(
      "after",
      "\nExample:\n  echo '# Today' | coco personal put notes/today --title Today",
    );

  attachGlobals(personal.command("list").description("list your personal pages")).action(
    async (_options, command: Command) => {
      const context = contextFor(runtime, command);
      const result = await context.client.personal.list();
      if (context.out.json) return context.out.emitJson(result);
      context.out.table(
        result.items.map((page) => ({
          path: page.path,
          title: page.title,
          v: page.version,
          updated: formatWhen(page.updatedAt),
        })),
      );
    },
  );

  attachGlobals(
    personal
      .command("get")
      .description("read one personal page as markdown (--json for the envelope)")
      .argument("<path>", "path relative to the personal space (e.g. notes/today)")
      .option("--version <n>", "read a historical version", integer("--version")),
  ).action(async (path: string, options: { version?: number }, command: Command) => {
    const context = contextFor(runtime, command);
    if (context.out.json) {
      const result = await context.client.personal.get(path, { version: options.version });
      return context.out.emitJson(result);
    }
    const markdown = await context.client.personal.getMarkdown(path, { version: options.version });
    context.out.result(markdown.replace(/\n$/, ""));
  });

  attachGlobals(
    personal
      .command("put")
      .description("create or update a personal page (body from --file or stdin)")
      .argument("<path>", "path relative to the personal space")
      .option("-f, --file <file>", "markdown body ('-' for stdin; piped stdin is read implicitly when creating)")
      .option("--title <title>", "page title"),
  ).action(async (path: string, options: { file?: string; title?: string }, command: Command) => {
    const context = contextFor(runtime, command);
    const current = await context.client.personal.get(path).catch((error: unknown) => {
      if (error instanceof CocoNotFoundError) return null;
      throw error;
    });
    // Implicit piped stdin only when the body is required (creating).
    const raw = await readContent(runtime, options.file, { implicitStdin: current === null });
    if (current === null && raw === undefined) {
      throw new CliError(`"${path}" does not exist yet; creating it needs a body (--file or stdin).`, EXIT.usage);
    }
    if (current !== null && raw === undefined && options.title === undefined) {
      throw new CliError(
        `"${path}" exists and nothing was given to change. Pass --file <f> (or --file - for stdin) or --title.`,
        EXIT.usage,
      );
    }
    const folded = raw === undefined ? undefined : foldForWrite(context.out, raw);
    const result = await context.client.personal.write(path, {
      title: options.title ?? folded?.title,
      frontmatter: folded?.frontmatter,
      content: folded?.content ?? (current as { content: string }).content,
      expectedVersion: current?.version,
    });
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(
      current === null
        ? `Created personal/${path} (v${result.version}).`
        : `Updated personal/${path} (v${current.version} → v${result.version}).`,
    );
  });

  attachGlobals(
    personal
      .command("delete")
      .description("permanently delete a personal page")
      .argument("<path>", "path relative to the personal space"),
  ).action(async (path: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.personal.delete(path);
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(`Deleted personal/${path}.`);
  });
}
