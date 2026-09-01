// coco auth login | logout | status — both credential types, stored in
// named profiles:
//
//   * OAuth (default): the interactive path. Needs a signed-in human in the
//     browser; tokens auto-refresh afterwards.
//   * Agent keys (--key): the headless/CI path. The secret is prompted with
//     echo off, or piped on stdin — never taken as an argv argument.

import type { Command } from "commander";
import { CocoClient } from "coconut-sdk";
import { loadConfig, saveConfig, type OauthAuth, type Profile } from "../config.js";
import { createOutput, resolveBaseUrl } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  discoverAuthServer,
  exchangeAuthorizationCode,
  registerClient,
  startLoopbackServer,
  type LoopbackServer,
} from "../oauth.js";
import { promptSecret } from "../prompt.js";
import type { CliRuntime } from "../runtime.js";
import { attachGlobals, contextFor, globalsOf, integer } from "./helpers.js";
import type { Output } from "../output.js";

const READ_WRITE_SCOPE = "context:read context:write";
const READ_ONLY_SCOPE = "context:read";

export function registerAuthCommands(root: Command, runtime: CliRuntime): void {
  const auth = root
    .command("auth")
    .description("sign in, sign out, and inspect the stored credential");

  attachGlobals(
    auth
      .command("login")
      .description("sign in and store the credential in a profile")
      .option("--key", "store an agent key (prompted, or piped on stdin) instead of OAuth")
      .option("--read-only", "OAuth only: request just context:read")
      .option("--no-browser", "OAuth only: print the sign-in URL instead of opening a browser")
      .option("--timeout <seconds>", "OAuth only: how long to wait for the browser", integer("--timeout"), 300)
      .addHelpText(
        "after",
        [
          "",
          "The default (OAuth) flow opens your browser and needs a signed-in human —",
          "it is the interactive path. For headless use (CI, scripts, agents), use",
          "--key with an agent key minted by an org admin:",
          "",
          "  coco auth login --key                   # prompts, echo off",
          "  echo \"$KEY\" | coco auth login --key     # stdin, for scripts",
          "  coco auth login --base-url https://api.example.com --profile prod",
        ].join("\n"),
      ),
  ).action(async (_options, command: Command) => {
    await login(runtime, command);
  });

  attachGlobals(
    auth.command("logout").description("remove the stored credential (keeps the profile's base URL)"),
  ).action(async (_options, command: Command) => {
    const globals = globalsOf(command);
    const out = createOutput(runtime, globals);
    const config = loadConfig(runtime.env);
    const name = globals.profile ?? config.activeProfile ?? "default";
    const profile = config.profiles[name];
    if (!profile?.auth) {
      out.info(`Profile "${name}" has no stored credential.`);
      return;
    }
    delete profile.auth;
    saveConfig(runtime.env, config);
    out.info(`Signed out: credential removed from profile "${name}".`);
  });

  attachGlobals(
    auth
      .command("status")
      .description("check the server and report who/what the stored credential is"),
  ).action(async (_options, command: Command) => {
    const context = contextFor(runtime, command);
    const { out } = context;

    const health = await context.client.health();

    if (context.credential.kind === "none") {
      if (out.json) {
        out.emitJson({ baseUrl: context.baseUrl, health, credential: null });
      } else {
        out.details([
          ["Profile", context.profileName],
          ["Base URL", context.baseUrl],
          ["Server", health.ok ? "ok" : "unhealthy"],
          ["Credential", "(none)"],
        ]);
      }
      throw new CliError(
        "No credential stored. Run `coco auth login` (browser) or `coco auth login --key` (agent key).",
        EXIT.auth,
      );
    }

    const session = await context.client.session();
    if (out.json) {
      out.emitJson({
        baseUrl: context.baseUrl,
        profile: context.profileName,
        health,
        credential: {
          kind: context.credential.kind,
          display: context.credential.display,
          scope: context.credential.scope,
          expiresAt: context.credential.expiresAt,
        },
        session,
      });
      return;
    }
    const rows: Array<[string, unknown]> = [
      ["Profile", context.profileName],
      ["Base URL", context.baseUrl],
      ["Server", health.ok ? "ok" : "unhealthy"],
      [
        "Credential",
        `${context.credential.kind === "key" ? "agent key" : "OAuth token"} ${context.credential.display} (from ${context.credential.source})`,
      ],
      ["Principal", `${session.principal.kind} ${session.principal.id}`],
      ["API scopes", session.principal.scopes.join(", ")],
    ];
    if (session.identity) rows.push(["Identity", `${session.identity.name} <${session.identity.email}>`]);
    if (context.credential.kind === "oauth") {
      if (context.credential.scope) rows.push(["OAuth scope", context.credential.scope]);
      if (context.credential.expiresAt) {
        const remaining = Math.round((context.credential.expiresAt - runtime.now()) / 1000);
        rows.push([
          "Token expiry",
          remaining > 0
            ? `in ${remaining}s${context.credential.hasRefreshToken ? " (auto-refreshes)" : ""}`
            : `expired${context.credential.hasRefreshToken ? " (auto-refreshes on next call)" : " — run \`coco auth login\`"}`,
        ]);
      }
    }
    if (context.orgSlug) rows.push(["Org", context.orgSlug]);
    out.details(rows);
  });
}

