// The OAuth token lifecycle around API calls: proactive refresh before
// expiry, reactive refresh + single retry on 401, serialized concurrent
// refreshes (single-use rotation), immediate persistence of rotated tokens,
// and the "run `coco auth login`" failure mode.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type OauthAuth } from "./config.js";
import { createContext, createOauthFetch } from "./context.js";
import { CliError } from "./errors.js";
import type { CliRuntime } from "./runtime.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coco-cli-ctx-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Route = (url: string, init?: RequestInit) => Response | undefined;

function makeRuntime(routes: Route[], envExtra: Record<string, string> = {}): {
  runtime: CliRuntime;
  requests: Array<{ url: string; init?: RequestInit }>;
} {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const runtime: CliRuntime = {
    env: { XDG_CONFIG_HOME: dir, ...envExtra },
    fetch: async (url, init) => {
      requests.push({ url, init });
      for (const route of routes) {
        const response = route(url, init);
        if (response) return response;
      }
      return new Response(JSON.stringify({ error: "unrouted" }), { status: 500 });
    },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    openBrowser: async () => true,
    now: () => 1_000_000,
  };
  return { runtime, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oauthProfileAuth(overrides: Partial<OauthAuth> = {}): OauthAuth {
  return {
    type: "oauth",
    clientId: "mcp_abc",
    clientSecret: "s3cret",
    redirectUri: "http://127.0.0.1:39999/callback",
    tokenUrl: "https://coco.test/oauth/token",
    accessToken: "at_old",
    refreshToken: "rt_old",
    expiresAt: 2_000_000, // comfortably in the future vs now()=1_000_000
    scope: "context:read context:write",
    ...overrides,
  };
}

function seedProfile(env: Record<string, string | undefined>, auth: OauthAuth): void {
  saveConfig(env, {
    profiles: { default: { baseUrl: "http://coco.test", auth } },
    activeProfile: "default",
  });
}

const bearerOf = (init?: RequestInit) =>
  ((init?.headers ?? {}) as Record<string, string>).authorization;

describe("createOauthFetch", () => {
  it("sends the stored access token while it is fresh", async () => {
    const { runtime, requests } = makeRuntime([(url) => (url.includes("/pages") ? json({ items: [] }) : undefined)]);
    seedProfile(runtime.env, oauthProfileAuth());
    const fetchWithAuth = createOauthFetch(runtime, "default", oauthProfileAuth());
    await fetchWithAuth("http://coco.test/pages");
    expect(bearerOf(requests[0].init)).toBe("Bearer at_old");
  });

  it("refreshes proactively when the token is at/near expiry and persists the rotation", async () => {
    const { runtime, requests } = makeRuntime([
      (url, init) =>
        url.endsWith("/oauth/token")
          ? json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 })
          : undefined,
      (url) => (url.includes("/pages") ? json({ items: [] }) : undefined),
    ]);
    const auth = oauthProfileAuth({ expiresAt: 1_000_500 }); // < now + 30s skew
    seedProfile(runtime.env, auth);
    const fetchWithAuth = createOauthFetch(runtime, "default", auth);
    await fetchWithAuth("http://coco.test/pages");

    expect(requests[0].url).toBe("https://coco.test/oauth/token");
    const form = new URLSearchParams(String(requests[0].init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt_old");
    expect(bearerOf(requests[1].init)).toBe("Bearer at_new");

    const stored = loadConfig(runtime.env).profiles.default.auth as OauthAuth;
    expect(stored.accessToken).toBe("at_new");
    expect(stored.refreshToken).toBe("rt_new");
    expect(stored.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  it("retries exactly once after a 401 with a refreshed token", async () => {
    let pagesCalls = 0;
    const { runtime, requests } = makeRuntime([
      (url) => {
        if (!url.includes("/pages")) return undefined;
        pagesCalls += 1;
        return pagesCalls === 1 ? json({ error: "Unauthorized" }, 401) : json({ items: [] });
      },
      (url) =>
        url.endsWith("/oauth/token")
          ? json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 })
          : undefined,
    ]);
    const auth = oauthProfileAuth();
    seedProfile(runtime.env, auth);
    const fetchWithAuth = createOauthFetch(runtime, "default", auth);
    const response = await fetchWithAuth("http://coco.test/pages");
    expect(response.status).toBe(200);
    expect(requests.map((request) => request.url)).toEqual([
      "http://coco.test/pages",
      "https://coco.test/oauth/token",
      "http://coco.test/pages",
    ]);
    expect(bearerOf(requests[2].init)).toBe("Bearer at_new");
  });

  it("lets the 401 stand when there is no refresh token (single retry, no loop)", async () => {
    const { runtime, requests } = makeRuntime([(url) => json({ error: "Unauthorized" }, 401)]);
    const auth = oauthProfileAuth({ refreshToken: undefined, expiresAt: undefined });
    seedProfile(runtime.env, auth);
    const fetchWithAuth = createOauthFetch(runtime, "default", auth);
    const response = await fetchWithAuth("http://coco.test/pages");
    expect(response.status).toBe(401);
    expect(requests).toHaveLength(1);
  });

  it("serializes concurrent refreshes so the single-use refresh token is used once", async () => {
    let tokenCalls = 0;
    let pagesCalls = 0;
    const { runtime, requests } = makeRuntime([
      (url) => {
        if (!url.endsWith("/oauth/token")) return undefined;
        tokenCalls += 1;
        return json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 });
      },
      (url) => {
        if (!url.includes("/pages")) return undefined;
        pagesCalls += 1;
        return pagesCalls <= 2 ? json({ error: "Unauthorized" }, 401) : json({ items: [] });
      },
    ]);
    const auth = oauthProfileAuth();
    seedProfile(runtime.env, auth);
    const fetchWithAuth = createOauthFetch(runtime, "default", auth);
    const [a, b] = await Promise.all([
      fetchWithAuth("http://coco.test/pages"),
      fetchWithAuth("http://coco.test/pages"),
    ]);
    expect(tokenCalls).toBe(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    void requests;
  });

  it("turns a failed refresh into a 'run coco auth login' error", async () => {
    const { runtime } = makeRuntime([
      (url) =>
        url.endsWith("/oauth/token")
          ? json({ error: "invalid_grant", error_description: "refresh token expired." }, 400)
          : json({ error: "Unauthorized" }, 401),
    ]);
    const auth = oauthProfileAuth({ expiresAt: 0 }); // forces proactive refresh
    seedProfile(runtime.env, auth);
    const fetchWithAuth = createOauthFetch(runtime, "default", auth);
    const error = await fetchWithAuth("http://coco.test/pages").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(4);
    expect((error as CliError).message).toContain("coco auth login");
  });
});

describe("createContext credential precedence", () => {
  it("COCO_API_KEY beats the profile credential", async () => {
    const { runtime, requests } = makeRuntime(
      [() => json({ ok: true })],
      { COCO_API_KEY: "coco_env_key", COCO_BASE_URL: "http://env.test" },
    );
    seedProfile(runtime.env, oauthProfileAuth());
    const context = createContext(runtime, {});
    expect(context.credential.kind).toBe("key");
    expect(context.baseUrl).toBe("http://env.test");
    await context.client.health();
    expect(bearerOf(requests[0].init)).toBe("Bearer coco_env_key");
  });

  it("--base-url beats COCO_BASE_URL which beats the profile", () => {
    const { runtime } = makeRuntime([], { COCO_BASE_URL: "http://env.test" });
    seedProfile(runtime.env, oauthProfileAuth());
    expect(createContext(runtime, {}).baseUrl).toBe("http://env.test");
    expect(createContext(runtime, { baseUrl: "http://flag.test" }).baseUrl).toBe("http://flag.test");
  });

  it("falls back to the profile, then the localhost default", () => {
    const { runtime } = makeRuntime([]);
    expect(createContext(runtime, {}).baseUrl).toBe("http://localhost:8787");
    seedProfile(runtime.env, oauthProfileAuth());
    expect(createContext(runtime, {}).baseUrl).toBe("http://coco.test");
  });

  it("rejects --profile names that don't exist", () => {
    const { runtime } = makeRuntime([]);
    expect(() => createContext(runtime, { profile: "nope" })).toThrowError(/does not exist/);
  });
});
