// The --filter comparison syntax → API metadata filter ops. One expression
// per flag, AND-ed together by the API:
//
//   stage=diligence          eq        stage!=closed          neq
//   conviction-score>=0.7    gte       conviction-score>0.5   gt
//   ebitda-multiple<=8       lte       ebitda-multiple<10     lt
//   sources~news.example     contains  flags:exists           exists
//   flags:missing            missing
//
// Values are JSON-parsed when they look like JSON (numbers, booleans, null,
// arrays, quoted strings), so `score>=0.7` compares numerically while
// `stage=diligence` stays a string. Quote to force a string: `x="0.7"`.

import type { MetadataFilter, MetadataFilterOp } from "coconut-sdk";
import { CliError, EXIT } from "./errors.js";

// Longer tokens first so `>=` beats `>` (and `!=` beats `=`) when both
// match at the same position; between positions, the earliest operator in
// the expression wins, so the key can never swallow an operator.
const COMPARISON_OPS: Array<{ token: string; op: MetadataFilterOp }> = [
  { token: ">=", op: "gte" },
  { token: "<=", op: "lte" },
  { token: "!=", op: "neq" },
  { token: ">", op: "gt" },
  { token: "<", op: "lt" },
  { token: "=", op: "eq" },
  { token: "~", op: "contains" },
];

// Mirrors the API's metadata key rule (letters, digits, "_", ".", "-").
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function checkKey(key: string, expression: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new CliError(
      `Invalid metadata key "${key}" in filter "${expression}" (letters, digits, "_", ".", "-").`,
      EXIT.usage,
    );
  }
  return key;
}

/** Parses one --filter expression into an API metadata filter. */
export function parseFilter(expression: string): MetadataFilter {
  const trimmed = expression.trim();
  if (trimmed === "") {
    throw new CliError("Empty --filter expression.", EXIT.usage);
  }

  let match: { index: number; token: string; op: MetadataFilterOp } | undefined;
  for (const { token, op } of COMPARISON_OPS) {
    const index = trimmed.indexOf(token);
    if (index <= 0) continue;
    if (!match || index < match.index) match = { index, token, op };
  }

  // `key:exists` / `key:missing` — but only when no comparison operator
  // precedes the suffix, so `note=see:exists` stays an eq on a string value.
  const existence = /^(.+):(exists|missing)$/.exec(trimmed);
  if (existence && (!match || match.index > existence[1].length)) {
    return {
      key: checkKey(existence[1].trim(), expression),
      op: existence[2] as MetadataFilterOp,
    };
  }

  if (match) {
    const key = checkKey(trimmed.slice(0, match.index).trim(), expression);
    const rawValue = trimmed.slice(match.index + match.token.length).trim();
    if (rawValue === "") {
      throw new CliError(
        `Missing value in filter "${expression}" (use "${key}:exists" / "${key}:missing" to test presence).`,
        EXIT.usage,
      );
    }
    return { key, op: match.op, value: parseScalar(rawValue) };
  }

  throw new CliError(
    `Cannot parse filter "${expression}". Expected key=value, key!=value, key>value, key>=value, key<value, key<=value, key~value, key:exists, or key:missing.`,
    EXIT.usage,
  );
}

export function parseFilters(expressions: string[]): MetadataFilter[] {
  return expressions.map(parseFilter);
}

/** JSON when it parses as JSON, string otherwise. */
export function parseScalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
