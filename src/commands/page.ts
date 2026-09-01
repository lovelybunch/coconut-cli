// coco page get | put | edit | versions | restore | links | delete
//
// Writes use the API's optimistic concurrency: put/edit read the current
// version first and send it as If-Match; a concurrent writer surfaces as a
// clear 412 conflict message (exit code 6), never a silent overwrite.

import type { Command } from "commander";
import { CocoNotFoundError } from "coconut-sdk";
import { editInEditor } from "../editor.js";
import { CliError, EXIT } from "../errors.js";
import { parseKeyValues } from "../kv.js";
import { foldLeadingFrontmatter } from "../markdown.js";
import { formatWhen } from "../output.js";
import type { Output } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import {
  attachGlobals,
  collect,
  contextFor,
  ellipsize,
  integer,
  readContent,
} from "./helpers.js";

/**
 * The REST surface stores `content` verbatim (no server-side fold), so the
 * CLI folds a leading flat `---` block into title/frontmatter before writing.
 */
export function foldForWrite(
  out: Output,
  markdown: string,
): { title?: string; frontmatter?: Record<string, unknown>; content: string } {
  const folded = foldLeadingFrontmatter(markdown);
  if (folded.unfoldedBlock) {
    out.warn(
      "Note: the leading --- block isn't flat `key: value` lines, so it is stored verbatim in the body. For nested structures (e.g. metadataSchema) use --frontmatter with one-line JSON.",
    );
  }
  return { title: folded.title, frontmatter: folded.frontmatter, content: folded.content };
}

function parseFrontmatterJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`--frontmatter is not valid JSON: ${(error as Error).message}`, EXIT.usage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("--frontmatter must be a JSON object.", EXIT.usage);
  }
  return parsed as Record<string, unknown>;
}

