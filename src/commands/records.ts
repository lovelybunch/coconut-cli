// coco records types | list | create — typed records: pages stamped with a
// schema-bearing template, queried as data through the metadata engine.

import type { Command } from "commander";
import { parseFilters } from "../filters.js";
import { parseKeyValues } from "../kv.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, collect, contextFor, ellipsize, integer, readContent } from "./helpers.js";

/** Flattens record metadata into table columns, capped so rows stay readable. */
function metadataColumns(items: Array<{ metadata?: Record<string, unknown> }>, cap = 5): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const key of Object.keys(item.metadata ?? {})) {
      if (key === "template") continue; // implicit — every row shares it
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([key]) => key);
}

export function registerRecordsCommands(root: Command, runtime: CliRuntime): void {
  const records = root
    .command("records")
    .description("typed records: template-stamped pages as queryable data")
    .addHelpText(
      "after",
      [
        "",
        "Example:",
        "  coco records types deals",
        "  coco records list deals deal-memo --filter stage=diligence --order-by conviction-score --desc",
        "  coco records create deals deal-memo deals/acme --title 'Acme' --metadata stage=sourcing",
      ].join("\n"),
    );

  attachGlobals(
    records
      .command("types")
      .description("the record types of a space (its schema-bearing templates)")
      .argument("<space>", "space slug"),
  ).action(async (space: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const types = await context.client.records.types(space);
    if (context.out.json) return context.out.emitJson({ space, items: types });
    context.out.table(
      types.map((type) => ({
        name: type.name,
        title: type.title,
        fields: type.schema?.fields.map((field) => field.key).join(", ") ?? "",
        prefix: type.defaultPathPrefix ?? "",
      })),
    );
  });

  attachGlobals(
    records
      .command("list")
      .description("records of one type in one space (metadata included)")
      .argument("<space>", "space slug")
      .argument("<type>", "record type (template name)")
      .option("--filter <expr>", "extra filter (repeatable): k=v k>=v k~v k:exists …", collect, [])
      .option("--order-by <key>", "metadata key to order by")
      .option("--desc", "descending order (with --order-by)")
      .option("--limit <n>", "max rows", integer("--limit")),
  ).action(
    async (
      space: string,
      type: string,
      options: { filter: string[]; orderBy?: string; desc?: boolean; limit?: number },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const result = await context.client.records.query(space, type, {
        filters: parseFilters(options.filter),
        orderBy: options.orderBy,
        order: options.orderBy ? (options.desc ? "desc" : "asc") : undefined,
        limit: options.limit,
      });
      if (context.out.json) return context.out.emitJson(result);
      const columns = metadataColumns(result.items);
      context.out.table(
        result.items.map((item) => ({
          path: item.path,
          title: item.title,
          ...Object.fromEntries(
            columns.map((key) => [key, ellipsize(JSON.stringify(item.metadata?.[key]) ?? "", 28)]),
          ),
          updated: formatWhen(item.updatedAt),
        })),
        ["path", "title", ...columns, "updated"],
      );
    },
  );

  attachGlobals(
    records
      .command("create")
      .description("create a record from its template (schema-validated)")
      .argument("<space>", "space slug")
      .argument("<type>", "record type (template name)")
      .argument("<path>", "page path relative to the space (e.g. deals/acme)")
      .option("--title <title>", "record title")
      .option("-f, --file <file>", "markdown body ('-' for stdin; default: the template's content)")
      .option("--metadata <k=v>", "field values (repeatable; validated against the schema)", collect, [])
      .option("--note <note>", "revision note"),
  ).action(
    async (
      space: string,
      type: string,
      path: string,
      options: { title?: string; file?: string; metadata: string[]; note?: string },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const content = await readContent(runtime, options.file);
      const result = await context.client.records.create(space, type, {
        path,
        title: options.title,
        content,
        metadata: options.metadata.length > 0 ? parseKeyValues(options.metadata, "--metadata") : undefined,
        note: options.note,
      });
      if (context.out.json) return context.out.emitJson(result);
      context.out.result(`Created ${result.path} (v${result.version}) from template "${type}".`);
    },
  );
}
