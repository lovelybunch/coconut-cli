// coco inbox [--unread] [--space S] [--limit N] [--before CURSOR] · count [--space S]
//            · read <id…> | --all [--space S] [--scope all|activity]
//
// The signed-in person's notifications: activity in spaces they edit, agent
// run outcomes there, membership events for admins. Agent-key profiles get a
// permission error — agents are never recipients.

import type { Command } from "commander";
import type { Notification } from "coconut-sdk";
import { CliError, EXIT } from "../errors.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor, ellipsize, integer } from "./helpers.js";

const READ_SCOPES = ["all", "activity"] as const;
type ReadScope = (typeof READ_SCOPES)[number];

function toRow(item: Notification): Record<string, unknown> {
  return {
    when: formatWhen(item.occurredAt),
    // An unread row that needs you (a failed run, a task that is blocked or
    // in review, an open handoff) is marked "!" rather than "•".
    unread: item.readAt ? "" : item.attention ? "!" : "•",
    summary: ellipsize(item.summary, 88),
    space: item.event.spaceSlug ?? "",
    path: item.event.subjectPath ?? "",
    id: item.id,
  };
}

function parseScope(value: string | undefined): ReadScope | undefined {
  if (value === undefined) return undefined;
  if ((READ_SCOPES as readonly string[]).includes(value)) return value as ReadScope;
  throw new CliError(`--scope must be one of: ${READ_SCOPES.join(", ")}.`, EXIT.usage);
}

function formatCount(unread: number, attention: number): string {
  return attention > 0 ? `${unread} (${attention} need attention)` : String(unread);
}

export function registerInboxCommands(root: Command, runtime: CliRuntime): void {
  const inbox = root
    .command("inbox")
    .description("your notifications: space activity, agent run outcomes, membership events")
    .addHelpText(
      "after",
      "\nExamples:\n  coco inbox --unread\n  coco inbox --space deals --unread\n  coco inbox read --all --space deals --scope activity\n  coco inbox --json | jq '.items[] | select(.event.type == \"agent.run.failed\")'",
    );

  attachGlobals(
    inbox
      .option("--unread", "unread rows only")
      .option("--space <slug>", "only this space's rows")
      .option("--limit <n>", "rows per page (1-100, default 20)", integer("--limit"))
      .option("--before <cursor>", "page cursor from a previous listing (its nextBefore)"),
  ).action(
    async (
      options: { unread?: boolean; space?: string; limit?: number; before?: string },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const result = await context.client.notifications.list({
        unreadOnly: options.unread,
        space: options.space,
        limit: options.limit,
        before: options.before,
      });
      if (context.out.json) return context.out.emitJson(result);
      context.out.info(
        `${result.unread} unread · showing ${result.items.length}${
          result.nextBefore ? ` · next page: --before ${result.nextBefore}` : ""
        }`,
      );
      context.out.table(result.items.map(toRow), [
        "when",
        "unread",
        "summary",
        "space",
        "path",
        "id",
      ]);
    },
  );

  attachGlobals(
    inbox
      .command("count")
      .description("unread count (the badge number)")
      .option("--space <slug>", "this space's share of the count"),
  ).action(async (options: { space?: string }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.notifications.unreadCount();
    if (options.space) {
      // The summary already carries the per-space split the sidebar badges use.
      const slice = result.bySpace?.[options.space] ?? { unread: 0, attention: 0 };
      if (context.out.json) return context.out.emitJson({ space: options.space, ...slice });
      context.out.result(formatCount(slice.unread, Number(slice.attention ?? 0)));
      return;
    }
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(formatCount(result.unread, Number(result.attention ?? 0)));
  });

  attachGlobals(
    inbox
      .command("read")
      .description("mark notifications read")
      .argument("[ids...]", "notification ids")
      .option("--all", "mark every notification read")
      .option("--space <slug>", "with --all: only this space's rows")
      .option(
        "--scope <scope>",
        "with --all: `activity` leaves the rows that need you unread (default: all)",
      ),
  ).action(
    async (
      ids: string[],
      options: { all?: boolean; space?: string; scope?: string },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      if (options.all && ids.length > 0) {
        throw new CliError("Pass either notification ids or --all, not both.", EXIT.usage);
      }
      if (!options.all && ids.length === 0) {
        throw new CliError("Pass one or more notification ids, or --all.", EXIT.usage);
      }
      if (!options.all && (options.space !== undefined || options.scope !== undefined)) {
        throw new CliError("--space and --scope only apply together with --all.", EXIT.usage);
      }
      const scope = parseScope(options.scope);
      const result = options.all
        ? await context.client.notifications.markAllRead({ space: options.space, scope })
        : await context.client.notifications.markRead(ids);
      if (context.out.json) return context.out.emitJson(result);
      context.out.info(
        `Marked ${result.updated} notification${result.updated === 1 ? "" : "s"} read.`,
      );
    },
  );
}
