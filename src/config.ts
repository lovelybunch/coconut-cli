// Profile storage: ~/.config/coco/config.json (XDG_CONFIG_HOME respected),
// file mode 0600 because it holds credentials. The file is small and read
// fresh on every command; writes go through a temp file + rename so a crash
// mid-write never leaves a truncated config behind.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";

export interface KeyAuth {
  type: "key";
  apiKey: string;
}

export interface OauthAuth {
  type: "oauth";
  /** Dynamically registered client, cached per profile (RFC 7591). */
  clientId: string;
  clientSecret: string;
  /** The loopback redirect URI the client was registered with. */
  redirectUri: string;
  /** Token endpoint discovered at login time. */
  tokenUrl: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  /** Granted OAuth scopes (e.g. "context:read context:write"). */
  scope?: string;
}

export type ProfileAuth = KeyAuth | OauthAuth;

export interface Profile {
  baseUrl: string;
  orgSlug?: string;
  auth?: ProfileAuth;
}

export interface CliConfig {
  profiles: Record<string, Profile>;
  activeProfile?: string;
}

const EMPTY_CONFIG: CliConfig = { profiles: {} };

export function configPath(env: Record<string, string | undefined>): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(env.HOME ?? homedir(), ".config");
  return join(base, "coco", "config.json");
}

export function loadConfig(env: Record<string, string | undefined>): CliConfig {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_CONFIG);
    throw new CliError(`Could not read ${path}: ${(error as Error).message}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${path} is not valid JSON. Fix or remove it, then run \`coco auth login\` again.`,
      1,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${path} has an unexpected shape (want an object).`, 1);
  }
  const config = parsed as Partial<CliConfig>;
  return {
    profiles:
      config.profiles && typeof config.profiles === "object" && !Array.isArray(config.profiles)
        ? (config.profiles as Record<string, Profile>)
        : {},
    activeProfile: typeof config.activeProfile === "string" ? config.activeProfile : undefined,
  };
}

export function saveConfig(env: Record<string, string | undefined>, config: CliConfig): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
  // writeFileSync's mode only applies on create; a pre-existing file (or an
  // inherited umask) could leave it wider, so pin it after the rename too.
  chmodSync(path, 0o600);
}

/** The profile name a command targets: --profile > activeProfile > "default". */
export function resolveProfileName(
  config: CliConfig,
  explicit: string | undefined,
): string {
  return explicit ?? config.activeProfile ?? "default";
}

/** Shows enough of a secret to recognize it without disclosing it. */
export function redactSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
