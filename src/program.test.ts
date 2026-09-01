// End-to-end argument→request mapping: run real CLI invocations against a
// recording mock fetch and assert the HTTP calls the SDK was driven to make,
// the stdout contract (--json purity), and the documented exit codes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./program.js";
import type { CliRuntime } from "./runtime.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coco-cli-prog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Recorded = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Canned = { status?: number; body?: unknown };

function capture() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function makeHarness(responses: Canned[], envExtra: Record<string, string> = {}) {
  const requests: Recorded[] = [];
  const stdout = capture();
  const stderr = capture();
  const runtime: CliRuntime = {
    env: {
      XDG_CONFIG_HOME: dir,
      COCO_BASE_URL: "http://coco.test",
      COCO_API_KEY: "coco_test_key",
      ...envExtra,
    },
    fetch: async (url, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: new URL(url),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        ),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const canned = responses.shift() ?? { status: 200, body: {} };
      const isText = typeof canned.body === "string";
      return new Response(isText ? (canned.body as string) : JSON.stringify(canned.body ?? {}), {
        status: canned.status ?? 200,
        headers: { "content-type": isText ? "text/markdown; charset=utf-8" : "application/json" },
      });
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Object.assign(new PassThrough(), { isTTY: true }),
    openBrowser: async () => true,
    now: () => 1_000_000,
  };
  return {
    runtime,
    requests,
    stdout: stdout.text,
    stderr: stderr.text,
    run: (args: string[]) => runCli(runtime, args),
  };
}

