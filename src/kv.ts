// key=value pairs for --metadata / --set / --append flags. Values are
// JSON-parsed when they look like JSON (`0.7`, `true`, `null`, `["a"]`),
// strings otherwise — the same rule as the --filter syntax. For --set,
// a JSON `null` value deletes the key (API merge-patch semantics).

import { CliError, EXIT } from "./errors.js";
import { parseScalar } from "./filters.js";

/** Parses repeated `k=v` flags into one object; later duplicates win. */
export function parseKeyValues(pairs: string[], flag: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      throw new CliError(
        `Cannot parse ${flag} "${pair}": expected key=value (e.g. ${flag} stage=diligence).`,
        EXIT.usage,
      );
    }
    const key = pair.slice(0, index).trim();
    const rawValue = pair.slice(index + 1);
    if (key === "") {
      throw new CliError(`Cannot parse ${flag} "${pair}": missing key.`, EXIT.usage);
    }
    result[key] = parseScalar(rawValue);
  }
  return result;
}
