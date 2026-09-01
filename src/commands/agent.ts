// coco agent … — space agents: rollups, tasks (page-backed, If-Match writes),
// async runs (202 + poll; --watch streams status to a terminal record), run
// history, the agent persona (instructions), and the model catalog.

import type { Command } from "commander";
import { CocoNotFoundError, type AgentRunDetail, type AgentRunStatus } from "coconut-sdk";
import type { CommandContext } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { foldLeadingFrontmatter } from "../markdown.js";
import { formatWhen } from "../output.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor, ellipsize, integer, readContent } from "./helpers.js";
import { foldForWrite } from "./page.js";

const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(["completed", "failed", "unknown"]);

export function registerAgentCommands(root: Command, runtime: CliRuntime): void {
  const agent = root
    .command("agent")
    .description("space agents: tasks, runs, instructions, models")
    .addHelpText(
      "after",
      [
        "",
        "Every space has one agent, defined by pages under its agents/ prefix.",
        "Example:",
        "  coco agent task put deals daily-digest --schedule '0 7 * * 1-5' --tz UTC < task.md",
        "  coco agent run deals daily-digest --watch",
      ].join("\n"),
    );

  attachGlobals(agent.command("list").description("per-space agent rollups")).action(
    async (_options, command: Command) => {
      const context = contextFor(runtime, command);
      const result = await context.client.agents.list();
      if (context.out.json) return context.out.emitJson(result);
      context.out.table(
        result.items.map((item) => ({
          space: item.spaceSlug,
          instructions: item.hasInstructions ? "yes" : "no",
          tasks: item.taskCount,
          runs: item.runCount,
          "last run": formatWhen(item.lastRunAt),
        })),
      );
    },
  );

  attachGlobals(
    agent
      .command("tasks")
      .description("a space agent's tasks with run stats")
      .argument("<space>", "space slug")
      .option("--limit <n>", "max rows", integer("--limit")),
  ).action(async (space: string, options: { limit?: number }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.agents.listTasks(space, { limit: options.limit });
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((task) => ({
        task: task.task,
        title: task.title,
        schedule: task.schedule ? `${task.schedule.cron}${task.schedule.enabled ? "" : " (off)"}` : "",
        runs: task.runCount,
        "last status": task.lastRunStatus ?? "",
        "last run": formatWhen(task.lastRunAt),
      })),
    );
  });

  const task = agent.command("task").description("one agent task: read and write");

  attachGlobals(
    task
      .command("get")
      .description("one task in full — markdown, schedule, recent runs")
      .argument("<space>", "space slug")
      .argument("<task>", "task path under agents/ (e.g. daily-digest)"),
  ).action(async (space: string, taskName: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.agents.getTask(space, taskName);
    if (context.out.json) return context.out.emitJson(result);
    context.out.details([
      ["Task", `${result.spaceSlug}/agents/${result.task} (v${result.version})`],
      ["Title", result.title],
      ["Schedule", result.schedule ? `${result.schedule.cron} (${result.schedule.timezone}${result.schedule.enabled ? "" : ", disabled"})` : "(none)"],
      ["Runs", `${result.runCount}${result.lastRunStatus ? `, last ${result.lastRunStatus} at ${formatWhen(result.lastRunAt)}` : ""}`],
    ]);
    context.out.result("");
    context.out.result(result.markdown.replace(/\n$/, ""));
  });

  attachGlobals(
    task
      .command("put")
      .description("create or update a task (instructions from --file or stdin)")
      .argument("<space>", "space slug")
      .argument("<task>", "task path under agents/ (e.g. daily-digest)")
      .option("-f, --file <file>", "instructions markdown ('-' for stdin; piped stdin is read implicitly when creating)")
      .option("--title <title>", "task title")
      .option("--schedule <cron>", "5-field cron schedule (stored in frontmatter)")
      .option("--tz <timezone>", "schedule timezone (e.g. UTC, Europe/Amsterdam)")
      .option("--enable", "enable the schedule")
      .option("--disable", "disable the schedule without removing it"),
  ).action(
    async (
      space: string,
      taskName: string,
      options: {
        file?: string;
        title?: string;
        schedule?: string;
        tz?: string;
        enable?: boolean;
        disable?: boolean;
      },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      if (options.enable && options.disable) {
        throw new CliError("--enable and --disable are mutually exclusive.", EXIT.usage);
      }
      const current = await context.client.agents.getTask(space, taskName).catch((error: unknown) => {
        if (error instanceof CocoNotFoundError) return null;
        throw error;
      });
      // Implicit piped stdin only when instructions are required (creating).
      const raw = await readContent(runtime, options.file, { implicitStdin: current === null });
      const folded = raw === undefined ? undefined : foldForWrite(context.out, raw);

      const scheduleFrontmatter: Record<string, unknown> = {};
      if (options.schedule !== undefined) scheduleFrontmatter.schedule = options.schedule;
      if (options.tz !== undefined) scheduleFrontmatter.scheduleTz = options.tz;
      if (options.enable) scheduleFrontmatter.scheduleEnabled = true;
      if (options.disable) scheduleFrontmatter.scheduleEnabled = false;

      if (current === null) {
        if (folded === undefined) {
          throw new CliError(
            `Task "${taskName}" does not exist yet; creating it needs instructions (--file or stdin).`,
            EXIT.usage,
          );
        }
        const frontmatter = { ...folded.frontmatter, ...scheduleFrontmatter };
        const result = await context.client.agents.createTask(space, taskName, {
          title: options.title ?? folded.title,
          content: folded.content,
          frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
        });
        if (context.out.json) return context.out.emitJson(result);
        context.out.result(`Created ${result.path} (v${result.version}).`);
        return;
      }

      if (folded === undefined && options.title === undefined && Object.keys(scheduleFrontmatter).length === 0) {
        throw new CliError(
          `Task "${taskName}" exists and nothing was given to change. Pass --file <f> (or --file - for stdin), --title, or schedule flags.`,
          EXIT.usage,
        );
      }
      const result = await context.client.agents.updateTask(space, taskName, {
        title: options.title ?? folded?.title,
        // Keep the existing instructions when only flags change; the served
        // markdown carries a rendered frontmatter block, which rides
        // separately as `frontmatter`.
        content: folded?.content ?? foldLeadingFrontmatter(current.markdown).content,
        frontmatter: { ...current.frontmatter, ...folded?.frontmatter, ...scheduleFrontmatter },
        expectedVersion: current.version,
      });
      if (context.out.json) return context.out.emitJson(result);
      context.out.result(`Updated ${result.path} (v${current.version} → v${result.version}).`);
    },
  );

  attachGlobals(
    agent
      .command("run")
      .description("queue a task run (202); --watch polls it to completion")
      .argument("<space>", "space slug")
      .argument("<task>", "task path under agents/")
      .option("--watch", "poll the run and print its markdown output when done")
      .option("--timeout <seconds>", "give up watching after this long", integer("--timeout"), 900)
      .option("--transcript", "with --watch: include the activity transcript"),
  ).action(
    async (
      space: string,
      taskName: string,
      options: { watch?: boolean; timeout: number; transcript?: boolean },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const queued = await context.client.agents.runTask(space, taskName);
      if (!options.watch) {
        if (context.out.json) return context.out.emitJson(queued);
        context.out.result(`Queued run ${queued.runId} (${queued.runPath}).`);
        context.out.info(`Follow it with: coco agent run-show ${space} ${queued.runId} — or --watch next time.`);
        return;
      }
      context.out.info(`Queued run ${queued.runId}; watching…`);
      const run = await watchRun(context, space, queued.runId, {
        timeoutMs: options.timeout * 1000,
        transcript: options.transcript === true,
      });
      printRun(context, run);
      if (run.status !== "completed") {
        throw new CliError(`Run ${run.runId} finished with status "${run.status}".`, EXIT.unexpected);
      }
    },
  );

  attachGlobals(
    agent
      .command("runs")
      .description("a task's run records, newest first")
      .argument("<space>", "space slug")
      .argument("<task>", "task path under agents/")
      .option("--limit <n>", "max rows", integer("--limit"))
      .option("--status <status>", "filter: completed | failed | running | waiting | unknown"),
  ).action(
    async (
      space: string,
      taskName: string,
      options: { limit?: number; status?: string },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      const result = await context.client.agents.listRuns(space, taskName, {
        limit: options.limit,
        status: options.status as AgentRunStatus | undefined,
      });
      if (context.out.json) return context.out.emitJson(result);
      context.out.table(
        result.items.map((run) => ({
          run: run.runId,
          status: run.status,
          trigger: run.trigger,
          ran: formatWhen(run.ranAt),
          duration: run.durationMs === null ? "" : `${Math.round(run.durationMs / 1000)}s`,
          summary: ellipsize(run.summary, 48),
        })),
      );
    },
  );

  attachGlobals(
    agent
      .command("run-show")
      .description("one run record: status, usage, markdown output")
      .argument("<space>", "space slug")
      .argument("<run-id>", "run id (from `coco agent runs`)")
      .option("--transcript", "include the chronological activity transcript"),
  ).action(async (space: string, runId: string, options: { transcript?: boolean }, command: Command) => {
    const context = contextFor(runtime, command);
    const run = await context.client.agents.getRun(space, runId, {
      includeTranscript: options.transcript,
    });
    if (context.out.json) return context.out.emitJson(run);
    printRun(context, run);
  });

  const instructions = agent
    .command("instructions")
    .description("the agent persona for a space (agents/instructions)");

  attachGlobals(
    instructions
      .command("get")
      .description("read the agent instructions")
      .argument("<space>", "space slug"),
  ).action(async (space: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.agents.getInstructions(space);
    if (context.out.json) return context.out.emitJson(result);
    if (!result.exists || result.markdown === null) {
      context.out.info(`Space "${space}" has no agent instructions yet (coco agent instructions set ${space}).`);
      return;
    }
    context.out.result(result.markdown.replace(/\n$/, ""));
  });

  attachGlobals(
    instructions
      .command("set")
      .description("create or update the agent instructions (from --file or stdin)")
      .argument("<space>", "space slug")
      .option("-f, --file <file>", "instructions markdown ('-' for stdin; piped stdin also read implicitly)")
      .option("--title <title>", "instructions page title"),
  ).action(async (space: string, options: { file?: string; title?: string }, command: Command) => {
    const context = contextFor(runtime, command);
    const raw = await readContent(runtime, options.file, { implicitStdin: true });
    if (raw === undefined) {
      throw new CliError("Instructions content required (--file or stdin).", EXIT.usage);
    }
    const folded = foldForWrite(context.out, raw);
    const current = await context.client.agents.getInstructions(space);
    const result = await context.client.agents.setInstructions(space, {
      content: folded.content,
      title: options.title ?? folded.title,
      expectedVersion: current.exists && current.version !== null ? current.version : undefined,
    });
    if (context.out.json) return context.out.emitJson(result);
    context.out.result(`Wrote ${result.path} (v${result.version}).`);
  });

  attachGlobals(
    agent.command("models").description("models a task's `model` frontmatter key may pin"),
  ).action(async (_options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.agents.models();
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.models.map((model) => ({
        id: model.id,
        label: model.label ?? "",
        default: model.isDefault ? "*" : "",
      })),
    );
  });
}

