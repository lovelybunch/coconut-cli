import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { parseFilter, parseFilters, parseList, parseScalar } from "./filters.js";

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

  it("parses `in` / `not-in` list operators from comma lists or JSON arrays", () => {
    expect(parseFilter("stage in sourcing,diligence")).toEqual({
      key: "stage",
      op: "in",
      value: ["sourcing", "diligence"],
    });
    expect(parseFilter("stage not-in closed, lost")).toEqual({
      key: "stage",
      op: "not-in",
      value: ["closed", "lost"],
    });
    // items follow the JSON-when-it-parses rule
    expect(parseFilter("score in 1,2.5,true")).toEqual({
      key: "score",
      op: "in",
      value: [1, 2.5, true],
    });
    expect(parseFilter('stage in ["a,b","c"]')).toEqual({
      key: "stage",
      op: "in",
      value: ["a,b", "c"],
    });
    // one JSON scalar is a single candidate, so a quoted comma survives
    expect(parseFilter('note in "a,b"')).toEqual({ key: "note", op: "in", value: ["a,b"] });
    expect(parseFilter("stage in diligence")).toEqual({
      key: "stage",
      op: "in",
      value: ["diligence"],
    });
    expect(parseFilter("stage  not-in   closed")).toEqual({
      key: "stage",
      op: "not-in",
      value: ["closed"],
    });
  });

  it("keeps the earliest-operator rule for list operators", () => {
    expect(parseFilter("note=check in later")).toEqual({
      key: "note",
      op: "eq",
      value: "check in later",
    });
    expect(parseFilter("k in a=b")).toEqual({ key: "k", op: "in", value: ["a=b"] });
    expect(parseFilter("k in a:exists")).toEqual({ key: "k", op: "in", value: ["a:exists"] });
    // a key named `in` is still just a key
    expect(parseFilter("in=1")).toEqual({ key: "in", op: "eq", value: 1 });
  });

  it("rejects unparseable expressions with a usage error", () => {
    for (const bad of ["", "stage", "=x", ">=3", "stage=", "stage in", "stage in []"]) {
      expect(() => parseFilter(bad)).toThrowError(CliError);
    }
    for (const bad of ["stage in a,,b", "stage in a,", "stage not-in ,a"]) {
      expect(() => parseFilter(bad)).toThrowError(/empty list item/i);
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

describe("parseList", () => {
  it("prefers a JSON reading and otherwise splits on commas", () => {
    expect(parseList("[1,2]", "k in [1,2]")).toEqual([1, 2]);
    expect(parseList("1,2", "k in 1,2")).toEqual([1, 2]);
    expect(parseList("null", "k in null")).toEqual([null]);
    expect(parseList("a, b ,c", "k in a, b ,c")).toEqual(["a", "b", "c"]);
    expect(() => parseList("[]", "k in []")).toThrowError(/empty list/i);
  });
});
