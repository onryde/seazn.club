// Prose scrollers in help articles. A code block and a table that does not fit both scroll sideways inside their
// own box, and a scrolling region owes a tab stop, a role and a name (AGENTS.md class 23): without them a keyboard
// user cannot scroll it and axe reds `scrollable-region-focusable` at serious impact.
//
//     <pre>               ->  <pre tabindex="0" role="region" aria-label="Code example">
//     <table>             ->  <div class="help-scroll" tabindex="0" role="region" aria-label="Table"><table>
//
// The table gets a WRAPPER, never the attributes themselves: a `role="region"` on the `<table>` would replace its
// table role, and its rows and cells would then be orphans (axe `aria-required-parent`). The wrapper is the scroll
// box (globals.css `.help-scroll`), and the table inside it is a real table again.
//
// A rehype step that runs AFTER the sanitiser, like the callouts, the figures and the heading ids: the sanitiser
// allows no tabindex, role, aria-label or div, so nothing an author types can produce them, and the step SETS the
// three rather than merging, so a value that did reach the tree is overwritten. Every table is wrapped, whether or
// not it overflows at the reader's width: the renderer cannot know that, and a wrapper that never scrolls is one
// extra tab stop, not a defect.
//
// The blog renders its bodies through this same pipeline (server/blog-render.ts), so a post is covered by it.
// English only, like all help copy.
import type { Element, ElementContent, Root } from "hast";

export const HELP_SCROLL_LABELS = { pre: "Code example", table: "Table" } as const;

/** The wrapper's class: globals.css `.help-scroll` is its scroll box and its focus ring. */
export const HELP_SCROLL_CLASS = "help-scroll";

const isElement = (n: ElementContent): n is Element => n.type === "element";

function walk(node: Root | Element): void {
  // A Root's children are RootContent and an Element's ElementContent; both hold the elements this walk reads.
  const children = node.children as ElementContent[];
  children.forEach((child, i) => {
    if (!isElement(child)) return;
    if (child.tagName === "pre") {
      child.properties = { ...child.properties, tabIndex: 0, role: "region", ariaLabel: HELP_SCROLL_LABELS.pre };
      return;
    }
    if (child.tagName === "table") {
      children[i] = {
        type: "element",
        tagName: "div",
        properties: { className: [HELP_SCROLL_CLASS], tabIndex: 0, role: "region", ariaLabel: HELP_SCROLL_LABELS.table },
        children: [child],
      };
      return;
    }
    walk(child);
  });
}

/** rehype plugin: every `<pre>` is a labelled tab stop, and every `<table>` sits in one. */
export function rehypeHelpScrollBoxes() {
  return (tree: Root): void => walk(tree);
}