// ---------------------------------------------------------------------------

/** Polls a run to a terminal status, narrating status changes on stderr. */
async function watchRun(
  context: CommandContext,
  space: string,
  runId: string,
  options: { timeoutMs: number; transcript: boolean },
): Promise<AgentRunDetail> {
  const startedAt = context.runtime.now();
  let lastStatus = "";
  for (;;) {
    const run = await context.client.agents.getRun(space, runId, {
      includeTranscript: options.transcript,
    });
    if (run.status !== lastStatus) {
      context.out.info(`  status: ${run.status}`);
      lastStatus = run.status;
    }
    if (TERMINAL.has(run.status)) return run;
    if (context.runtime.now() - startedAt > options.timeoutMs) {
      throw new CliError(
        `Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for run ${runId} (last status: ${run.status}). It keeps running server-side — check \`coco agent run-show ${space} ${runId}\`.`,
        EXIT.unexpected,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function printRun(context: CommandContext, run: AgentRunDetail): void {
  context.out.details([
    ["Run", run.runId],
    ["Status", run.status],
    ["Trigger", run.trigger],
    ["Ran at", formatWhen(run.ranAt)],
    ["Duration", run.durationMs === null ? "" : `${Math.round(run.durationMs / 1000)}s`],
    ["Model", run.modelId ?? ""],
    [
      "Usage",
      run.usage
        ? `${run.usage.inputTokens ?? "?"} in / ${run.usage.outputTokens ?? "?"} out, ${run.usage.steps ?? "?"} steps`
        : "",
    ],
  ]);
  if (run.markdown.trim() !== "") {
    context.out.result("");
    context.out.result(run.markdown.replace(/\n$/, ""));
  }
  if (run.transcript) {
    context.out.result("");
    context.out.result(JSON.stringify(run.transcript, null, 2));
  }
}
