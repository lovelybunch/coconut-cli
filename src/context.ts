// Per-command wiring: resolve profile + environment + flags into a configured
// CocoClient. Precedence everywhere: command flags > environment variables
// (COCO_BASE_URL, COCO_API_KEY, COCO_ORG_SLUG) > the profile in config.json.
//
// OAuth profiles get a fetch wrapper that injects the current access token,
// refreshes it proactively just before expiry and reactively on a 401 (one
// retry), persists rotated tokens immediately (refresh tokens are single-use),
// and turns a failed refresh into a clear "run `coco auth login`" error.

import { CocoClient, type FetchLike } from "coconut-sdk";
import {
  loadConfig,
  redactSecret,
  resolveProfileName,
  saveConfig,
  type CliConfig,
  type OauthAuth,
  type Profile,
} from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { refreshAccessToken } from "./oauth.js";
import { Output } from "./output.js";
import type { CliRuntime } from "./runtime.js";

export interface GlobalOptions {
  profile?: string;
  baseUrl?: string;
  orgSlug?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface CredentialInfo {
  kind: "key" | "oauth" | "none";
  /** Redacted display string for `auth status` — never the secret itself. */
  display: string;
  source: "flag" | "env" | "profile" | "none";
  /** OAuth-only detail. */
  scope?: string;
  expiresAt?: number;
  hasRefreshToken?: boolean;
}

export interface CommandContext {
  runtime: CliRuntime;
  config: CliConfig;
  profileName: string;
  profile: Profile | undefined;
  baseUrl: string;
  orgSlug: string | undefined;
  credential: CredentialInfo;
  client: CocoClient;
  out: Output;
}

const DEFAULT_BASE_URL = "http://localhost:8787";
/** Refresh this many ms before the recorded expiry, not at it. */
const EXPIRY_SKEW_MS = 30_000;

export function resolveBaseUrl(
  runtime: CliRuntime,
  options: GlobalOptions,
  profile: Profile | undefined,
): string {
  const raw = options.baseUrl ?? runtime.env.COCO_BASE_URL ?? profile?.baseUrl ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function createOutput(runtime: CliRuntime, options: GlobalOptions): Output {
  return new Output({
    json: options.json === true,
    quiet: options.quiet === true,
    stdout: runtime.stdout,
    stderr: runtime.stderr,
    env: runtime.env,
  });
}

export function createContext(runtime: CliRuntime, options: GlobalOptions): CommandContext {
  const config = loadConfig(runtime.env);
  const profileName = resolveProfileName(config, options.profile);
  if (options.profile && !config.profiles[options.profile]) {
    throw new CliError(
      `Profile "${options.profile}" does not exist. Run \`coco profile list\`, or \`coco auth login --profile ${options.profile}\` to create it.`,
      EXIT.usage,
    );
  }
  const profile = config.profiles[profileName];
  const baseUrl = resolveBaseUrl(runtime, options, profile);
  const orgSlug = options.orgSlug ?? runtime.env.COCO_ORG_SLUG ?? profile?.orgSlug;
  const out = createOutput(runtime, options);

  const envKey = runtime.env.COCO_API_KEY;
  let credential: CredentialInfo;
  let client: CocoClient;

  if (envKey) {
    credential = { kind: "key", display: redactSecret(envKey), source: "env" };
    client = new CocoClient({ baseUrl, apiKey: envKey, orgSlug, fetch: runtime.fetch });
  } else if (profile?.auth?.type === "key") {
    credential = { kind: "key", display: redactSecret(profile.auth.apiKey), source: "profile" };
    client = new CocoClient({ baseUrl, apiKey: profile.auth.apiKey, orgSlug, fetch: runtime.fetch });
  } else if (profile?.auth?.type === "oauth") {
    const auth = profile.auth;
    credential = {
      kind: "oauth",
      display: redactSecret(auth.accessToken),
      source: "profile",
      scope: auth.scope,
      expiresAt: auth.expiresAt,
      hasRefreshToken: Boolean(auth.refreshToken),
    };
    client = new CocoClient({
      baseUrl,
      orgSlug,
      fetch: createOauthFetch(runtime, profileName, auth),
    });
  } else {
    credential = { kind: "none", display: "(none)", source: "none" };
    client = new CocoClient({ baseUrl, orgSlug, fetch: runtime.fetch });
  }

  return { runtime, config, profileName, profile, baseUrl, orgSlug, credential, client, out };
}

/** Requires some credential before an authed call; friendlier than the 401. */
export function requireCredential(context: CommandContext): void {
  if (context.credential.kind === "none") {
    throw new CliError(
      `No credential for profile "${context.profileName}". Run \`coco auth login\` (browser sign-in) or \`coco auth login --key\` (agent key), or set COCO_API_KEY.`,
      EXIT.auth,
    );
  }
}

// ---------------------------------------------------------------------------
// OAuth token lifecycle
// ---------------------------------------------------------------------------

class OauthTokenManager {
  private auth: OauthAuth;
  private refreshInFlight: Promise<string> | undefined;
  /** A failed refresh is final for this invocation — never retried. */
  private refreshFailure: CliError | undefined;

  constructor(
    private readonly runtime: CliRuntime,
    private readonly profileName: string,
    auth: OauthAuth,
  ) {
    this.auth = { ...auth };
  }

  /** The access token to send, refreshing first when it's (nearly) expired. */
  async currentToken(): Promise<string> {
    if (
      this.auth.expiresAt !== undefined &&
      this.runtime.now() >= this.auth.expiresAt - EXPIRY_SKEW_MS &&
      this.auth.refreshToken
    ) {
      return this.refresh();
    }
    return this.auth.accessToken;
  }

  /**
   * Reactive path after a 401: returns a fresh token, or null when the 401
   * should stand (no refresh token, or the token already rotated past the
   * one that failed — a concurrent refresh handled it).
   */
  async tokenAfter401(staleToken: string): Promise<string | null> {
    if (this.auth.accessToken !== staleToken) return this.auth.accessToken;
    if (!this.auth.refreshToken) return null;
    return this.refresh();
  }

  /** Serialized: concurrent callers share one in-flight refresh (single-use rotation). */
  private refresh(): Promise<string> {
    if (this.refreshFailure) return Promise.reject(this.refreshFailure);
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<string> {
    let tokens;
    try {
      tokens = await refreshAccessToken(this.runtime.fetch, {
        tokenUrl: this.auth.tokenUrl,
        refreshToken: this.auth.refreshToken as string,
        clientId: this.auth.clientId,
        clientSecret: this.auth.clientSecret,
        now: this.runtime.now,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.refreshFailure = new CliError(
        `Your session expired and could not be refreshed (${detail}).\nRun \`coco auth login\` to sign in again.`,
        EXIT.auth,
      );
      throw this.refreshFailure;
    }
    this.auth = {
      ...this.auth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? this.auth.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? this.auth.scope,
    };
    this.persist();
    return this.auth.accessToken;
  }

  /** Rotated tokens are single-use: write them down before using them. */
  private persist(): void {
    const config = loadConfig(this.runtime.env);
    const profile = config.profiles[this.profileName];
    if (!profile || profile.auth?.type !== "oauth") return;
    profile.auth = { ...this.auth };
    saveConfig(this.runtime.env, config);
  }
}

/**
 * Wraps the runtime fetch for OAuth profiles: injects the bearer token and
 * retries exactly once after a 401 with a freshly refreshed token.
 */
export function createOauthFetch(
  runtime: CliRuntime,
  profileName: string,
  auth: OauthAuth,
): FetchLike {
  const manager = new OauthTokenManager(runtime, profileName, auth);
  return async (input, init) => {
    const send = (token: string) =>
      runtime.fetch(input, {
        ...init,
        headers: {
          ...((init?.headers as Record<string, string> | undefined) ?? {}),
          authorization: `Bearer ${token}`,
        },
      });
    const token = await manager.currentToken();
    const response = await send(token);
    if (response.status !== 401) return response;
    const freshToken = await manager.tokenAfter401(token);
    if (freshToken === null) return response;
    return send(freshToken);
  };
}
