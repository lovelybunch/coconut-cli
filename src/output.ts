// Output conventions: human-readable tables by default; --json emits the raw
// API JSON alone on stdout (pipeable, nothing else mixed in); informational
// chatter goes to stderr and is silenced by --quiet. Color only on a TTY,
// and never when NO_COLOR is set (https://no-color.org/).

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly color: boolean;

  constructor(options: OutputOptions) {
    this.json = options.json;
    this.quiet = options.quiet;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.color =
      options.stdout.isTTY === true &&
      options.env.NO_COLOR === undefined &&
      options.env.TERM !== "dumb";
  }

  private bold(text: string): string {
    return this.color ? `\u001b[1m${text}\u001b[22m` : text;
  }

  private dim(text: string): string {
    return this.color ? `\u001b[2m${text}\u001b[22m` : text;
  }

  /** The raw API payload, alone on stdout — the --json contract. */
  emitJson(data: unknown): void {
    this.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }

  /** Primary human-readable result (still printed with --quiet). */
  result(text: string): void {
    this.stdout.write(`${text}\n`);
  }

  /** Informational chatter → stderr; silenced by --quiet. */
  info(text: string): void {
    if (!this.quiet) this.stderr.write(`${text}\n`);
  }

  /** Warnings → stderr; not silenced (they signal something off). */
  warn(text: string): void {
    this.stderr.write(`${text}\n`);
  }

  /** Fixed-width table on stdout. Columns default to the union of row keys. */
  table(rows: Array<Record<string, unknown>>, columns?: string[]): void {
    if (rows.length === 0) {
      this.info("(no rows)");
      return;
    }
    const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const cells = rows.map((row) => keys.map((key) => formatCell(row[key])));
    const widths = keys.map((key, index) =>
      Math.max(key.length, ...cells.map((row) => row[index].length)),
    );
    const line = (values: string[]) =>
      values
        .map((value, index) => (index === values.length - 1 ? value : value.padEnd(widths[index])))
        .join("  ");
    this.stdout.write(`${this.bold(line(keys))}\n`);
    this.stdout.write(`${this.dim(line(widths.map((width) => "-".repeat(width))))}\n`);
    for (const row of cells) this.stdout.write(`${line(row)}\n`);
  }

  /** Aligned label/value pairs for detail views. */
  details(pairs: Array<[string, unknown]>): void {
    const width = Math.max(...pairs.map(([label]) => label.length));
    for (const [label, value] of pairs) {
      this.stdout.write(`${this.bold(`${label}:`.padEnd(width + 1))} ${formatCell(value)}\n`);
    }
  }
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** ISO timestamp → compact local-agnostic display (`2026-08-23 14:05`). */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]}` : iso;
}
