// The OAuth 2.0 authorization-code + PKCE flow against the platform's own
// authorization server (see specs/OAUTH-REST-ACCESS.md):
//
//   1. discover endpoints from /.well-known/oauth-authorization-server (RFC 8414)
//   2. dynamically register a client with a loopback redirect URI (RFC 7591);
//      the registration (client_id + client_secret) is cached per profile
//   3. run a temporary 127.0.0.1 HTTP server, open the browser at /oauth/authorize
//      (S256 code_challenge + state), and catch the redirect
//   4. exchange the code at the token endpoint (client_secret_post)
//   5. refresh with grant_type=refresh_token — tokens are single-use rotated,
//      so refreshes are serialized and persisted immediately by the caller
//
// These endpoints are auth *flows*, deliberately outside coconut-sdk's surface,
// so the CLI speaks to them directly with plain fetch.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { FetchLike } from "coconut-sdk";
import { CliError, EXIT } from "./errors.js";

// --------------------------------------------------------------------------
// PKCE + state
// --------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256: a 43-128 char verifier and its SHA-256 challenge. */
export function createPkcePair(random: () => Buffer = () => randomBytes(32)): PkcePair {
  const verifier = base64Url(random());
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64Url(randomBytes(16));
}

// --------------------------------------------------------------------------
// Discovery + registration
// --------------------------------------------------------------------------

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The trust rule for every OAuth URL the CLI will send secrets to or open
 * in a browser: http(s) only, https unless the host is loopback (local dev
 * stacks), and — against authorization-server mix-up — the same origin as
 * the base URL the user asked to sign in to.
 */
export function assertTrustedOauthEndpoint(
  rawUrl: string,
  field: string,
  expectedOrigin?: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliError(`OAuth ${field} is not a valid URL: ${rawUrl}`, EXIT.auth);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CliError(`OAuth ${field} must be an http(s) URL, got "${rawUrl}".`, EXIT.auth);
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new CliError(
      `OAuth ${field} must use https (plain http is only allowed for localhost dev stacks): ${rawUrl}`,
      EXIT.auth,
    );
  }
  if (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) {
    throw new CliError(
      `OAuth ${field} (${rawUrl}) is not on ${expectedOrigin}. Refusing a cross-origin authorization server (mix-up protection) — if this deployment really hosts OAuth elsewhere, sign in with \`coco auth login --key\` instead.`,
      EXIT.auth,
    );
  }
  return parsed;
}

export async function discoverAuthServer(
  fetchImpl: FetchLike,
  baseUrl: string,
): Promise<AuthServerMetadata> {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const baseOrigin = assertTrustedOauthEndpoint(normalizedBase, "base URL").origin;
  const url = `${normalizedBase}/.well-known/oauth-authorization-server`;
  let response: Response;
  try {
    // No redirect following: a 302 here could swap in another server's
    // (or an attacker's) metadata behind the user's chosen base URL.
    response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error" });
  } catch (error) {
    throw new CliError(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.connection,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `OAuth discovery failed (${response.status} from ${url}). This deployment may not expose the OAuth authorization server — use \`coco auth login --key\` with an agent key instead.`,
      EXIT.auth,
    );
  }
  const metadata = (await response.json()) as Partial<AuthServerMetadata>;
  // RFC 8414 §3.3: the issuer must be the value the well-known URI was
  // derived from — anything else is a misconfiguration or a mix-up attempt.
  if (typeof metadata.issuer !== "string" || metadata.issuer.replace(/\/+$/, "") !== normalizedBase) {
    throw new CliError(
      `OAuth discovery document at ${url} declares issuer "${metadata.issuer ?? "(none)"}", which does not match ${normalizedBase}. Re-run with --base-url set to the deployment's canonical URL.`,
      EXIT.auth,
    );
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const) {
    if (typeof metadata[field] !== "string") {
      throw new CliError(`OAuth discovery document at ${url} is missing ${field}.`, EXIT.auth);
    }
    assertTrustedOauthEndpoint(metadata[field] as string, field, baseOrigin);
  }
  return metadata as AuthServerMetadata;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Registers a fresh client bound to one loopback redirect URI (RFC 7591). */
export async function registerClient(
  fetchImpl: FetchLike,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<RegisteredClient> {
  const response = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
    redirect: "error",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.client_id !== "string" || typeof body.client_secret !== "string") {
    const description =
      typeof body.error_description === "string" ? body.error_description : `HTTP ${response.status}`;
    throw new CliError(`OAuth client registration failed: ${description}`, EXIT.auth);
  }
  return { clientId: body.client_id, clientSecret: body.client_secret, redirectUri };
}

// --------------------------------------------------------------------------
// Token endpoint
// --------------------------------------------------------------------------

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; derived from expires_in at receipt time. */
  expiresAt?: number;
  scope?: string;
}

