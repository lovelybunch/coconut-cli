// coco profile list | use | remove — named connection profiles in
// ~/.config/coco/config.json. A profile pairs a base URL (and optional org)
// with one credential; `coco auth login --profile <name>` creates them.

import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import { createOutput } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, globalsOf } from "./helpers.js";

export function registerProfileCommands(root: Command, runtime: CliRuntime): void {
  const profile = root.command("profile").description("manage connection profiles");

  attachGlobals(profile.command("list").description("list profiles and the active one")).action(
    async (_options, command: Command) => {
      const globals = globalsOf(command);
      const out = createOutput(runtime, globals);
      const config = loadConfig(runtime.env);
      const names = Object.keys(config.profiles);
      if (out.json) {
        out.emitJson({
          activeProfile: config.activeProfile ?? null,
          profiles: Object.fromEntries(
            names.map((name) => {
              const entry = config.profiles[name];
              return [
                name,
                {
                  baseUrl: entry.baseUrl,
                  orgSlug: entry.orgSlug ?? null,
                  auth: entry.auth ? entry.auth.type : null,
                },
              ];
            }),
          ),
        });
        return;
      }
      if (names.length === 0) {
        out.info("No profiles yet. Run `coco auth login` to create one.");
        return;
      }
      out.table(
        names.map((name) => {
          const entry = config.profiles[name];
          return {
            active: name === config.activeProfile ? "*" : "",
            profile: name,
            baseUrl: entry.baseUrl,
            org: entry.orgSlug ?? "",
            auth: entry.auth ? (entry.auth.type === "key" ? "agent key" : "oauth") : "(none)",
          };
        }),
        ["active", "profile", "baseUrl", "org", "auth"],
      );
    },
  );

  attachGlobals(
    profile.command("use").description("set the active profile").argument("<name>", "profile name"),
  ).action(async (name: string, _options, command: Command) => {
    const out = createOutput(runtime, globalsOf(command));
    const config = loadConfig(runtime.env);
    if (!config.profiles[name]) {
      throw new CliError(
        `Profile "${name}" does not exist. Run \`coco profile list\`, or create it with \`coco auth login --profile ${name}\`.`,
        EXIT.usage,
      );
    }
    config.activeProfile = name;
    saveConfig(runtime.env, config);
    out.info(`Active profile: ${name}`);
  });

  attachGlobals(
    profile
      .command("remove")
      .description("delete a profile (and its stored credential)")
      .argument("<name>", "profile name"),
  ).action(async (name: string, _options, command: Command) => {
    const out = createOutput(runtime, globalsOf(command));
    const config = loadConfig(runtime.env);
    if (!config.profiles[name]) {
      throw new CliError(`Profile "${name}" does not exist.`, EXIT.usage);
    }
    delete config.profiles[name];
    if (config.activeProfile === name) delete config.activeProfile;
    saveConfig(runtime.env, config);
    out.info(`Removed profile "${name}".`);
  });
}
