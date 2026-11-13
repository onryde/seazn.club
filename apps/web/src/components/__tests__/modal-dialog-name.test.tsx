// B6 T21 review (I-2, m-1): the house Modal is the dialog for ~19 surfaces, and a dialog with no
// accessible name is an axe `aria-dialog-name` failure (serious) on every one of them. The name is the
// visible title, wired the standard way (`aria-labelledby` -> the title's id), and the close button's
// label is the caller's to localise — it was a hardcoded English "Close" on a button read aloud in four
// locales. Both changes are ADDITIVE: a caller that passes nothing new gets a named dialog and the same
// "Close" it always had.
//
// `renderToStaticMarkup`, not the hook harness: `useId` must produce DISTINCT ids for two dialogs open at
// once (a stacked confirm over a sheet), and only a real React render can say so. Effects never run in it,
// which is fine — nothing here is about focus.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import { Modal } from "@/components/modal";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";

const noop = () => {};

/** A Modal element; children go as createElement's own trailing argument (react/no-children-prop). */
const modal = (props: Record<string, unknown> = {}, children: string | null = "x") =>
  createElement(Modal, { title: "T", onClose: noop, ...props }, children);

/** One tag's attributes, read off the markup a real render produced. */
function tagsOf(html: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
    out.push(attrs);
  }
  return out;
}

function dialogs(html: string) {
  return tagsOf(html, "div").filter((a) => a.role === "dialog");
}

describe("Modal names its dialog (aria-labelledby -> the visible title)", () => {
  it("the dialog's aria-labelledby is the id of the h3 that carries the title text", () => {
    const html = renderToStaticMarkup(modal({ title: "Filters" }));
    const [dialog] = dialogs(html);
    expect(dialog, "a role=dialog element").toBeTruthy();
    const labelledby = dialog!["aria-labelledby"];
    expect(labelledby, "aria-labelledby is present and non-empty").toBeTruthy();
    const headings = tagsOf(html, "h3");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.id).toBe(labelledby);
    // ...and that heading's text is the title: the name a screen reader announces is what is drawn.
    expect(html).toMatch(new RegExp(`<h3[^>]*id="${labelledby}"[^>]*>Filters</h3>`));
  });

  it("two dialogs open at once get two different ids — a shared id would name both after the first", () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        modal({ title: "First" }, "x"),
        modal({ title: "Second" }, "y"),
      ),
    );
    const found = dialogs(html);
    expect(found).toHaveLength(2);
    const ids = found.map((d) => d["aria-labelledby"]);
    expect(new Set(ids).size, "distinct ids").toBe(2);
    const headingIds = tagsOf(html, "h3").map((h) => h.id);
    expect(headingIds).toEqual(ids);
  });

  it("every Modal call shape is named: a footer, a side placement, bleed, the lg close", () => {
    let checked = 0;
    for (const props of [
      { footer: createElement("button", null, "ok") },
      { placement: "side" as const },
      { bleed: true },
      { closeSize: "lg" as const },
      { size: "lg" as const },
    ]) {
      const html = renderToStaticMarkup(modal(props));
      const [dialog] = dialogs(html);
      expect(dialog?.["aria-labelledby"], JSON.stringify(Object.keys(props))).toBeTruthy();
      expect(tagsOf(html, "h3")[0]!.id).toBe(dialog!["aria-labelledby"]);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

describe("Modal's close label is the caller's", () => {
  const closeLabelOf = (props: Record<string, unknown>) => {
    const html = renderToStaticMarkup(modal(props));
    const buttons = tagsOf(html, "button").filter((b) => b["aria-label"] !== undefined);
    expect(buttons, "exactly one labelled close button").toHaveLength(1);
    return buttons[0]!["aria-label"];
  };

  it("a caller that passes nothing keeps the label it always had", () => {
    expect(closeLabelOf({})).toBe("Close");
    expect(closeLabelOf({ closeSize: "lg" })).toBe("Close");
  });

  it("a caller's closeLabel becomes the button's accessible name, at both close sizes", () => {
    expect(closeLabelOf({ closeLabel: "Fermer" })).toBe("Fermer");
    expect(closeLabelOf({ closeLabel: "Sluiten", closeSize: "lg" })).toBe("Sluiten");
  });
});

// m-1: the sheet's body is the thing that scrolls; without `overscroll-contain` a swipe past its end
// chains to the PAGE behind the overlay. (Locking the page outright is a Modal-wide behaviour change
// owed its own ruling; containing the chain is not.)
describe("Modal's body scroller does not chain to the page behind it", () => {
  it("the scrolling body carries overscroll-contain, and the class is real Tailwind", async () => {
    const html = renderToStaticMarkup(modal());
    const scrollers = tagsOf(html, "div").filter((a) => (a.class ?? "").split(/\s+/).includes("overflow-y-auto"));
    expect(scrollers, "the one scrolling body").toHaveLength(1);
    const tokens = scrollers[0]!.class!.split(/\s+/);
    expect(tokens).toContain("overscroll-contain");
    const compiled = await compileClasses(["overscroll-contain"]);
    expect(compiled.get("overscroll-contain")).toMatchObject({ "overscroll-behavior": "contain" });
  });
});