describe("read commands → SDK calls", () => {
  it("spaces list --stats requests the stats rollup and renders a table", async () => {
    const harness = makeHarness([
      {
        body: {
          items: [
            {
              slug: "deals",
              name: "Deals",
              description: "Pipeline",
              visibility: "org",
              pageCount: 12,
              lastUpdatedAt: "2026-08-20T10:00:00Z",
            },
          ],
        },
      },
    ]);
    const code = await harness.run(["spaces", "list", "--stats"]);
    expect(code).toBe(0);
    expect(harness.requests[0].url.pathname).toBe("/spaces");
    expect(harness.requests[0].url.searchParams.get("include")).toBe("stats");
    expect(harness.requests[0].headers.authorization).toBe("Bearer coco_test_key");
    expect(harness.stdout()).toContain("deals");
    expect(harness.stdout()).toContain("12");
  });

  it("query translates --filter expressions into API metadata filters", async () => {
    const harness = makeHarness([{ body: { filters: [], space: "deals", items: [] } }]);
    const code = await harness.run([
      "query",
      "--filter",
      "stage=diligence",
      "--filter",
      "conviction-score>=0.7",
      "--filter",
      "flags:missing",
      "--space",
      "deals",
      "--order-by",
      "conviction-score",
      "--desc",
    ]);
    expect(code).toBe(0);
    const url = harness.requests[0].url;
    expect(url.pathname).toBe("/search/metadata");
    expect(JSON.parse(url.searchParams.get("filters") ?? "[]")).toEqual([
      { key: "stage", op: "eq", value: "diligence" },
      { key: "conviction-score", op: "gte", value: 0.7 },
      { key: "flags", op: "missing" },
    ]);
    expect(url.searchParams.get("space")).toBe("deals");
    expect(url.searchParams.get("orderBy")).toBe("conviction-score");
    expect(url.searchParams.get("order")).toBe("desc");
  });

  it("records list adds the implicit template stamp before extra filters", async () => {
    const harness = makeHarness([{ body: { filters: [], space: "deals", items: [] } }]);
    const code = await harness.run([
      "records",
      "list",
      "deals",
      "deal-memo",
      "--filter",
      "stage=diligence",
    ]);
    expect(code).toBe(0);
    const filters = JSON.parse(harness.requests[0].url.searchParams.get("filters") ?? "[]");
    expect(filters[0]).toEqual({ key: "template", op: "eq", value: "deal-memo" });
    expect(filters[1]).toEqual({ key: "stage", op: "eq", value: "diligence" });
  });

  it("--json prints exactly the API payload on stdout", async () => {
    const payload = { items: [{ slug: "deals", name: "Deals", description: "", visibility: null }] };
    const harness = makeHarness([{ body: payload }]);
    const code = await harness.run(["spaces", "list", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(harness.stdout())).toEqual(payload);
  });

  it("page get defaults to markdown output", async () => {
    const harness = makeHarness([{ body: "---\ntitle: Acme\n---\n\n# Acme\n" }]);
    const code = await harness.run(["page", "get", "deals/acme"]);
    expect(code).toBe(0);
    expect(harness.requests[0].headers.accept).toBe("text/markdown");
    expect(harness.stdout()).toContain("# Acme");
  });
});

describe("page put create-vs-update", () => {
  it("creates with template + metadata when the page does not exist", async () => {
    const harness = makeHarness([
      { status: 404, body: { error: "Not found" } },
      { status: 201, body: { path: "deals/acme", version: 1 } },
    ]);
    const code = await harness.run([
      "page",
      "put",
      "deals/acme",
      "--title",
      "Acme",
      "--template",
      "deal-memo",
      "--metadata",
      "stage=sourcing",
      "--metadata",
      "conviction-score=0.4",
    ]);
    expect(code).toBe(0);
    expect(harness.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(harness.requests[1].headers["if-match"]).toBeUndefined();
    expect(harness.requests[1].body).toMatchObject({
      title: "Acme",
      template: "deal-memo",
      metadata: { stage: "sourcing", "conviction-score": 0.4 },
    });
  });

  it("updates with If-Match from the read version and patches metadata separately", async () => {
    const page = {
      path: "deals/acme",
      title: "Acme",
      version: 3,
      updatedAt: "",
      frontmatter: {},
      content: "# Acme\n",
    };
    const harness = makeHarness([
      { body: page },
      { body: { path: "deals/acme", version: 4 } },
      { body: { path: "deals/acme", metadata: { stage: "diligence" }, entries: [] } },
    ]);
    const contentFile = join(dir, "memo.md");
    writeFileSync(contentFile, "# Acme v4\n");
    const code = await harness.run([
      "page",
      "put",
      "deals/acme",
      "--file",
      contentFile,
      "--metadata",
      "stage=diligence",
    ]);
    expect(code).toBe(0);
    expect(harness.requests[1].method).toBe("PUT");
    expect(harness.requests[1].headers["if-match"]).toBe('W/"3"');
    expect(harness.requests[1].body).toMatchObject({ content: "# Acme v4\n" });
    expect(harness.requests[2].method).toBe("PATCH");
    expect(harness.requests[2].body).toEqual({ set: { stage: "diligence" } });
  });

  it("maps a 412 on the write to exit code 6 with a conflict explanation", async () => {
    const page = { path: "deals/acme", title: "A", version: 3, updatedAt: "", frontmatter: {}, content: "x" };
    const harness = makeHarness([
      { body: page },
      { status: 412, body: { error: "Version conflict" } },
    ]);
    const contentFile = join(dir, "memo.md");
    writeFileSync(contentFile, "# next\n");
    const code = await harness.run(["page", "put", "deals/acme", "--file", contentFile]);
    expect(code).toBe(6);
    expect(harness.stderr()).toContain("Concurrent edit");
  });
});

describe("meta patch", () => {
  it("builds set/append/append-unique with JSON values and null deletion", async () => {
    const harness = makeHarness([{ body: { path: "deals/acme", metadata: {}, entries: [] } }]);
    const code = await harness.run([
      "meta",
      "patch",
      "deals/acme",
      "--set",
      "stage=diligence",
      "--set",
      "flags=null",
      "--append-unique",
      "sources=https://news.example/acme",
    ]);
    expect(code).toBe(0);
    expect(harness.requests[0].method).toBe("PATCH");
    expect(harness.requests[0].url.pathname).toBe("/pages/deals/acme/metadata");
    expect(harness.requests[0].body).toEqual({
      set: { stage: "diligence", flags: null },
      appendUnique: { sources: "https://news.example/acme" },
    });
  });

  it("rejects an empty patch as a usage error", async () => {
    const harness = makeHarness([]);
    const code = await harness.run(["meta", "patch", "deals/acme"]);
    expect(code).toBe(2);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("append value coercion", () => {
  it("passes scalar append values through (the API wraps them into arrays)", async () => {
    const harness = makeHarness([{ body: { path: "p", metadata: {}, entries: [] } }]);
    await harness.run(["meta", "patch", "p", "--append", "tags=hot"]);
    expect(harness.requests[0].body).toEqual({ append: { tags: "hot" } });
  });
});

describe("error → exit code mapping", () => {
  it("404 → 5", async () => {
    const harness = makeHarness([{ status: 404, body: { error: "Not found" } }]);
    expect(await harness.run(["page", "get", "deals/missing"])).toBe(5);
    expect(harness.stderr()).toContain("Not found");
  });

  it("403 → 7 with reasonCode and nextSteps surfaced", async () => {
    const harness = makeHarness([
      {
        status: 403,
        body: {
          error: "Forbidden",
          reasonCode: "space_membership_required",
          nextSteps: ["Ask a space admin to add you."],
        },
      },
    ]);
    expect(await harness.run(["page", "get", "private/x"])).toBe(7);
    expect(harness.stderr()).toContain("space_membership_required");
    expect(harness.stderr()).toContain("Ask a space admin to add you.");
  });

  it("401 → 4 with a login hint", async () => {
    const harness = makeHarness([{ status: 401, body: { error: "Unauthorized" } }]);
    expect(await harness.run(["whoami"])).toBe(4);
    expect(harness.stderr()).toContain("coco auth login");
  });

  it("failed OAuth refresh → 4 with a login hint, even through the SDK's retry wrapper", async () => {
    const harness = makeHarness([]);
    delete harness.runtime.env.COCO_API_KEY;
    mkdirSync(join(dir, "coco"), { recursive: true });
    writeFileSync(
      join(dir, "coco", "config.json"),
      JSON.stringify({
        activeProfile: "oauth",
        profiles: {
          oauth: {
            baseUrl: "http://coco.test",
            auth: {
              type: "oauth",
              clientId: "c",
              clientSecret: "s",
              redirectUri: "http://127.0.0.1:1/callback",
              tokenUrl: "https://coco.test/oauth/token",
              accessToken: "at_stale",
              refreshToken: "rt_stale",
              expiresAt: 1, // long expired vs runtime.now()=1_000_000
              scope: "context:read context:write",
            },
          },
        },
      }),
    );
    harness.runtime.fetch = async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("/oauth/token")
            ? { error: "invalid_grant", error_description: "refresh token expired." }
            : { error: "Unauthorized" },
        ),
        { status: url.endsWith("/oauth/token") ? 400 : 401, headers: { "content-type": "application/json" } },
      );
    expect(await harness.run(["whoami"])).toBe(4);
    expect(harness.stderr()).toContain("coco auth login");
    expect(harness.stderr()).toContain("could not be refreshed");
  });

  it("guards page delete to personal paths without calling the API", async () => {
    const harness = makeHarness([]);
    expect(await harness.run(["page", "delete", "deals/acme"])).toBe(2);
    expect(harness.requests).toHaveLength(0);
    expect(harness.stderr()).toContain("personal");
  });
});

describe("profiles", () => {
  it("login --key via stdin, then status and profile list read it back", async () => {
    const stdin = new PassThrough();
    const harness = makeHarness(
      [
        // login: verification session probe
        { body: { principal: { id: "agent-1", kind: "agent", scopes: ["read", "write"] }, identity: null } },
        // status: health + session
        { body: { ok: true } },
        { body: { principal: { id: "agent-1", kind: "agent", scopes: ["read", "write"] }, identity: null } },
      ],
      { COCO_API_KEY: "" },
    );
    delete harness.runtime.env.COCO_API_KEY;
    harness.runtime.stdin = stdin;
    stdin.end("dev-agent-key-change-me\n");

    expect(await harness.run(["auth", "login", "--key", "--base-url", "http://coco.test"])).toBe(0);

    const stored = JSON.parse(readFileSync(join(dir, "coco", "config.json"), "utf8"));
    expect(stored.profiles.default.auth).toEqual({ type: "key", apiKey: "dev-agent-key-change-me" });
    expect(stored.activeProfile).toBe("default");

    expect(await harness.run(["auth", "status"])).toBe(0);
    const statusOut = harness.stdout();
    expect(statusOut).toContain("agent agent-1");
    expect(statusOut).not.toContain("dev-agent-key-change-me");

    expect(await harness.run(["profile", "list"])).toBe(0);
    expect(harness.stdout()).toContain("default");
  });
});