export function registerPageCommands(root: Command, runtime: CliRuntime): void {
  const page = root
    .command("page")
    .description("read, write, and inspect pages (shared spaces and personal/…)")
    .addHelpText(
      "after",
      [
        "",
        "Pages are addressed as <space>/<path> (e.g. deals/acme); the caller's",
        "private context is personal/<path>. Example:",
        "",
        "  coco page put deals/acme --title 'Acme' --template deal-memo \\",
        "    --metadata stage=sourcing --metadata conviction-score=0.4 < memo.md",
        "  coco page edit deals/acme     # $EDITOR round-trip with If-Match",
      ].join("\n"),
    );

  attachGlobals(
    page
      .command("get")
      .description("read a page as markdown (default) or the JSON envelope (--json)")
      .argument("<path>", "page path (<space>/<path>)")
      .option("--md", "markdown output (the default)")
      .option("--version <n>", "read a historical version", integer("--version")),
  ).action(async (path: string, options: { version?: number; md?: boolean }, command: Command) => {
    const context = contextFor(runtime, command);
    if (context.out.json && !options.md) {
      const result = await context.client.pages.get(path, { version: options.version });
      return context.out.emitJson(result);
    }
    const markdown = await context.client.pages.getMarkdown(path, { version: options.version });
    context.out.result(markdown.replace(/\n$/, ""));
  });

  attachGlobals(
    page
      .command("put")
      .description("create or update a page (body from --file or stdin)")
      .argument("<path>", "page path (<space>/<path>)")
      .option("-f, --file <file>", "markdown body file ('-' for stdin; piped stdin is read implicitly when creating)")
      .option("--title <title>", "page title")
      .option("--template <name>", "create-only: template to seed from (name or <space>/templates/<name>)")
      .option(
        "--metadata <k=v>",
        "metadata to set (repeatable; JSON values parsed, e.g. score=0.7)",
        collect,
        [],
      )
      .option(
        "--frontmatter <json>",
        'frontmatter as a JSON object (e.g. \'{"metadataSchema":{"fields":[...]}}\')',
      )
      .option("--note <note>", "revision note shown in the version history"),
  ).action(
    async (
      path: string,
      options: {
        file?: string;
        title?: string;
        template?: string;
        metadata: string[];
        frontmatter?: string;
        note?: string;
      },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const metadata =
        options.metadata.length > 0 ? parseKeyValues(options.metadata, "--metadata") : undefined;
      const flagFrontmatter = parseFrontmatterJson(options.frontmatter);

      const current = await context.client.pages.get(path).catch((error: unknown) => {
        if (error instanceof CocoNotFoundError) return null;
        throw error;
      });

      // Piped stdin is read implicitly only when the body is required to
      // proceed (creating without a template); use `--file -` elsewhere.
      const bodyRequired = current === null && options.template === undefined;
      const raw = await readContent(runtime, options.file, { implicitStdin: bodyRequired });
      const folded = raw === undefined ? undefined : foldForWrite(context.out, raw);
      const title = options.title ?? folded?.title;
      const frontmatter =
        flagFrontmatter || folded?.frontmatter
          ? { ...folded?.frontmatter, ...flagFrontmatter }
          : undefined;

      if (current === null) {
        if (folded === undefined && options.template === undefined) {
          throw new CliError(
            `"${path}" does not exist yet; creating it needs a body (--file, stdin) or a --template.`,
            EXIT.usage,
          );
        }
        const result = await context.client.pages.create(path, {
          title,
          frontmatter,
          content: folded?.content,
          template: options.template,
          metadata,
          note: options.note,
        });
        if (context.out.json) return context.out.emitJson(result);
        context.out.result(`Created ${result.path} (v${result.version}).`);
        return;
      }

      if (options.template !== undefined) {
        throw new CliError(
          `"${path}" already exists — --template only applies on create. Use --metadata / \`coco meta patch\` to change fields.`,
          EXIT.usage,
        );
      }
      if (folded === undefined && title === undefined && frontmatter === undefined && metadata === undefined) {
        throw new CliError(
          `"${path}" exists and nothing was given to change. Pass --file <f> (or --file - for stdin), --title, --frontmatter, or --metadata.`,
          EXIT.usage,
        );
      }
      const result = await context.client.pages.update(path, {
        title,
        frontmatter,
        content: folded?.content ?? current.content,
        note: options.note,
        expectedVersion: current.version,
      });
      // Update bodies don't carry metadata; changed fields ride a merge-patch.
      if (metadata) await context.client.pages.patchMetadata(path, { set: metadata });
      if (context.out.json) return context.out.emitJson(result);
      context.out.result(
        `Updated ${result.path} (v${current.version} → v${result.version})${metadata ? ", metadata patched" : ""}.`,
      );
    },
  );

  attachGlobals(
    page
      .command("edit")
      .description("edit a page in $EDITOR and save with optimistic concurrency")
      .argument("<path>", "page path (<space>/<path>)"),
  ).action(async (path: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    // Read the version first, then the markdown *of that version*, so the
    // If-Match write is anchored to exactly what was edited.
    const current = await context.client.pages.get(path);
    const markdown = await context.client.pages.getMarkdown(path, { version: current.version });
    const edited = editInEditor(runtime.env, markdown, path);
    if (!edited.changed) {
      context.out.info("No changes; nothing to update.");
      return;
    }
    // The served markdown starts with a rendered `---` block; fold it back
    // into title/frontmatter so it round-trips instead of nesting in content.
    const folded = foldForWrite(context.out, edited.content);
    const result = await context.client.pages.update(path, {
      title: folded.title,
      frontmatter: folded.frontmatter,
      content: folded.content,
      note: "Edited via coco CLI",
      expectedVersion: current.version,
    });
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(`Updated ${result.path} (v${current.version} → v${result.version}).`);
  });

  attachGlobals(
    page
      .command("versions")
      .description("revision history, newest first")
      .argument("<path>", "page path (<space>/<path>)"),
  ).action(async (path: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.pages.versions(path);
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((version) => ({
        v: `${version.version}${version.isLatest ? "*" : ""}`,
        title: version.title,
        author: version.authorLabel,
        note: ellipsize(version.note ?? "", 48),
        created: formatWhen(version.createdAt),
      })),
    );
  });

  attachGlobals(
    page
      .command("restore")
      .description("promote a historical version to latest (as a new revision)")
      .argument("<path>", "page path (<space>/<path>)")
      .argument("<version>", "version number to restore"),
  ).action(async (path: string, version: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const versionNumber = Number(version);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new CliError(`"${version}" is not a version number.`, EXIT.usage);
    }
    const result = await context.client.pages.makeLatest(path, versionNumber);
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(`Restored ${result.path} v${result.sourceVersion} as v${result.version}.`);
  });

  attachGlobals(
    page
      .command("links")
      .description("outbound links (broken targets flagged) and backlinks")
      .argument("<path>", "page path (<space>/<path>)"),
  ).action(async (path: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.pages.links(path);
    if (context.out.json) return context.out.emitJson(result);
    context.out.info(`Outbound (${result.outbound.length}):`);
    context.out.table(
      result.outbound.map((link) => ({
        target: link.targetPath,
        ok: link.targetExists ? "yes" : "BROKEN",
        anchor: ellipsize(link.anchorText, 40),
      })),
    );
    context.out.info(`Backlinks (${result.backlinks.length}):`);
    context.out.table(
      result.backlinks.map((link) => ({
        source: link.sourcePath,
        title: link.sourceTitle,
        anchor: ellipsize(link.anchorText, 40),
      })),
    );
  });

  attachGlobals(
    page
      .command("delete")
      .description("delete a personal page (the API allows no other deletion)")
      .argument("<path>", "personal page path (personal/<path>)"),
  ).action(async (path: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    if (!path.startsWith("personal/")) {
      throw new CliError(
        "Only personal pages can be deleted (shared-page history is immutable). Address them as personal/<path>.",
        EXIT.usage,
      );
    }
    const result = await context.client.personal.delete(path.slice("personal/".length));
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(`Deleted ${path}.`);
  });
}
