// The command tree and the top-level error boundary. `runCli` is the single
// entry point (the bin wrapper and the tests both call it): it parses, runs,
// maps failures to the documented exit codes, and never calls process.exit
// itself.

import { Command, CommanderError } from "commander";
import { registerAgentCommands } from "./commands/agent.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerMetaCommands } from "./commands/meta.js";
import { registerMiscCommands } from "./commands/misc.js";
import { registerPageCommands } from "./commands/page.js";
import { registerPersonalCommands } from "./commands/personal.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerRecordsCommands } from "./commands/records.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerSpacesCommands } from "./commands/spaces.js";
import { registerTemplateCommands } from "./commands/templates.js";
import { attachGlobals } from "./commands/helpers.js";
import { describeError, EXIT } from "./errors.js";
import type { CliRuntime } from "./runtime.js";

export const CLI_VERSION = "0.1.0";

export function buildProgram(runtime: CliRuntime): Command {
  const program = new Command("coco");
  program
    .description("Command-line client for the Coco (Coconut Context) API")
    .version(CLI_VERSION)
    // Options bind to the command they follow, so the root --version never
    // swallows `page get --version N` (leaves carry the global flags too).
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => runtime.stdout.write(text),
      writeErr: (text) => runtime.stderr.write(text),
    })
    .addHelpText(
      "after",
      [
        "",
        "Auth (two paths, stored in named profiles under ~/.config/coco/config.json):",
        "  coco auth login          browser OAuth sign-in — the interactive path;",
        "                           needs a signed-in human in the browser",
        "  coco auth login --key    agent key — the headless/CI path (prompt or stdin)",
        "",
        "Environment overrides (beat the profile): COCO_BASE_URL, COCO_API_KEY,",
        "COCO_ORG_SLUG. Every read command takes --json for the raw API payload.",
        "",
        "Exit codes: 0 ok · 2 usage/invalid input · 3 unreachable · 4 auth ·",
        "  5 not found · 6 conflict (concurrent edit) · 7 permission denied ·",
        "  8 rate limited · 9 server error · 1 anything else",
        "",
        "Worked example:",
        "  echo \"$COCO_KEY\" | coco auth login --key --base-url https://api.example.com",
        "  coco spaces list --stats",
        "  coco page put deals/acme --template deal-memo --metadata stage=sourcing",
        "  coco query --filter stage=diligence --filter 'conviction-score>=0.7' --space deals",
      ].join("\n"),
    );
  attachGlobals(program);

  registerAuthCommands(program, runtime);
  registerProfileCommands(program, runtime);
  registerSpacesCommands(program, runtime);
  registerPageCommands(program, runtime);
  registerMetaCommands(program, runtime);
  registerSearchCommands(program, runtime);
  registerRecordsCommands(program, runtime);
  registerTemplateCommands(program, runtime);
  registerAgentCommands(program, runtime);
  registerPersonalCommands(program, runtime);
  registerMiscCommands(program, runtime);

  return program;
}

/** Parses and runs one invocation; returns the process exit code. */
export async function runCli(runtime: CliRuntime, argv: string[]): Promise<number> {
  const program = buildProgram(runtime);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help/version display "fail" parseAsync with exitCode 0 by design.
      if (error.exitCode === 0) return EXIT.ok;
      return EXIT.usage;
    }
    const { message, exitCode } = describeError(error);
    runtime.stderr.write(`${message}\n`);
    return exitCode;
  }
}
