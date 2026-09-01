import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { parseFilter, parseFilters, parseScalar } from "./filters.js";

describe("parseFilter", () => {
  it("maps every comparison operator to its API op", () => {
    expect(parseFilter("stage=diligence")).toEqual({ key: "stage", op: "eq", value: "diligence" });
    expect(parseFilter("stage!=closed")).toEqual({ key: "stage", op: "neq", value: "closed" });
    expect(parseFilter("conviction-score>=0.7")).toEqual({
      key: "conviction-score",
      op: "gte",
      value: 0.7,
    });
    expect(parseFilter("conviction-score>0.5")).toEqual({
      key: "conviction-score",
      op: "gt",
      value: 0.5,
    });
    expect(parseFilter("ebitda-multiple<=8")).toEqual({ key: "ebitda-multiple", op: "lte", value: 8 });
    expect(parseFilter("ebitda-multiple<10")).toEqual({ key: "ebitda-multiple", op: "lt", value: 10 });
    expect(parseFilter("sources~news.example")).toEqual({
      key: "sources",
      op: "contains",
      value: "news.example",
    });
  });

  it("parses existence tests", () => {
    expect(parseFilter("flags:exists")).toEqual({ key: "flags", op: "exists" });
    expect(parseFilter("flags:missing")).toEqual({ key: "flags", op: "missing" });
  });

  it("JSON-parses values that look like JSON and keeps the rest as strings", () => {
    expect(parseFilter("n=42")).toEqual({ key: "n", op: "eq", value: 42 });
    expect(parseFilter("live=true")).toEqual({ key: "live", op: "eq", value: true });
    expect(parseFilter("x=null")).toEqual({ key: "x", op: "eq", value: null });
    expect(parseFilter('v="0.7"')).toEqual({ key: "v", op: "eq", value: "0.7" });
    expect(parseFilter("stage=diligence")).toEqual({ key: "stage", op: "eq", value: "diligence" });
  });

  it("picks the earliest operator, so values may contain operator characters", () => {
    expect(parseFilter("url~https://a.example/x=1")).toEqual({
      key: "url",
      op: "contains",
      value: "https://a.example/x=1",
    });
    expect(parseFilter("note=see:exists")).toEqual({ key: "note", op: "eq", value: "see:exists" });
  });

  it("prefers two-character operators at the same position", () => {
    expect(parseFilter("a>=1").op).toBe("gte");
    expect(parseFilter("a!=1").op).toBe("neq");
  });

  it("rejects unparseable expressions with a usage error", () => {
    for (const bad of ["", "stage", "=x", ">=3", "stage="]) {
      expect(() => parseFilter(bad)).toThrowError(CliError);
    }
  });

  it("parses lists of expressions", () => {
    expect(parseFilters(["a=1", "b:missing"])).toEqual([
      { key: "a", op: "eq", value: 1 },
      { key: "b", op: "missing" },
    ]);
  });
});

describe("parseScalar", () => {
  it("falls back to the raw string for non-JSON", () => {
    expect(parseScalar("hello world")).toBe("hello world");
    expect(parseScalar("[1,2]")).toEqual([1, 2]);
  });
});
