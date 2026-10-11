import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Regression guard: the Abandon and Forfeit buttons used to call
// window.prompt() directly for the reason text — a native, unstylable,
// unlocalizable browser dialog inconsistent with the rest of the app's
// confirm-provider-based modals. They now open an in-app TextPromptDialog
// instead (same pattern as prose-editor.tsx's EditorDialog). No jsdom/
// testing-library setup exists in this codebase to drive the actual
// click-through flow (the scoring UI needs a real browser), so a
// source-level guard is the honest regression test available here.
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixture-console.tsx"),
  "utf8",
);

describe("fixture-console: no native browser dialogs", () => {
  it("never calls window.prompt", () => {
    expect(source).not.toMatch(/window\.prompt\(/);
  });

  it("never calls window.confirm or bare alert", () => {
    expect(source).not.toMatch(/window\.confirm\(/);
    expect(source).not.toMatch(/(?<!\.)\balert\(/);
  });

  it("routes the abandon reason through the in-app TextPromptDialog instead", () => {
    expect(source).toContain("function TextPromptDialog(");
    expect(source).toContain("setAbandonPrompt");
  });

  // W2b Task 11: the forfeit no longer TYPES a reason at all — the in-app ForfeitDialog offers the closed vocabulary as
  // choices (forfeit-dialog.tsx; driven click by click in fixture-console-forfeit-hooks.test.tsx).
  it("routes the forfeit through the in-app ForfeitDialog, never a typed reason", () => {
    expect(source).toContain("<ForfeitDialog");
    expect(source).toContain("setForfeitOpen");
    expect(source, "the old free-text forfeit prompt is gone").not.toContain("setForfeitPrompt");
    const dialog = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../forfeit-dialog.tsx"), "utf8");
    expect(dialog).not.toMatch(/window\.(prompt|confirm)\(/);
    expect(dialog).not.toMatch(/(?<!\.)\balert\(/);
  });
});