// ---------------------------------------------------------------------------
// Login flows
// ---------------------------------------------------------------------------

async function login(runtime: CliRuntime, command: Command): Promise<void> {
  const globals = globalsOf(command);
  const options = command.opts<{
    key?: boolean;
    readOnly?: boolean;
    browser: boolean;
    timeout: number;
  }>();

  const config = loadConfig(runtime.env);
  const profileName = globals.profile ?? config.activeProfile ?? "default";
  const existing = config.profiles[profileName];
  const out = createOutput(runtime, globals);
  const baseUrl = resolveBaseUrl(runtime, globals, existing);
  const orgSlug = globals.orgSlug ?? runtime.env.COCO_ORG_SLUG ?? existing?.orgSlug;

  const profile: Profile = { baseUrl, ...(orgSlug ? { orgSlug } : {}) };

  if (options.key) {
    const apiKey = await promptSecret(runtime, "Agent key: ");
    if (apiKey === "") throw new CliError("Empty key.", EXIT.usage);
    profile.auth = { type: "key", apiKey };
  } else {
    profile.auth = await oauthLogin(runtime, out, {
      baseUrl,
      cached: existing?.auth?.type === "oauth" && existing.baseUrl === baseUrl ? existing.auth : undefined,
      scope: options.readOnly ? READ_ONLY_SCOPE : READ_WRITE_SCOPE,
      openBrowser: options.browser,
      timeoutMs: options.timeout * 1000,
    });
  }

  // Verify before persisting, so a bad credential is never stored.
  const probe = new CocoClient({
    baseUrl,
    apiKey: profile.auth.type === "key" ? profile.auth.apiKey : profile.auth.accessToken,
    orgSlug,
    fetch: runtime.fetch,
  });
  const session = await probe.session();

  config.profiles[profileName] = profile;
  config.activeProfile ??= profileName;
  saveConfig(runtime.env, config);

  const who = session.identity
    ? `${session.identity.name} <${session.identity.email}>`
    : `${session.principal.kind} ${session.principal.id}`;
  out.info(
    `Signed in to ${baseUrl} as ${who} (profile "${profileName}", ${
      profile.auth.type === "key" ? "agent key" : `OAuth, scope: ${profile.auth.scope ?? "?"}`
    }).`,
  );
}

async function oauthLogin(
  runtime: CliRuntime,
  out: Output,
  options: {
    baseUrl: string;
    cached: OauthAuth | undefined;
    scope: string;
    openBrowser: boolean;
    timeoutMs: number;
  },
): Promise<OauthAuth> {
  const metadata = await discoverAuthServer(runtime.fetch, options.baseUrl);

  // Reuse the profile's cached client registration when its loopback port is
  // still free; otherwise register a fresh client on a new random port (the
  // redirect URI — port included — is baked into the registration).
  let server: LoopbackServer | undefined;
  let client: { clientId: string; clientSecret: string; redirectUri: string } | undefined;
  if (options.cached) {
    const cachedPort = Number(new URL(options.cached.redirectUri).port);
    if (Number.isInteger(cachedPort) && cachedPort > 0) {
      server = await startLoopbackServer(cachedPort).catch(() => undefined);
      if (server) {
        client = {
          clientId: options.cached.clientId,
          clientSecret: options.cached.clientSecret,
          redirectUri: options.cached.redirectUri,
        };
      }
    }
  }
  if (!server) {
    server = await startLoopbackServer(0);
  }
  try {
    client ??= await registerClient(runtime.fetch, metadata.registration_endpoint, server.redirectUri);

    const pkce = createPkcePair();
    const state = createState();
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      state,
      scope: options.scope,
      codeChallenge: pkce.challenge,
    });

    out.info("Complete the sign-in in your browser (you must be signed in to the app):");
    out.info(`  ${authorizeUrl}`);
    if (options.openBrowser) {
      const opened = await runtime.openBrowser(authorizeUrl);
      if (!opened) out.info("(could not open a browser automatically — use the URL above)");
    }

    const code = await server.waitForCode(state, options.timeoutMs);
    const tokens = await exchangeAuthorizationCode(runtime.fetch, {
      tokenUrl: metadata.token_endpoint,
      code,
      redirectUri: client.redirectUri,
      codeVerifier: pkce.verifier,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      now: runtime.now,
    });

    return {
      type: "oauth",
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: client.redirectUri,
      tokenUrl: metadata.token_endpoint,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? options.scope,
    };
  } finally {
    await server.close();
  }
}
