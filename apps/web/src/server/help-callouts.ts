// Callouts in help articles. An author writes a blockquote whose FIRST LINE is exactly
// **Note**, **Warning** or **Example**:
//
//     > **Warning**
//     > Withdrawing an entrant after the draw voids their fixtures.
//
// and the page gets <div role="note" class="help-callout" data-kind="warning"> with the label
// kept as visible text. Anything else stays a plain blockquote: another label, other casing, text
// after the label on the same line, emphasis instead of strong. The label line ends at a soft
// line break (a plain newline) or a hard one (two trailing spaces, or a backslash, then newline).
//
// A `div role="note"`, not an `aside`: an aside is a complementary LANDMARK, and one inside the
// page's main region, beside the help layout's own navigation, breaks axe's landmark rules. A
// note is what a callout is (ARIA: "a section whose content is parenthetic or ancillary").
//
// A rehype step that runs AFTER the sanitiser, like the heading ids and the figures: the
// sanitiser allows no div, no role, no class and no data attribute, so nothing an author types
// (raw HTML is dropped anyway) can produce one. The kind is ours, from a closed list.
import type { Element, ElementContent, Root } from "hast";

export const HELP_CALLOUT_LABELS = { Note: "note", Warning: "warning", Example: "example" } as const;
type Label = keyof typeof HELP_CALLOUT_LABELS;

const isElement = (n: ElementContent): n is Element => n.type === "element";

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(textOf).join("") : "";
}

/** The kind a blockquote declares on its first line, or null if it is an ordinary quote. */
function calloutKind(quote: Element): (typeof HELP_CALLOUT_LABELS)[Label] | null {
  const first = quote.children.find((c) => isElement(c));
  if (!first || !isElement(first) || first.tagName !== "p") return null;
  const [label, next] = first.children;
  if (!label || !isElement(label) || label.tagName !== "strong") return null;
  const name = textOf(label);
  if (!Object.hasOwn(HELP_CALLOUT_LABELS, name)) return null;
  // "First line is exactly the label": nothing after it on that line. A following soft line
  // break (a text node that opens with a newline) or hard one (a <br>) is the end of the line;
  // any other text is not.
  const endsLine =
    next === undefined ||
    (next.type === "text" && next.value.startsWith("\n")) ||
    (isElement(next) && next.tagName === "br");
  if (!endsLine) return null;
  return HELP_CALLOUT_LABELS[name as Label];
}

function walk(node: Root | Element): void {
  for (const child of node.children as ElementContent[]) {
    if (!isElement(child)) continue;
    if (child.tagName === "blockquote") {
      const kind = calloutKind(child);
      if (kind) {
        child.tagName = "div";
        child.properties = { role: "note", className: ["help-callout"], dataKind: kind };
      }
    }
    walk(child);
  }
}

/** rehype plugin: a labelled blockquote becomes a callout note. */
export function rehypeHelpCallouts() {
  return (tree: Root): void => walk(tree);
}
