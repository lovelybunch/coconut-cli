import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configPath,
  loadConfig,
  redactSecret,
  resolveProfileName,
  saveConfig,
  type CliConfig,
} from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coco-cli-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: dir };
}

describe("configPath", () => {
  it("respects XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/coco/config.json");
  });

  it("falls back to ~/.config", () => {
    expect(configPath({ HOME: "/home/kevin" })).toBe("/home/kevin/.config/coco/config.json");
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "", HOME: "/home/kevin" })).toBe(
      "/home/kevin/.config/coco/config.json",
    );
  });
});

describe("load/save round-trip", () => {
  it("returns an empty config when the file doesn't exist", () => {
    expect(loadConfig(env())).toEqual({ profiles: {} });
  });

  it("persists profiles and the active profile with mode 0600", () => {
    const config: CliConfig = {
      profiles: {
        dev: { baseUrl: "http://localhost:8787", auth: { type: "key", apiKey: "coco_secret" } },
      },
      activeProfile: "dev",
    };
    saveConfig(env(), config);

    const path = configPath(env());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(env())).toEqual(config);
    // The stored file is plain readable JSON (documented shape).
    expect(JSON.parse(readFileSync(path, "utf8")).profiles.dev.baseUrl).toBe("http://localhost:8787");
  });

  it("re-pins mode 0600 when overwriting", () => {
    saveConfig(env(), { profiles: {} });
    saveConfig(env(), { profiles: { a: { baseUrl: "http://x" } } });
    expect(statSync(configPath(env())).mode & 0o777).toBe(0o600);
  });

  it("rejects corrupt JSON with a pointer at the file", () => {
    saveConfig(env(), { profiles: {} });
    writeFileSync(configPath(env()), "{not json");
    expect(() => loadConfig(env())).toThrowError(/not valid JSON/);
  });
});

describe("resolveProfileName", () => {
  it("prefers the explicit flag, then activeProfile, then default", () => {
    expect(resolveProfileName({ profiles: {}, activeProfile: "b" }, "a")).toBe("a");
    expect(resolveProfileName({ profiles: {}, activeProfile: "b" }, undefined)).toBe("b");
    expect(resolveProfileName({ profiles: {} }, undefined)).toBe("default");
  });
});

describe("redactSecret", () => {
  it("keeps only a recognizable head and tail", () => {
    expect(redactSecret("coco_1234567890abcdef")).toBe("coco…cdef");
    expect(redactSecret("short")).toBe("****");
  });
});
