// A post's own Markdown table, marked up so globals.css `.blog-stack` can draw it as one card per row on a narrow phone
// (a three-column checklist is cramped at 320px). Help keeps its scrolling table: only the blog asks for this step
// (help-content.ts `stackTables`). The generated example tables are components, not Markdown, and are not touched.
//
// Two things the card needs:
//  - explicit table roles. A CSS `display` other than a table one drops the implied roles in some browsers (Safari), so
//    each part is named; the first cell of a body row is its row header;
//  - each other cell's column name, as real text the stylesheet shows only in the card. It is `aria-hidden`: a screen
//    reader already reads the column header, which the card hides from sight only.
//
// A rehype step after the sanitiser, like the scroll boxes (help-scroll-boxes.ts), whose wrapper it sits inside. The
// sanitiser allows no role, class or span, so nothing an author types can produce them.
import type { Element, ElementContent, Root, RootContent } from "hast";

export const BLOG_STACK_CLASS = "blog-stack";
export const BLOG_CELL_LABEL_CLASS = "blog-cell-label";

const elements = (n: Root | Element, tag?: string): Element[] =>
  (n.children as (RootContent | ElementContent)[]).filter((c): c is Element => c.type === "element" && (tag === undefined || c.tagName === tag));

const textOf = (n: ElementContent): string => (n.type === "text" ? n.value : n.type === "element" ? n.children.map(textOf).join("") : "");

const role = (el: Element, value: string) => {
  el.properties = { ...el.properties, role: value };
};

function stack(table: Element): void {
  table.properties = { ...table.properties, className: [BLOG_STACK_CLASS], role: "table" };
  const labels: string[] = [];
  for (const group of elements(table)) {
    if (group.tagName !== "thead" && group.tagName !== "tbody") continue;
    role(group, "rowgroup");
    for (const row of elements(group, "tr")) {
      role(row, "row");
      if (group.tagName === "thead") {
        for (const th of elements(row, "th")) {
          role(th, "columnheader");
          labels.push(textOf(th).trim());
        }
        continue;
      }
      elements(row, "td").forEach((td, column) => {
        if (column === 0) return role(td, "rowheader");
        role(td, "cell");
        const label = labels[column];
        if (!label) return;
        td.children = [
          { type: "element", tagName: "span", properties: { className: [BLOG_CELL_LABEL_CLASS], ariaHidden: "true" }, children: [{ type: "text", value: label }] },
          ...td.children,
        ];
      });
    }
  }
}

function walk(node: Root | Element): void {
  for (const child of elements(node)) {
    if (child.tagName === "table") stack(child);
    else walk(child);
  }
}

/** rehype plugin: every `<table>` can stack into cards. */
export function rehypeBlogStackedTables() {
  return (tree: Root): void => walk(tree);
}
