// Client-side fold of a leading `---` frontmatter block into
// title/frontmatter/content. The REST surface stores `content` verbatim
// (only the product’s MCP door folds), so the CLI
// folds before writing — the same flat rules as the MCP door: `key: value`
// lines, values as one-line JSON when they parse as JSON. One deliberate
// difference: a block that is NOT strictly flat (nested YAML, list items) is
// left in the body untouched instead of being mangled into flat keys, and
// the caller can warn. Use `--frontmatter` with one-line JSON for nested
// structures like metadataSchema.

const LEADING_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface FoldedMarkdown {
  title?: string;
  frontmatter?: Record<string, unknown>;
  content: string;
  /** A leading `---` block existed but wasn't flat `key: value` lines. */
  unfoldedBlock: boolean;
}

export function foldLeadingFrontmatter(markdown: string): FoldedMarkdown {
  const match = LEADING_BLOCK_RE.exec(markdown);
  if (!match) return { content: markdown, unfoldedBlock: false };

  const data: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return { content: markdown, unfoldedBlock: true };
    const key = line.slice(0, separator).trim();
    // Indented/nested keys and list markers fail this and abort the fold.
    if (!KEY_RE.test(key) || /^\s/.test(line)) return { content: markdown, unfoldedBlock: true };
    data[key] = parseFrontmatterValue(line.slice(separator + 1).trim());
  }

  const { title, ...frontmatter } = data;
  return {
    title: typeof title === "string" ? title : undefined,
    frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
    content: markdown.slice(match[0].length).replace(/^(?:\r?\n)+/, ""),
    unfoldedBlock: false,
  };
}

/** Inverse of the server's serializer: JSON when it parses, string otherwise. */
function parseFrontmatterValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
}
