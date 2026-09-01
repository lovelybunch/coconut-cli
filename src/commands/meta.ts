// coco meta get | patch | history — the structured-metadata rail. Patches
// are merge-patches: only the named keys change, no page revision is
// created, and `--set key=null` deletes a key.

import type { Command } from "commander";
import type { MetadataPatch } from "coconut-sdk";
import { CliError, EXIT } from "../errors.js";
import { parseKeyValues } from "../kv.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, collect, contextFor, ellipsize, integer } from "./helpers.js";

export function registerMetaCommands(root: Command, runtime: CliRuntime): void {
  const meta = root
    .command("meta")
    .description("page metadata: read, merge-patch, and audit history")
    .addHelpText(
      "after",
      [
        "",
        "Example:",
        "  coco meta patch deals/acme --set stage=diligence \\",
        "    --append-unique sources=https://news.example/acme",
        "  coco meta patch deals/acme --set flags=null    # null deletes the key",
      ].join("\n"),
    );

  attachGlobals(
    meta
      .command("get")
      .description("current metadata with per-key attribution")
      .argument("<path>", "page path (<space>/<path>)"),
  ).action(async (path: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.pages.getMetadata(path);
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.entries.map((entry) => ({
        key: entry.key,
        value: ellipsize(JSON.stringify(entry.value) ?? "", 48),
        "updated by": entry.updatedByLabel,
        updated: formatWhen(entry.updatedAt),
      })),
    );
  });

  attachGlobals(
    meta
      .command("patch")
      .description("merge-patch metadata (no page revision)")
      .argument("<path>", "page path (<space>/<path>)")
      .option("--set <k=v>", "upsert a key (JSON values parsed; null deletes)", collect, [])
      .option("--append <k=v>", "append a value to an array key", collect, [])
      .option("--append-unique <k=v>", "append only if not already present (idempotent)", collect, []),
  ).action(
    async (
      path: string,
      options: { set: string[]; append: string[]; appendUnique: string[] },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const patch: MetadataPatch = {};
      if (options.set.length > 0) patch.set = parseKeyValues(options.set, "--set");
      if (options.append.length > 0) patch.append = parseKeyValues(options.append, "--append");
      if (options.appendUnique.length > 0) {
        patch.appendUnique = parseKeyValues(options.appendUnique, "--append-unique");
      }
      if (!patch.set && !patch.append && !patch.appendUnique) {
        throw new CliError(
          "Nothing to patch: pass --set, --append, or --append-unique at least once.",
          EXIT.usage,
        );
      }
      const result = await context.client.pages.patchMetadata(path, patch);
      if (context.out.json) return context.out.emitJson(result);
      context.out.result(`Patched metadata on ${result.path}:`);
      context.out.table(
        Object.entries(result.metadata).map(([key, value]) => ({
          key,
          value: ellipsize(JSON.stringify(value) ?? "", 64),
        })),
      );
    },
  );

  attachGlobals(
    meta
      .command("history")
      .description("per-key metadata audit trail, newest first")
      .argument("<path>", "page path (<space>/<path>)")
      .option("--limit <n>", "max events", integer("--limit")),
  ).action(async (path: string, options: { limit?: number }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.pages.metadataHistory(path, { limit: options.limit });
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((event) => ({
        key: event.key,
        op: event.op,
        value: ellipsize(JSON.stringify(event.value) ?? "", 40),
        actor: event.actorLabel,
        at: formatWhen(event.createdAt),
      })),
    );
  });
}
