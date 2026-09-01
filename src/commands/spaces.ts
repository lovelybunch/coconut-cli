// coco spaces list | pages | export | import | broken-links

import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { SpaceExportBundle } from "coconut-sdk";
import { CliError, EXIT } from "../errors.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor, ellipsize, integer } from "./helpers.js";

export function registerSpacesCommands(root: Command, runtime: CliRuntime): void {
  const spaces = root
    .command("spaces")
    .description("spaces: listings, per-space pages, export/import bundles, link health")
    .addHelpText(
      "after",
      "\nExample:\n  coco spaces export deals -o deals.json && coco spaces import staging-deals deals.json",
    );

  attachGlobals(
    spaces
      .command("list")
      .description("spaces visible to the credential")
      .option("--stats", "include readable-page counts and last-updated times"),
  ).action(async (options: { stats?: boolean }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.spaces.list({ includeStats: options.stats });
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((space) => ({
        slug: space.slug,
        name: space.name,
        visibility: space.visibility ?? "",
        ...(options.stats
          ? { pages: space.pageCount ?? 0, updated: formatWhen(space.lastUpdatedAt) }
          : {}),
        description: ellipsize(space.description, 48),
      })),
    );
  });

  attachGlobals(
    spaces
      .command("pages")
      .description("ACL-visible pages of one space")
      .argument("<space>", "space slug"),
  ).action(async (space: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.spaces.pages(space);
    if (context.out.json) return context.out.emitJson(result);
    context.out.info(`${result.spaceName} (${result.space}) — ${result.items.length} pages`);
    context.out.table(
      result.items.map((page) => ({
        path: page.path,
        title: page.title,
        v: page.version,
        updated: formatWhen(page.updatedAt),
      })),
    );
  });

  attachGlobals(
    spaces
      .command("export")
      .description("export a space as a portable coco-space-export JSON bundle")
      .argument("<space>", "space slug")
      .option("-o, --output <file>", "write the bundle to a file instead of stdout"),
  ).action(async (space: string, options: { output?: string }, command: Command) => {
    const context = contextFor(runtime, command);
    const bundle = await context.client.spaces.export(space);
    if (options.output) {
      writeFileSync(options.output, `${JSON.stringify(bundle, null, 2)}\n`);
      context.out.info(`Exported ${bundle.pages.length} pages from "${space}" to ${options.output}.`);
    } else {
      context.out.emitJson(bundle);
    }
  });

  attachGlobals(
    spaces
      .command("import")
      .description("import a coco-space-export bundle into a space")
      .argument("<space>", "target space slug")
      .argument("<bundle>", "bundle file (from `coco spaces export`)")
      .option("--overwrite", "write new revisions over existing pages (default: skip them)"),
  ).action(async (space: string, bundlePath: string, options: { overwrite?: boolean }, command: Command) => {
    const context = contextFor(runtime, command);
    let bundle: SpaceExportBundle;
    try {
      bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as SpaceExportBundle;
    } catch (error) {
      throw new CliError(`Could not read ${bundlePath}: ${(error as Error).message}`, EXIT.usage);
    }
    if (bundle?.format !== "coco-space-export") {
      throw new CliError(
        `${bundlePath} is not a coco-space-export bundle (want the output of \`coco spaces export\`).`,
        EXIT.usage,
      );
    }
    const result = await context.client.spaces.import(space, bundle, {
      mode: options.overwrite ? "overwrite" : "skip",
    });
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(
      `Imported into "${result.space}" (${result.mode}): ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
    );
    for (const failure of result.errors) {
      context.out.warn(`  failed ${failure.path}: ${failure.error}`);
    }
    if (result.errors.length > 0) {
      throw new CliError(`${result.errors.length} pages failed to import.`, EXIT.unexpected);
    }
  });

  attachGlobals(
    spaces
      .command("broken-links")
      .description("stored links in the space whose target page doesn't exist")
      .argument("<space>", "space slug")
      .option("--limit <n>", "max rows", integer("--limit")),
  ).action(async (space: string, options: { limit?: number }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.spaces.brokenLinks(space, { limit: options.limit });
    if (context.out.json) return context.out.emitJson(result);
    if (result.items.length === 0) {
      context.out.result(`No broken links in "${space}".`);
      return;
    }
    context.out.table(
      result.items.map((link) => ({
        source: link.sourcePath,
        "broken target": link.targetPath,
        anchor: ellipsize(link.anchorText, 40),
      })),
    );
  });
}
