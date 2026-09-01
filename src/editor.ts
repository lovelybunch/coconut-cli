// $EDITOR round-trip for `coco page edit`: write markdown to a temp file,
// hand it to the user's editor (VISUAL, then EDITOR — both may carry
// arguments, e.g. "code --wait"), and read the result back.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";

export interface EditResult {
  content: string;
  changed: boolean;
}

export function editInEditor(
  env: Record<string, string | undefined>,
  initialContent: string,
  filenameHint: string,
): EditResult {
  const editor = env.VISUAL ?? env.EDITOR;
  if (!editor || editor.trim() === "") {
    throw new CliError(
      "No editor configured. Set $EDITOR (or $VISUAL), e.g. `export EDITOR=vim`.",
      EXIT.usage,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "coco-edit-"));
  const file = join(dir, `${filenameHint.replace(/[^a-zA-Z0-9._-]+/g, "-")}.md`);
  try {
    writeFileSync(file, initialContent, { mode: 0o600 });
    // Through the shell so EDITOR values with arguments work.
    const result = spawnSync(`${editor} ${JSON.stringify(file)}`, {
      stdio: "inherit",
      shell: true,
    });
    if (result.error) {
      throw new CliError(`Could not launch editor "${editor}": ${result.error.message}`, EXIT.usage);
    }
    if (result.status !== 0) {
      throw new CliError(`Editor exited with status ${result.status}; aborting the edit.`, EXIT.unexpected);
    }
    const content = readFileSync(file, "utf8");
    return { content, changed: content !== initialContent };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
