import { describe, expect, it } from "vitest";
import { foldLeadingFrontmatter } from "./markdown.js";

describe("foldLeadingFrontmatter", () => {
  it("folds flat key: value lines with JSON value coercion", () => {
    const folded = foldLeadingFrontmatter(
      [
        "---",
        "title: Acme Corp",
        "description: Investment memo",
        'metadataSchema: {"fields":[{"key":"stage","type":"select"}]}',
        "count: 3",
        "---",
        "",
        "# Acme",
        "",
      ].join("\n"),
    );
    expect(folded.title).toBe("Acme Corp");
    expect(folded.frontmatter).toEqual({
      description: "Investment memo",
      metadataSchema: { fields: [{ key: "stage", type: "select" }] },
      count: 3,
    });
    expect(folded.content).toBe("# Acme\n");
    expect(folded.unfoldedBlock).toBe(false);
  });

  it("round-trips the server's rendered markdown format", () => {
    // What the Coconut Context API’s renderMarkdown/serializeFrontmatter produce.
    const served = '---\nstage: diligence\nscore: 0.82\ntitle: Acme\n---\n\n# Acme body\n';
    const folded = foldLeadingFrontmatter(served);
    expect(folded.title).toBe("Acme");
    expect(folded.frontmatter).toEqual({ stage: "diligence", score: 0.82 });
    expect(folded.content).toBe("# Acme body\n");
  });

  it("leaves nested YAML blocks in the body instead of mangling them", () => {
    const doc = ["---", "metadataSchema:", "  fields:", "    - key: stage", "---", "# Body"].join("\n");
    const folded = foldLeadingFrontmatter(doc);
    expect(folded.content).toBe(doc);
    expect(folded.unfoldedBlock).toBe(true);
    expect(folded.frontmatter).toBeUndefined();
  });

  it("leaves blocks with non key:value prose alone", () => {
    const doc = ["---", "just some text", "---", "# Body"].join("\n");
    const folded = foldLeadingFrontmatter(doc);
    expect(folded.content).toBe(doc);
    expect(folded.unfoldedBlock).toBe(true);
  });

  it("passes documents without a leading block through untouched", () => {
    const folded = foldLeadingFrontmatter("# Plain\n\n--- not a block\n");
    expect(folded).toEqual({ content: "# Plain\n\n--- not a block\n", unfoldedBlock: false });
  });

  it("keeps existing frontmatter by returning undefined when only title is present", () => {
    const folded = foldLeadingFrontmatter("---\ntitle: Only\n---\nBody");
    expect(folded.title).toBe("Only");
    expect(folded.frontmatter).toBeUndefined();
  });

  it("strips paired quotes from non-JSON string values", () => {
    const folded = foldLeadingFrontmatter("---\nnote: 'hello world'\n---\nBody");
    expect(folded.frontmatter).toEqual({ note: "hello world" });
  });
});
