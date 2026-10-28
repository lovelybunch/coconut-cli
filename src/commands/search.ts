// coco search — full-text ("which pages talk about X"), and
// coco query — the metadata query engine ("which pages ARE in state X"),
// with the --filter comparison syntax translated to the API's filter ops.

import type { Command } from "commander";
import { CliError, EXIT } from "../errors.js";
import { parseFilters } from "../filters.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, collect, contextFor, ellipsize, integer } from "./helpers.js";

export function registerSearchCommands(root: Command, runtime: CliRuntime): void {
  attachGlobals(
    root
      .command("search")
      .description("full-text search across pages")
      .argument("<query>", "search terms")
      .option("--space <slug>", "limit to one space ('personal' for your private context)")
      .option("--limit <n>", "max hits", integer("--limit"))
      .addHelpText("after", "\nExample:\n  coco search 'pricing objections' --space deals"),
  ).action(async (query: string, options: { space?: string; limit?: number }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.search.text(query, {
      space: options.space,
      limit: options.limit,
    });
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((hit) => ({
        path: hit.path,
        title: hit.title,
        snippet: ellipsize(hit.snippet, 64),
        updated: formatWhen(hit.updatedAt),
      })),
    );
  });

  attachGlobals(
    root
      .command("query")
      .description("metadata query: which pages are in state X")
      .option(
        "--filter <expr>",
        "filter expression (repeatable, AND-ed): k=v k!=v k>v k>=v k<v k<=v k~v k:exists k:missing",
        collect,
        [],
      )
      .option("--space <slug>", "limit to one space ('personal' for your private context)")
      .option("--order-by <key>", "metadata key to order by")
      .option("--sort <field>", "order by a page field instead: 'updated' (the page's last update)")
      .option("--desc", "descending order (with --order-by or --sort)")
      .option("--limit <n>", "rows per page (default 20, max 500)", integer("--limit"))
      .option(
        "--offset <n>",
        "rows to skip; use the previous page's nextOffset",
        integer("--offset"),
      )
      .addHelpText(
        "after",
        [
          "",
          "Values are JSON-parsed when they look like JSON, so score>=0.7 compares",
          "numbers while stage=diligence compares strings. Example:",
          "",
          "  coco query --filter stage=diligence --filter 'conviction-score>=0.7' \\",
          "    --space deals --order-by conviction-score --desc",
          "",
          "Results are paged: the table ends with a note when more exist, and with",
          "--json the payload carries hasMore, nextOffset and total. Pass",
          "--offset <nextOffset> for the next page.",
        ].join("\n"),
      ),
  ).action(
    async (
      options: {
        filter: string[];
        space?: string;
        orderBy?: string;
        sort?: string;
        desc?: boolean;
        limit?: number;
        offset?: number;
      },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      if (options.filter.length === 0) {
        throw new CliError(
          "Pass at least one --filter (e.g. --filter stage=diligence). `coco search` does full-text.",
          EXIT.usage,
        );
      }
      if (options.sort !== undefined && options.sort !== "updated") {
        throw new CliError("--sort accepts only 'updated'.", EXIT.usage);
      }
      if (options.sort && options.orderBy) {
        throw new CliError("Pass either --order-by or --sort, not both.", EXIT.usage);
      }
      const filters = parseFilters(options.filter);
      const ordered = Boolean(options.orderBy || options.sort);
      const result = await context.client.search.metadata({
        filters,
        space: options.space,
        limit: options.limit,
        offset: options.offset,
        includeMetadata: true,
        includeTotal: true,
        orderBy: options.orderBy,
        sort: options.sort === "updated" ? "updated" : undefined,
        order: ordered ? (options.desc ? "desc" : "asc") : undefined,
      });
      if (context.out.json) return context.out.emitJson(result);
      context.out.table(
        result.items.map((item) => ({
          path: item.path,
          title: item.title,
          ...(options.orderBy
            ? {
                [options.orderBy]: ellipsize(
                  JSON.stringify(item.metadata?.[options.orderBy]) ?? "",
                  24,
                ),
              }
            : {}),
          updated: formatWhen(item.updatedAt),
        })),
      );
      if (result.hasMore && result.nextOffset !== null) {
        const shown = `${result.offset + 1}–${result.offset + result.items.length}`;
        const of = typeof result.total === "number" ? ` of ${result.total}` : "";
        context.out.info(
          `Showing ${shown}${of}. More exist: rerun with --offset ${result.nextOffset}.`,
        );
      }
    },
  );
}
