// `coco inbox` → SDK calls: argument mapping, table rendering, exit codes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./program.js";
import type { CliRuntime } from "./runtime.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coco-cli-inbox-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Recorded = { method: string; url: URL; body: unknown };

function capture() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function makeHarness(responses: Array<{ status?: number; body?: unknown }>) {
  const requests: Recorded[] = [];
  const stdout = capture();
  const stderr = capture();
  const runtime: CliRuntime = {
    env: { XDG_CONFIG_HOME: dir, COCO_BASE_URL: "http://coco.test", COCO_API_KEY: "coco_key" },
    fetch: async (url, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: new URL(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const canned = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(canned.body ?? {}), {
        status: canned.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Object.assign(new PassThrough(), { isTTY: true }),
    openBrowser: async () => true,
    now: () => 1_000_000,
  };
  return {
    requests,
    stdout: stdout.text,
    stderr: stderr.text,
    run: (args: string[]) => runCli(runtime, args),
  };
}

const item = {
  id: "11111111-1111-4111-8111-111111111111",
  count: 3,
  occurredAt: "2026-09-17T10:05:00.000Z",
  readAt: null,
  summary: '"Acme Corp" was updated 3 times, most recently by Olivia',
  event: {
    id: "e1",
    category: "page",
    type: "page.updated",
    spaceSlug: "deals",
    subjectPath: "deals/acme",
    subjectTitle: "Acme Corp",
    actor: { id: "a1", kind: "agent", label: "Olivia" },
    payload: {},
    occurredAt: "2026-09-17T10:05:00.000Z",
  },
};

describe("coco inbox", () => {
  it("lists with --unread/--limit/--before and renders a table", async () => {
    const harness = makeHarness([
      { body: { items: [item], unread: 1, nextBefore: null, limit: 5, unreadOnly: true } },
    ]);
    const code = await harness.run([
      "inbox",
      "--unread",
      "--limit",
      "5",
      "--before",
      "2026-09-17T11:00:00.000Z",
    ]);
    expect(code).toBe(0);
    const request = harness.requests[0];
    expect(request.url.pathname).toBe("/notifications");
    expect(request.url.searchParams.get("unread")).toBe("1");
    expect(request.url.searchParams.get("limit")).toBe("5");
    expect(request.url.searchParams.get("before")).toBe("2026-09-17T11:00:00.000Z");
    expect(request.url.searchParams.has("space")).toBe(false);
    expect(harness.stdout()).toContain("Acme Corp");
    expect(harness.stdout()).toContain("deals/acme");
    expect(harness.stderr()).toContain("1 unread");
  });

  it("narrows the listing to one space with --space", async () => {
    const harness = makeHarness([
      { body: { items: [item], unread: 1, nextBefore: null, limit: 20, unreadOnly: false } },
    ]);
    expect(await harness.run(["inbox", "--space", "deals"])).toBe(0);
    expect(harness.requests[0].url.pathname).toBe("/notifications");
    expect(harness.requests[0].url.searchParams.get("space")).toBe("deals");
  });

  it("emits the raw payload with --json", async () => {
    const payload = { items: [item], unread: 1, nextBefore: null, limit: 20, unreadOnly: false };
    const harness = makeHarness([{ body: payload }]);
    expect(await harness.run(["inbox", "--json"])).toBe(0);
    expect(JSON.parse(harness.stdout())).toEqual(payload);
  });

  it("prints the unread count alone", async () => {
    const harness = makeHarness([{ body: { unread: 4 } }]);
    expect(await harness.run(["inbox", "count"])).toBe(0);
    expect(harness.requests[0].url.pathname).toBe("/notifications/unread-count");
    expect(harness.stdout().trim()).toBe("4");
  });

  it("counts one space's share with --space, from the summary's per-space split", async () => {
    const summary = {
      unread: 4,
      attention: 1,
      bySpace: { deals: { unread: 2, attention: 1 }, ops: { unread: 2, attention: 0 } },
    };
    const harness = makeHarness([{ body: summary }, { body: summary }, { body: summary }]);
    expect(await harness.run(["inbox", "count"])).toBe(0);
    expect(harness.stdout().trim()).toBe("4 (1 need attention)");
    expect(await harness.run(["inbox", "count", "--space", "deals"])).toBe(0);
    expect(harness.stdout().trim().split("\n").pop()).toBe("2 (1 need attention)");
    expect(await harness.run(["inbox", "count", "--space", "quiet"])).toBe(0);
    expect(harness.stdout().trim().split("\n").pop()).toBe("0");
    expect(harness.requests).toHaveLength(3);
  });

  it("marks ids read in a batch, or everything with --all, and rejects neither/both", async () => {
    const harness = makeHarness([{ body: { updated: 2 } }, { body: { updated: 9 } }]);
    expect(await harness.run(["inbox", "read", "n1", "n2"])).toBe(0);
    expect(harness.requests[0].method).toBe("POST");
    expect(harness.requests[0].url.pathname).toBe("/notifications/read");
    expect(harness.requests[0].body).toEqual({ ids: ["n1", "n2"] });

    expect(await harness.run(["inbox", "read", "--all"])).toBe(0);
    expect(harness.requests[1].url.pathname).toBe("/notifications/read-all");

    expect(await harness.run(["inbox", "read"])).toBe(2);
    expect(await harness.run(["inbox", "read", "n1", "--all"])).toBe(2);
    expect(harness.requests).toHaveLength(2);
  });

  it("scopes --all to one space and to activity, and rejects those flags without --all", async () => {
    const harness = makeHarness([{ body: { updated: 3 } }]);
    expect(
      await harness.run(["inbox", "read", "--all", "--space", "deals", "--scope", "activity"]),
    ).toBe(0);
    const request = harness.requests[0];
    expect(request.url.pathname).toBe("/notifications/read-all");
    expect(request.url.searchParams.get("space")).toBe("deals");
    expect(request.url.searchParams.get("scope")).toBe("activity");

    expect(await harness.run(["inbox", "read", "--all", "--scope", "bogus"])).toBe(2);
    expect(harness.stderr()).toMatch(/--scope must be one of/);
    expect(await harness.run(["inbox", "read", "n1", "--space", "deals"])).toBe(2);
    expect(harness.requests).toHaveLength(1);
  });

  it("maps the agent-credential refusal to the permission exit code", async () => {
    const harness = makeHarness([
      {
        status: 403,
        body: {
          error: "Notifications are delivered to people, not agent credentials.",
          reason: "human_principal_required",
        },
      },
    ]);
    expect(await harness.run(["inbox"])).toBe(7);
    expect(harness.stderr()).toMatch(/agent credentials/);
  });
});
