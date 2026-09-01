import { describe, expect, it } from "vitest";
import { isOpenableUrl, openSystemBrowser } from "./runtime.js";

describe("isOpenableUrl", () => {
  it("accepts only http(s) URLs", () => {
    expect(isOpenableUrl("https://coco.test/oauth/authorize?x=1")).toBe(true);
    expect(isOpenableUrl("http://127.0.0.1:8787/oauth/authorize")).toBe(true);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableUrl("not a url")).toBe(false);
    // cmd.exe metacharacters in a fragment must never reach a shell; the
    // opener itself is shell-free, and non-web schemes are refused outright.
    expect(isOpenableUrl("ms-settings:network")).toBe(false);
  });
});

describe("openSystemBrowser", () => {
  it("refuses non-http(s) URLs without spawning anything", async () => {
    expect(await openSystemBrowser("javascript:alert(1)")).toBe(false);
    expect(await openSystemBrowser("file:///etc/passwd")).toBe(false);
  });
});
