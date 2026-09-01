import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { parseKeyValues } from "./kv.js";

describe("parseKeyValues", () => {
  it("parses repeated pairs with JSON value coercion", () => {
    expect(
      parseKeyValues(["stage=diligence", "conviction-score=0.7", "live=true", "flags=null"], "--set"),
    ).toEqual({
      stage: "diligence",
      "conviction-score": 0.7,
      live: true,
      flags: null,
    });
  });

  it("keeps values with = signs intact after the first separator", () => {
    expect(parseKeyValues(["url=https://a.example/?q=1"], "--metadata")).toEqual({
      url: "https://a.example/?q=1",
    });
  });

  it("lets later duplicates win", () => {
    expect(parseKeyValues(["a=1", "a=2"], "--set")).toEqual({ a: 2 });
  });

  it("accepts empty string values", () => {
    expect(parseKeyValues(["note="], "--set")).toEqual({ note: "" });
  });

  it("rejects pairs without a key or separator", () => {
    expect(() => parseKeyValues(["=x"], "--set")).toThrowError(CliError);
    expect(() => parseKeyValues(["plain"], "--set")).toThrowError(CliError);
  });
});
