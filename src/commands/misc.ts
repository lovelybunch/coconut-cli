// coco whoami | health — one-shot probes.

import type { Command } from "commander";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor } from "./helpers.js";

export function registerMiscCommands(root: Command, runtime: CliRuntime): void {
  attachGlobals(
    root.command("whoami").description("who the configured credential resolves to"),
  ).action(async (_options, command: Command) => {
    const context = contextFor(runtime, command);
    const session = await context.client.session();
    if (context.out.json) return context.out.emitJson(session);
    const rows: Array<[string, unknown]> = [
      ["Principal", `${session.principal.kind} ${session.principal.id}`],
      ["Scopes", session.principal.scopes.join(", ")],
    ];
    if (session.identity) {
      rows.push(["Name", session.identity.name], ["Email", session.identity.email]);
    }
    context.out.details(rows);
  });

  attachGlobals(root.command("health").description("liveness probe (unauthenticated)")).action(
    async (_options, command: Command) => {
      const context = contextFor(runtime, command);
      const result = await context.client.health();
      if (context.out.json) return context.out.emitJson(result);
      context.out.result(result.ok ? `ok (${context.baseUrl})` : `unhealthy (${context.baseUrl})`);
    },
  );
}
