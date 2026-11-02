// Match Day C8 — the grey hint in an empty description editor. `placeholder` was
// only ever the textbox's accessible name (nothing drew it); the New competition
// form now asks for it to be drawn. The decoration rule is a pure function of the
// document, so it is tested on real ProseMirror documents — no DOM needed. That
// the hint is actually PAINTED, grey, and gone after a keystroke is proven in a
// browser by the new-competition-form walkthrough.
import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { placeholderDecorations } from "@/components/prose-editor";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "inline*", toDOM: () => ["h2", 0] },
    text: { group: "inline" },
  },
});
const p = (text?: string) => schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined);
const doc = (...kids: ReturnType<typeof p>[]) => schema.nodes.doc!.create(null, kids);

const HINT = "Tell people about this competition and its divisions";

describe("placeholderDecorations", () => {
  it("decorates the one empty paragraph with the hint text and the marker class", () => {
    const d = doc(p());
    const set = placeholderDecorations(d, HINT);
    expect(set).not.toBeNull();
    const found = set!.find();
    expect(found).toHaveLength(1);
    // A node decoration over the whole paragraph: from 0 to its size.
    expect(found[0]!.from).toBe(0);
    expect(found[0]!.to).toBe(d.firstChild!.nodeSize);
    const attrs = (found[0] as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    expect(attrs.class).toBe("is-editor-empty");
    expect(attrs["data-placeholder"]).toBe(HINT);
  });

  it("shows nothing once there is text, more than one block, or a first block that is not a paragraph", () => {
    const cases: [string, ReturnType<typeof doc>][] = [
      ["a typed character", doc(p("x"))],
      ["two empty paragraphs", doc(p(), p())],
      ["an empty paragraph then text", doc(p(), p("x"))],
      ["an empty heading", doc(schema.nodes.heading!.create())],
    ];
    for (const [label, d] of cases) expect(placeholderDecorations(d, HINT), label).toBeNull();
    expect(cases).toHaveLength(4);
  });

  it("is the empty case's inverse: typing into the empty document turns the hint off", () => {
    expect(placeholderDecorations(doc(p()), HINT)).not.toBeNull();
    expect(placeholderDecorations(doc(p("a")), HINT)).toBeNull();
  });
});
