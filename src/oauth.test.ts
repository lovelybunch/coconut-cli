import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import {
  base64Url,
  buildAuthorizeUrl,
  createPkcePair,
  discoverAuthServer,
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient,
  startLoopbackServer,
} from "./oauth.js";

type Recorded = { url: string; init?: RequestInit };

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const requests: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const canned = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(canned.body), {
      status: canned.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, requests };
}

describe("PKCE", () => {
  it("derives the S256 challenge from the verifier", () => {
    const pair = createPkcePair(() => Buffer.from("0123456789abcdef0123456789abcdef"));
    expect(pair.verifier).toBe(base64Url(Buffer.from("0123456789abcdef0123456789abcdef")));
    expect(pair.challenge).toBe(base64Url(createHash("sha256").update(pair.verifier).digest()));
    // base64url alphabet only — no padding, no +, no /.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("meets the RFC 7636 length window", () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
  });
});

function validMetadata(origin = "https://coco.test") {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
  };
}

describe("discovery", () => {
  it("reads the RFC 8414 well-known document without following redirects", async () => {
    const { fetch, requests } = mockFetch([{ body: validMetadata() }]);
    const metadata = await discoverAuthServer(fetch, "https://coco.test/");
    expect(requests[0].url).toBe("https://coco.test/.well-known/oauth-authorization-server");
    expect(requests[0].init?.redirect).toBe("error");
    expect(metadata.token_endpoint).toBe("https://coco.test/oauth/token");
  });

  it("allows plain http for loopback dev stacks", async () => {
    const { fetch } = mockFetch([{ body: validMetadata("http://127.0.0.1:8787") }]);
    const metadata = await discoverAuthServer(fetch, "http://127.0.0.1:8787");
    expect(metadata.authorization_endpoint).toBe("http://127.0.0.1:8787/oauth/authorize");
  });

  it("rejects a plain-http base URL for non-loopback hosts before any request", async () => {
    const { fetch, requests } = mockFetch([]);
    await expect(discoverAuthServer(fetch, "http://coco.test")).rejects.toThrowError(/https/);
    expect(requests).toHaveLength(0);
  });

  it("rejects an issuer that does not match the base URL (mix-up protection)", async () => {
    const { fetch } = mockFetch([
      { body: { ...validMetadata(), issuer: "https://evil.example" } },
    ]);
    await expect(discoverAuthServer(fetch, "https://coco.test")).rejects.toThrowError(
      /issuer.*does not match/,
    );
  });

  it("rejects endpoints on a different origin (mix-up protection)", async () => {
    const { fetch } = mockFetch([
      { body: { ...validMetadata(), token_endpoint: "https://evil.example/oauth/token" } },
    ]);
    await expect(discoverAuthServer(fetch, "https://coco.test")).rejects.toThrowError(
      /token_endpoint.*not on https:\/\/coco\.test/,
    );
  });

  it("rejects non-https endpoints on non-loopback hosts", async () => {
    const { fetch } = mockFetch([
      { body: { ...validMetadata(), authorization_endpoint: "http://coco.test/oauth/authorize" } },
    ]);
    await expect(discoverAuthServer(fetch, "https://coco.test")).rejects.toThrowError(/https/);
  });

  it("points key-based setups at --key when discovery 404s", async () => {
    const { fetch } = mockFetch([{ status: 404, body: {} }]);
    await expect(discoverAuthServer(fetch, "https://coco.test")).rejects.toThrowError(/--key/);
  });

  it("rejects discovery documents missing endpoints", async () => {
    const { fetch } = mockFetch([
      { body: { issuer: "https://coco.test", token_endpoint: "https://coco.test/oauth/token" } },
    ]);
    await expect(discoverAuthServer(fetch, "https://coco.test")).rejects.toThrowError(
      /authorization_endpoint/,
    );
  });
});

describe("registration", () => {
  it("registers a loopback redirect and returns the client pair", async () => {
    const { fetch, requests } = mockFetch([
      { body: { client_id: "mcp_abc", client_secret: "s3cret", redirect_uris: ["http://127.0.0.1:1234/callback"] } },
    ]);
    const client = await registerClient(fetch, "https://coco.test/oauth/register", "http://127.0.0.1:1234/callback");
    expect(client).toEqual({
      clientId: "mcp_abc",
      clientSecret: "s3cret",
      redirectUri: "http://127.0.0.1:1234/callback",
    });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      redirect_uris: ["http://127.0.0.1:1234/callback"],
    });
  });

  it("surfaces the server's error_description", async () => {
    const { fetch } = mockFetch([
      { status: 400, body: { error: "invalid_client_metadata", error_description: "bad redirect" } },
    ]);
    await expect(
      registerClient(fetch, "https://coco.test/oauth/register", "javascript:alert(1)"),
    ).rejects.toThrowError(/bad redirect/);
  });
});

