// coco templates list — page templates (record types) with their schemas.
// coco space-templates list | show | create-space — whole-space starting kits.

import type { Command } from "commander";
import type { SpaceTemplateSource } from "coconut-sdk";
import { CliError, EXIT } from "../errors.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor, ellipsize } from "./helpers.js";

const SOURCES: SpaceTemplateSource[] = ["builtin", "remote", "org"];

function parseSource(value: string): SpaceTemplateSource {
  if ((SOURCES as string[]).includes(value)) return value as SpaceTemplateSource;
  throw new CliError(`Unknown template source "${value}" (want ${SOURCES.join(", ")}).`, EXIT.usage);
}

export function registerTemplateCommands(root: Command, runtime: CliRuntime): void {
  const templates = root
    .command("templates")
    .description("page templates (record types) visible to the credential");

  attachGlobals(
    templates
      .command("list")
      .description("templates with their metadata schemas")
      .option("--space <slug>", "limit to one space")
      .addHelpText("after", "\nExample:\n  coco templates list --space deals"),
  ).action(async (options: { space?: string }, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.templates.list({ space: options.space });
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((template) => ({
        space: template.space,
        name: template.name,
        title: template.title,
        fields: template.schema?.fields.map((field) => field.key).join(", ") ?? "",
        description: ellipsize(template.description, 40),
      })),
    );
  });

  const spaceTemplates = root
    .command("space-templates")
    .description("whole-space starting kits (the /templates gallery)")
    .addHelpText(
      "after",
      [
        "",
        "Example:",
        "  coco space-templates list",
        "  coco space-templates show builtin pe-deal-pipeline",
        "  coco space-templates create-space builtin pe-deal-pipeline --slug deals",
      ].join("\n"),
    );

  attachGlobals(
    spaceTemplates.command("list").description("the merged gallery (catalog + org snapshots)"),
  ).action(async (_options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.spaceTemplates.list();
    if (context.out.json) return context.out.emitJson(result);
    context.out.table(
      result.items.map((template) => ({
        source: template.source,
        id: template.id,
        title: template.title,
        category: template.category,
        pages: template.pageCount,
      })),
    );
  });

  attachGlobals(
    spaceTemplates
      .command("show")
      .description("one space template in full (its pages)")
      .argument("<source>", "builtin | remote | org")
      .argument("<id>", "template id"),
  ).action(async (source: string, id: string, _options, command: Command) => {
    const context = contextFor(runtime, command);
    const result = await context.client.spaceTemplates.get(parseSource(source), id);
    if (context.out.json) return context.out.emitJson(result);
    context.out.details([
      ["Template", `${result.source}/${result.id}`],
      ["Title", result.title],
      ["Category", result.category],
      ["Description", result.description],
      ["Space", `${result.space.slug} — ${result.space.name}`],
    ]);
    context.out.table(
      result.pages.map((page) => ({
        path: page.path,
        title: page.title,
        role: page.role,
        agentTask: page.agentTask ? "yes" : "",
      })),
    );
  });

  attachGlobals(
    spaceTemplates
      .command("create-space")
      .description("create a new space seeded from a template (org admin)")
      .argument("<source>", "builtin | remote | org")
      .argument("<id>", "template id")
      .requiredOption("--slug <slug>", "slug for the new space (lowercase kebab-case)")
      .option("--name <name>", "space name")
      .option("--description <text>", "space description")
      .option("--visibility <visibility>", "private | org"),
  ).action(
    async (
      source: string,
      id: string,
      options: { slug: string; name?: string; description?: string; visibility?: string },
      command: Command,
    ) => {
      const context = contextFor(runtime, command);
      if (options.visibility !== undefined && !["private", "org"].includes(options.visibility)) {
        throw new CliError(`--visibility must be "private" or "org".`, EXIT.usage);
      }
      const result = await context.client.spaceTemplates.createSpace(parseSource(source), id, {
        slug: options.slug,
        name: options.name,
        description: options.description,
        visibility: options.visibility as "private" | "org" | undefined,
      });
      if (context.out.json) return context.out.emitJson(result);
      context.out.result(
        `Created space "${result.space.slug}" from ${result.template.source}/${result.template.id}: ${result.pages.created} pages.`,
      );
      for (const failure of result.pages.errors) {
        context.out.warn(`  failed ${failure.path}: ${failure.error}`);
      }
    },
  );
}
