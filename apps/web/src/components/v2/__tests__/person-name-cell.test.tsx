// A player's name, renamable in place in the directory (owner design A,
// 2026-09-22 — before this a player's name was set once when they were added,
// and no screen could change it).
//
// Static markup (vitest here is node-only, no DOM): who gets the ✎, what it
// is called, how big it is, and what the field OPENS AT. Tap → field → blur →
// PATCH → row is a browser question, answered by e2e/entrant-rename.spec.ts
// and the entrant-rename walkthrough.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import uiEn from "@/dictionaries/en/ui.json";
import { t } from "@/lib/i18n-runtime";
import { IME_PROCESS_KEY_CODE, nameFieldEscapeCancels } from "@/lib/inline-name-edit";
import { PERSON_NAME_MAX } from "@/lib/person-name";
import { PatchPerson } from "@/server/api-v1/schemas";
import { PersonNameCell, PersonNameInput } from "@/components/v2/persons-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const saved = async () => true;

describe("PersonNameCell — the name and its ✎", () => {
  it("an editor gets a ✎ named for the player, from the dictionary", () => {
    const html = renderToStaticMarkup(<PersonNameCell name="Sankar K" meta="1990-04-02 · m" canEdit onRename={saved} />);
    const accessibleName = t(uiEn, "persons.rename", { name: "Sankar K" });
    expect(accessibleName).toContain("Sankar K");
    expect(html).toContain(`aria-label="${accessibleName}"`);
    expect(html).toMatch(/<button type="button"[^>]*>/);
    // The glyph is decoration; the label is the button's name.
    expect(html).toContain('<span aria-hidden="true">✎</span>');
    expect(html).toContain(">Sankar K</span>");
  });

  it("the ✎ is a 44px tap target, however small the glyph looks", () => {
    const html = renderToStaticMarkup(<PersonNameCell name="Sankar K" meta="1990-04-02 · m" canEdit onRename={saved} />);
    const button = html.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(button.split(/\s+/)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
  });

  it("a read-only viewer sees the name and no ✎", () => {
    const html = renderToStaticMarkup(
      <PersonNameCell name="Sankar K" meta="1990-04-02 · m" canEdit={false} onRename={saved} />,
    );
    expect(html).toContain(">Sankar K</span>");
    expect(html).not.toContain("<button");
    // Positive pair: the same props with canEdit DO render it.
    expect(renderToStaticMarkup(<PersonNameCell name="Sankar K" meta="1990-04-02 · m" canEdit onRename={saved} />)).toContain(
      "<button",
    );
  });

  it("opens idle: the name is text, not a field, until the ✎ is tapped", () => {
    const html = renderToStaticMarkup(<PersonNameCell name="Sankar K" meta="1990-04-02 · m" canEdit onRename={saved} />);
    expect(html).not.toContain("<input");
    // Idle is VISIBLE: the two lines only turn invisible under an open field.
    expect(html).not.toMatch(/class="[^"]*\binvisible\b/);
  });

  it("keeps the line under the name, for editors and read-only viewers alike", () => {
    for (const canEdit of [true, false]) {
      const html = renderToStaticMarkup(
        <PersonNameCell name="Sankar K" meta="1990-04-02 · m" canEdit={canEdit} onRename={saved} />,
      );
      expect(html).toContain(">1990-04-02 · m</span>");
    }
  });
});

describe("PersonNameInput — the field the ✎ opens", () => {
  const open = () =>
    renderToStaticMarkup(
      <PersonNameInput name="Sankar K" onSave={async () => {}} onClose={() => {}} />,
    );

  it("opens AT the player's current name, with the dictionary's label", () => {
    const html = open();
    // The seeded VALUE: a field that opened blank or stale is one blur away
    // from a wrong rename.
    expect(html).toContain('value="Sankar K"');
    const label = t(uiEn, "persons.rename.label");
    expect(label.length).toBeGreaterThan(0);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('data-testid="person-name-field"');
  });

  it("caps typing at the PATCH's own limit, so it cannot offer a name the API refuses", () => {
    expect(open()).toContain(`maxLength="${PERSON_NAME_MAX}"`);
    // The limit IS the schema's: the longest accepted, and one past it refused.
    expect(PatchPerson.safeParse({ full_name: "x".repeat(PERSON_NAME_MAX) }).success).toBe(true);
    expect(PatchPerson.safeParse({ full_name: "x".repeat(PERSON_NAME_MAX + 1) }).success).toBe(false);
  });
});

// keyCode as a browser sends it: 27 for a plain Escape, 229 while an input
// method handles the key.
const ESCAPE = 27;

describe("nameFieldEscapeCancels — which keydown abandons the edit", () => {
  it("Escape cancels", () => {
    expect(nameFieldEscapeCancels("Escape", false, ESCAPE)).toBe(true);
  });

  it("Escape while an input method is composing drops the candidate, not the edit", () => {
    expect(nameFieldEscapeCancels("Escape", true, IME_PROCESS_KEY_CODE)).toBe(false);
  });

  it("an Escape the input method owns (keyCode 229, isComposing false, as Safari sends) does not cancel", () => {
    expect(nameFieldEscapeCancels("Escape", false, IME_PROCESS_KEY_CODE)).toBe(false);
  });

  it("no other key cancels", () => {
    for (const key of ["Enter", "Esc", "Tab", "Backspace", "a"]) {
      expect(nameFieldEscapeCancels(key, false, 0)).toBe(false);
    }
  });
});
