// The entrant's Name field (2026-09-22): an expanded entrant card lets an
// editor rename the entrant in place — before this, `entrants.display_name` was
// set once at create and no screen could change it.
//
// Static markup like the sibling panel tests (vitest here is node-only, no
// DOM): what the field OPENS AT, its label, its limit, and who gets it. The
// blur → PATCH → row-header wiring is a browser question, answered by
// e2e/entrant-rename.spec.ts.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import uiEn from "@/dictionaries/en/ui.json";
import { t } from "@/lib/i18n-runtime";
import { ENTRANT_NAME_MAX } from "@/lib/entrant-roster-name";
import { IME_PROCESS_KEY_CODE, nameFieldCommit, nameFieldEnterCommits } from "@/lib/inline-name-edit";
import { EntrantNameField } from "@/components/v2/entrants-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const label = t(uiEn, "entrants.row.name");

describe("EntrantNameField — markup", () => {
  it("opens AT the entrant's current name, under the dictionary's Name label", () => {
    const html = renderToStaticMarkup(
      <EntrantNameField name="Sankar & Ritwik" canEdit onRename={() => {}} />,
    );
    // The seeded VALUE, not merely "an input exists": a field that opened
    // blank (or at a stale name) would be one blur away from a bad rename.
    expect(html).toContain('value="Sankar &amp; Ritwik"');
    expect(label.length).toBeGreaterThan(0);
    expect(html).toContain(`>${label}</span>`);
    // Label wraps the input, so the input's accessible name IS the label.
    expect(html).toMatch(/^<label[^>]*>.*<input[^>]*>.*<\/label>$/s);
    expect(html).toContain('data-testid="entrant-name-field"');
  });

  it("caps typing at the API's own limit, so the field cannot offer a name the PATCH refuses", () => {
    const html = renderToStaticMarkup(<EntrantNameField name="A" canEdit onRename={() => {}} />);
    expect(html).toContain(`maxLength="${ENTRANT_NAME_MAX}"`);
  });

  it("a read-only viewer gets no field at all (the row header still names the entrant)", () => {
    const html = renderToStaticMarkup(
      <EntrantNameField name="Sankar & Ritwik" canEdit={false} onRename={() => {}} />,
    );
    expect(html).toBe("");
    // Positive pair: the SAME props with canEdit render the field.
    expect(
      renderToStaticMarkup(<EntrantNameField name="Sankar & Ritwik" canEdit onRename={() => {}} />),
    ).toContain("<input");
  });
});

describe("nameFieldCommit — what a blur saves", () => {
  it("a real change is saved, trimmed", () => {
    expect(nameFieldCommit("Court Kings", "Sankar & Ritwik")).toBe("Court Kings");
    expect(nameFieldCommit("  Court Kings  ", "Sankar & Ritwik")).toBe("Court Kings");
  });

  it("an emptied field saves nothing (the caller puts the name back)", () => {
    expect(nameFieldCommit("", "Sankar & Ritwik")).toBeNull();
    expect(nameFieldCommit("   ", "Sankar & Ritwik")).toBeNull();
  });

  it("an unchanged name saves nothing, whitespace included", () => {
    expect(nameFieldCommit("Sankar & Ritwik", "Sankar & Ritwik")).toBeNull();
    expect(nameFieldCommit(" Sankar & Ritwik ", "Sankar & Ritwik")).toBeNull();
  });

  it("a one-character name is a real name", () => {
    expect(nameFieldCommit("Q", "Sankar & Ritwik")).toBe("Q");
  });
});

// keyCode as a browser sends it: 13 for a plain Enter, 229 while an input
// method handles the key.
const ENTER = 13;

describe("nameFieldEnterCommits — which keydown saves the name", () => {
  it("Enter commits", () => {
    expect(nameFieldEnterCommits("Enter", false, ENTER)).toBe(true);
  });

  it("Enter while an input method is composing picks the candidate, and does not commit", () => {
    // Japanese/Chinese/Korean input: committing here would save half-typed text.
    expect(nameFieldEnterCommits("Enter", true, IME_PROCESS_KEY_CODE)).toBe(false);
  });

  it("Safari's composition-ending Enter (isComposing already false, keyCode 229) does not commit", () => {
    // Safari fires this keydown AFTER compositionend, so only its keyCode says
    // the input method owns it.
    expect(IME_PROCESS_KEY_CODE).toBe(229);
    expect(nameFieldEnterCommits("Enter", false, IME_PROCESS_KEY_CODE)).toBe(false);
  });

  it("no other key commits", () => {
    expect(nameFieldEnterCommits("a", false, 65)).toBe(false);
    expect(nameFieldEnterCommits("Tab", false, 9)).toBe(false);
  });
});