async function postTokenEndpoint(
  fetchImpl: FetchLike,
  tokenUrl: string,
  form: Record<string, string>,
  now: () => number,
): Promise<TokenResponse> {
  // Re-checked on every call — the refresh path reuses a tokenUrl stored in
  // the profile, and this request carries the client secret + grant.
  assertTrustedOauthEndpoint(tokenUrl, "token_endpoint");
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
    });
  } catch (error) {
    throw new CliError(
      `Could not reach the token endpoint (${tokenUrl}): ${error instanceof Error ? error.message : String(error)}`,
      EXIT.connection,
    );
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    const description = typeof body.error_description === "string" ? body.error_description : "";
    throw new CliError(
      `Token request failed (${code})${description ? `: ${description}` : ""}`,
      EXIT.auth,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt: typeof body.expires_in === "number" ? now() + body.expires_in * 1000 : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

export function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  options: {
    tokenUrl: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    now?: () => number;
  },
): Promise<TokenResponse> {
  return postTokenEndpoint(
    fetchImpl,
    options.tokenUrl,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    },
    options.now ?? (() => Date.now()),
  );
}

export function refreshAccessToken(
  fetchImpl: FetchLike,
  options: {
    tokenUrl: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
    now?: () => number;
  },
): Promise<TokenResponse> {
  return postTokenEndpoint(
    fetchImpl,
    options.tokenUrl,
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    },
    options.now ?? (() => Date.now()),
  );
}

// --------------------------------------------------------------------------
// Loopback redirect listener
// --------------------------------------------------------------------------

const CALLBACK_PATH = "/callback";
const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>coco</title>
<body style="font-family: system-ui; margin: 4rem auto; max-width: 28rem">
<h1 style="font-size:1.2rem">%HEADING%</h1><p>%DETAIL%</p><p>You can close this tab.</p></body>`;

function renderCallbackPage(heading: string, detail: string): string {
  return CALLBACK_PAGE.replace("%HEADING%", heading).replace("%DETAIL%", detail);
}

export interface LoopbackServer {
  port: number;
  redirectUri: string;
  /** Resolves with the authorization code once the browser redirects back. */
  waitForCode(expectedState: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

/**
 * Starts the temporary callback server on 127.0.0.1. `port` 0 lets the OS
 * pick a free random port; a specific port re-binds a previously registered
 * redirect URI (ports are baked into the client registration).
 */
export function startLoopbackServer(port: number): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
    let expectedState = "";

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const fail = (message: string) => {
        response
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(renderCallbackPage("Sign-in failed", message));
        settle?.reject(new CliError(`OAuth authorization failed: ${message}`, EXIT.auth));
        settle = undefined;
      };
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        fail(url.searchParams.get("error_description") ?? oauthError);
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        fail("the redirect carried no authorization code");
        return;
      }
      if (state !== expectedState) {
        fail("state mismatch — possible interception; try again");
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(renderCallbackPage("Signed in", "coco received the authorization code."));
      settle?.resolve(code);
      settle = undefined;
    });

    server.on("error", (error) => reject(error));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new CliError("Could not determine the callback server port.", EXIT.unexpected));
        return;
      }
      const boundPort = address.port;
      resolve({
        port: boundPort,
        redirectUri: `http://127.0.0.1:${boundPort}${CALLBACK_PATH}`,
        waitForCode(state, timeoutMs) {
          expectedState = state;
          return new Promise<string>((resolveCode, rejectCode) => {
            const timer = setTimeout(() => {
              settle = undefined;
              rejectCode(
                new CliError(
                  `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser sign-in. Run \`coco auth login\` to try again.`,
                  EXIT.auth,
                ),
              );
            }, timeoutMs);
            settle = {
              resolve: (code) => {
                clearTimeout(timer);
                resolveCode(code);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectCode(error);
              },
            };
          });
        },
        close() {
          return new Promise((resolveClose) => {
            server.close(() => resolveClose());
            // Pending keep-alive connections would otherwise hold the process.
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

/** Builds the /oauth/authorize URL for the browser. */
export function buildAuthorizeUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  codeChallenge: string;
}): string {
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
