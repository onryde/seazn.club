// Task 16 sign-off D8: at 320px the French "Inviter de nouveau et relancer l'enregistrement" confirm button wrapped to three lines beside
// Cancel in the arbiter column's two confirmation dialogs. Below 400px wide their buttons stack, full width, in the DOM order the specs
// click through (cancel, then confirm). The stacking is an OPT-IN prop on the shared dialog: every other caller of ConfirmDialog
// (deletes, overrides, the schedule gate) keeps its row byte-for-byte.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "../confirm-dialog";

const noop = () => undefined;
const render = (extra: { stackActions?: boolean } = {}, confirm = true) =>
  renderToStaticMarkup(
    <ConfirmDialog open title="Reopen round 3?" testId="dlg" confirmLabel={confirm ? "Inviter de nouveau" : undefined} cancelLabel="Annuler" onConfirm={noop} onCancel={noop} {...extra}>
      body
    </ConfirmDialog>,
  );

/** The whole class tokens of the element carrying `testid`. */
const tokens = (h: string, testid: string) => new Set((new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h)?.[0].match(/\sclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean));
/** The row the two buttons sit in: the parent of the cancel button, read from its opening tag. */
const rowTokens = (h: string) => {
  const before = h.slice(0, h.indexOf('data-testid="dlg-cancel"'));
  const open = before.slice(before.lastIndexOf("<div", before.lastIndexOf("<button")));
  return new Set((/\sclass="([^"]*)"/.exec(open)?.[1] ?? "").split(/\s+/).filter(Boolean));
};

describe("ConfirmDialog stackActions (D8)", () => {
  it("opted in: the row is a column below 400px and both buttons fill it, cancel before confirm in the DOM", () => {
    const h = render({ stackActions: true });
    const row = rowTokens(h);
    expect(row.has("max-[400px]:flex-col"), "the row stacks below 400px").toBe(true);
    for (const id of ["dlg-cancel", "dlg-confirm"]) expect(tokens(h, id).has("max-[400px]:w-full"), `${id} fills the stacked row`).toBe(true);
    expect(h.indexOf('data-testid="dlg-cancel"'), "DOM order: cancel, then confirm").toBeLessThan(h.indexOf('data-testid="dlg-confirm"'));
    // The stack is scoped to narrow viewports: from 400px the row is what it always was.
    expect(row.has("flex") && row.has("justify-end") && row.has("gap-2"), "the row is still a right-aligned flex row from 400px").toBe(true);
    expect([...row].filter((x) => /^flex-col$/.test(x)), "no unscoped flex-col").toEqual([]);
  });

  it("not opted in: the row and both buttons are exactly what every other caller has always rendered", () => {
    const h = render();
    expect([...rowTokens(h)].sort()).toEqual(["flex", "gap-2", "justify-end"]);
    expect([...tokens(h, "dlg-cancel")].sort()).toEqual(["btn", "btn-ghost", "min-h-11"]);
    expect([...tokens(h, "dlg-confirm")].sort()).toEqual(["btn", "btn-danger", "min-h-11"]);
    expect(h).not.toContain("max-[400px]");
  });

  it("a report-only dialog (no confirm button) opted in stacks nothing it does not have", () => {
    const h = render({ stackActions: true }, false);
    expect(h).not.toContain('data-testid="dlg-confirm"');
    expect(tokens(h, "dlg-cancel").has("max-[400px]:w-full")).toBe(true);
  });
});
