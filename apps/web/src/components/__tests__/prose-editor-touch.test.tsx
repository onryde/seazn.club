// Match Day C8 — the editor's opt-in phone tap floor. The New competition form
// asks for `touch`; the four other editors (org about, payment instructions,
// news, competition settings) do not, and must keep the compact toolbar.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ProseEditor, ToolbarButton } from "@/components/prose-editor";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const dict = uiEn as unknown as Dict;

function editorHtml(touch?: boolean): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <ProseEditor value="" onChange={() => {}} orgId="org-1" {...(touch === undefined ? {} : { touch })} />
    </DictProvider>,
  );
}

function buttonHtml(touch?: boolean): string {
  return renderToStaticMarkup(
    <ToolbarButton label="Bold" onClick={() => {}} {...(touch === undefined ? {} : { touch })}>
      B
    </ToolbarButton>,
  );
}

describe("ProseEditor touch mode", () => {
  it("a toolbar button is 44px below lg and the compact 32px at lg when touch is on", () => {
    expect(buttonHtml(true)).toContain("h-11 w-11 lg:h-8 lg:w-8");
  });

  it("a toolbar button stays 32px, with no 44px class at all, by default and when touch is false", () => {
    for (const html of [buttonHtml(), buttonHtml(false)]) {
      expect(html).toContain("h-8 w-8");
      expect(html).not.toContain("h-11");
      expect(html).not.toContain("w-11");
    }
  });

  it("the Write and Preview tabs are 44px below lg only when touch is on", () => {
    const on = editorHtml(true);
    // Two tabs, both carrying the floor — a count, so one tab missing it is seen.
    expect(on.match(/min-h-11 lg:min-h-0/g)?.length).toBe(2);
    for (const html of [editorHtml(), editorHtml(false)]) {
      expect(html).not.toContain("min-h-11");
      expect(html.match(/role="tab"/g)?.length).toBe(2);
    }
  });

  it("every toolbar button inside the editor is handed `touch` (the toolbar mounts client-side, so read the source)", () => {
    const src = readFileSync(new URL("../prose-editor.tsx", import.meta.url), "utf8");
    const all = src.match(/<ToolbarButton\b/g)?.length ?? 0;
    const touched = src.match(/<ToolbarButton touch=\{touch\}/g)?.length ?? 0;
    // Anti-vacuity: the toolbar has eleven buttons; zero would pass 0 === 0.
    expect(all).toBe(11);
    expect(touched).toBe(all);
  });
});