describe("token endpoint", () => {
  it("exchanges the code with PKCE verifier and client_secret_post credentials", async () => {
    const { fetch, requests } = mockFetch([
      {
        body: {
          access_token: "at_1",
          refresh_token: "rt_1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "context:read context:write",
        },
      },
    ]);
    const tokens = await exchangeAuthorizationCode(fetch, {
      tokenUrl: "https://coco.test/oauth/token",
      code: "oc_code",
      redirectUri: "http://127.0.0.1:1234/callback",
      codeVerifier: "verifier",
      clientId: "mcp_abc",
      clientSecret: "s3cret",
      now: () => 1_000_000,
    });
    expect(tokens).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAt: 1_000_000 + 3_600_000,
      scope: "context:read context:write",
    });
    const form = new URLSearchParams(String(requests[0].init?.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("verifier");
    expect(form.get("client_id")).toBe("mcp_abc");
    expect(form.get("client_secret")).toBe("s3cret");
    expect(requests[0].init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
  });

  it("refreshes with grant_type=refresh_token and returns the rotated pair", async () => {
    const { fetch, requests } = mockFetch([
      { body: { access_token: "at_2", refresh_token: "rt_2", expires_in: 3600 } },
    ]);
    const tokens = await refreshAccessToken(fetch, {
      tokenUrl: "https://coco.test/oauth/token",
      refreshToken: "rt_1",
      clientId: "mcp_abc",
      clientSecret: "s3cret",
      now: () => 0,
    });
    expect(tokens.accessToken).toBe("at_2");
    expect(tokens.refreshToken).toBe("rt_2");
    const form = new URLSearchParams(String(requests[0].init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt_1");
  });

  it("maps invalid_grant to an auth error with the description", async () => {
    const { fetch } = mockFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "refresh token expired." } },
    ]);
    await expect(
      refreshAccessToken(fetch, {
        tokenUrl: "https://coco.test/oauth/token",
        refreshToken: "rt_old",
        clientId: "c",
        clientSecret: "s",
      }),
    ).rejects.toThrowError(/invalid_grant.*refresh token expired/);
  });

  it("refuses to send the grant to a non-https token endpoint (refresh path included)", async () => {
    const { fetch, requests } = mockFetch([]);
    await expect(
      refreshAccessToken(fetch, {
        tokenUrl: "http://coco.test/oauth/token",
        refreshToken: "rt_1",
        clientId: "c",
        clientSecret: "s",
      }),
    ).rejects.toThrowError(/https/);
    expect(requests).toHaveLength(0);
  });
});

describe("authorize URL", () => {
  it("carries PKCE S256, state, and the requested scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://coco.test/oauth/authorize",
        clientId: "mcp_abc",
        redirectUri: "http://127.0.0.1:1234/callback",
        state: "st",
        scope: "context:read context:write",
        codeChallenge: "chal",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("context:read context:write");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("loopback server", () => {
  it("resolves the code when state matches, and serves a close-tab page", async () => {
    const server = await startLoopbackServer(0);
    try {
      const pending = server.waitForCode("expected-state", 5000);
      const response = await fetch(`${server.redirectUri}?code=oc_x&state=expected-state`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("close this tab");
      await expect(pending).resolves.toBe("oc_x");
    } finally {
      await server.close();
    }
  });

  it("rejects on a state mismatch", async () => {
    const server = await startLoopbackServer(0);
    try {
      // Capture the rejection eagerly — it lands mid-callback, before the
      // HTTP response reaches the test.
      const outcome = server.waitForCode("expected-state", 5000).then(
        () => "resolved",
        (error: Error) => error,
      );
      const response = await fetch(`${server.redirectUri}?code=oc_x&state=wrong`);
      expect(response.status).toBe(400);
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/state mismatch/) });
    } finally {
      await server.close();
    }
  });

  it("relays RFC 6749 error redirects as failures", async () => {
    const server = await startLoopbackServer(0);
    try {
      const outcome = server.waitForCode("st", 5000).then(
        () => "resolved",
        (error: Error) => error,
      );
      await fetch(`${server.redirectUri}?error=access_denied&error_description=no%20org%20membership`);
      expect(await outcome).toMatchObject({
        message: expect.stringMatching(/no org membership/),
      });
    } finally {
      await server.close();
    }
  });

  it("times out into a login hint", async () => {
    const server = await startLoopbackServer(0);
    try {
      await expect(server.waitForCode("st", 10)).rejects.toThrowError(CliError);
    } finally {
      await server.close();
    }
  });
});
