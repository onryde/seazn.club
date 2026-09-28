// The staff "Match credits" panel (Task 7A, Revision 4 — the OPTION-B modal). vitest is
// `environment: "node"`, but that does NOT put the modal out of reach:
// components/__tests__/_hook-harness.tsx supplies React's hook dispatcher itself and hands back
// the element TREE, so a trigger's own onClick prop can be CALLED and the modal asserted.
// Precedents: v2/__tests__/stages-panel-court-tags-modal.test.tsx:45-48 calls
// `(propsOf(button!).onClick as () => void)()` and then asserts modal-BODY copy that does not
// exist closed; registration-hub-config-panel.test.tsx:203-212 finds the modal by
// `e.type === Modal` and expands BOTH `children` and `footer`.
//
// Two traps the precedents came with, both live here:
//  * `walk` recurses into `props.children` ONLY (_hook-harness.tsx:108-116), and `textOf` the same
//    way (:121-139). Modal takes its buttons through the SEPARATE `footer` prop (modal.tsx:41,
//    rendered at :145-147), so without `expandPanel` below every assertion about Cancel or the
//    submit passes VACUOUSLY. Mutant C4 exists to prove that line is doing work.
//  * An input's opening VALUE is a PROP, never text: it is read with `propsOf(el).value`. That is
//    the difference between "the field is reachable" and "the field opens at the right number",
//    which AGENTS.md class 19 exists for.
//
// What is still the walkthrough's (Step 17), because it needs a browser: the network, the
// idempotency key's lifetime across a lost response, router.refresh(), the double-submit guard,
// and the widths.
// Killers (Step 13):
//   C0  opener wired      `onClick={openModal}` → `onClick={() => {}}`                        → "the modal OPENS AT"
//   C1  submit gate       `disabled={!form.note.trim() || busy}` → `disabled={busy}`           → "the modal OPENS AT" / "the submit gate"
//   C1' session field     drop the `form.kind === "refund" &&` condition                       → "the kind switch"
//   C1" session field     `=== "refund"` → `=== "grant"`                                       → "the kind switch", the other way
//   C2  author fallback   `r.createdByEmail ?? r.createdBy ?? "—"` → `r.createdByEmail ?? "—"`  → "rows render" (`>user-1<`)
//   C3  amount ceiling    `max={maxDelta}` → `max={50}`                                        → "the modal OPENS AT" (`max`)
//   C4  footer walked     delete the Cancel button from `footer`                               → "the modal OPENS AT" (cancel)
//   R5  the rail          delete `tabIndex={0}`                                                → "a keyboard-reachable scroll rail"
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import type { StreamCreditLedgerRow } from "@/server/usecases/admin-stream-credits";
import { AdminStreamCreditsPanel } from "../admin-stream-credits-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const row = (over: Partial<StreamCreditLedgerRow>): StreamCreditLedgerRow => ({
  id: "row-1", reason: "grant", delta: 1, balanceAfter: 1, note: "note", createdBy: "user-1",
  createdByEmail: "staff@example.test", sessionId: null, createdAt: "2026-09-16T10:20:30.000Z", ...over,
});

const PROPS = { orgId: "org-1", balance: 0, rows: [] as StreamCreditLedgerRow[], maxDelta: 7, ledgerLimit: 20 };

function render(props: Partial<typeof PROPS> = {}): string {
  return renderToStaticMarkup(<AdminStreamCreditsPanel {...PROPS} {...props} />);
}

/** The whole opening tag of the element carrying `testid` — asserting inside it, never across the page. */
function tag(html: string, el: string, testid: string): string {
  const m = html.match(new RegExp(`<${el}[^>]*data-testid="${testid}"[^>]*>`));
  expect(m, `<${el} data-testid="${testid}"> is missing`).not.toBeNull();
  return m![0];
}

/** `walk` already reaches the Modal's BODY, because the body is `props.children`
 *  (_hook-harness.tsx:108-116). `footer` is a separate prop and is NOT walked, so Cancel and the
 *  submit are invisible without this — registration-hub-config-panel.test.tsx:209's idiom. */
function expandPanel(node: ReactNode): ReactElement[] {
  const out = walk(node);
  const modal = out.find((e) => e.type === Modal);
  const footer = modal ? propsOf(modal).footer : undefined;
  if (footer) out.push(...walk(footer as ReactNode));
  return out;
}

type Island = { tree: () => ReactElement[]; text: () => string };
const island = () => renderIsland(AdminStreamCreditsPanel, PROPS, expandPanel) as Island;
const at = (is: Island, testid: string): ReactElement | undefined =>
  is.tree().find((e) => propsOf(e)["data-testid"] === testid);
const must = (is: Island, testid: string): ReactElement => {
  const el = at(is, testid);
  expect(el, `${testid} is not in the expanded tree`).toBeTruthy();
  return el!;
};
/** Drive a control's own handler, the way the browser would (court-tags-modal.test.tsx:45-48). */
const click = (is: Island, testid: string) => (propsOf(must(is, testid)).onClick as () => void)();
const change = (is: Island, testid: string, value: string) =>
  (propsOf(must(is, testid)).onChange as (e: { target: { value: string } }) => void)({ target: { value } });

describe("AdminStreamCreditsPanel — the closed panel", () => {
  it("an EMPTY ledger: balance 0, the empty line, the Adjust-credits opener, and NO modal — no row, no ledger rail, no field, no error and no replay notice (the empty set, explicitly)", () => {
    const html = render();
    expect(html).toMatch(/data-testid="stream-credits-balance"[^>]*>0</);
    expect(html).toContain('data-testid="stream-credits-empty"');
    expect(tag(html, "button", "stream-credits-adjust")).toContain('type="button"');
    expect(html).toContain("Adjust credits");
    // Closed means closed: the modal renders only behind `open`, so none of its controls — nor
    // the dialog itself — is in the markup. Every "opens at" claim below rests on this.
    for (const id of ["stream-credits-kind", "stream-credits-amount", "stream-credits-note",
                      "stream-credits-session", "stream-credits-submit", "stream-credits-cancel"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-testid="stream-credits-row"');
    expect(html).not.toContain('data-testid="stream-credits-ledger"');
    expect(html).not.toContain('data-testid="stream-credits-error"');
    expect(html).not.toContain('data-testid="stream-credits-replayed"');
    expect(html).not.toContain("idempotency");   // no key in the markup: it is minted on the open
  });

  it("rows render in the order given, with reason, SIGNED delta, balance after, note, author (the email, else the user id), session and a UTC stamp; a missing author/note/session reads — (C2)", () => {
    const html = render({
      balance: 3,
      rows: [
        // An author whose users row has no email to show: the id is printed, never a bare —.
        row({ id: "r3", reason: "revoke", delta: -1, balanceAfter: 3, note: "one too many", createdByEmail: null }),
        row({ id: "r2", reason: "consume", delta: -1, balanceAfter: 4, note: null, createdBy: null, createdByEmail: null,
              sessionId: "5e5510e1-0000-4000-8000-000000000001", createdAt: "2026-09-16T11:00:00.000Z" }),
        row({ id: "r1", reason: "grant", delta: 5, balanceAfter: 5, note: "pilot league" }),
      ],
    });
    expect(html).toMatch(/data-testid="stream-credits-balance"[^>]*>3</);
    expect(html).not.toContain('data-testid="stream-credits-empty"');
    expect([...html.matchAll(/data-testid="stream-credits-row" data-reason="([a-z]+)" data-delta="(-?\d+)"/g)].map((m) => [m[1], m[2]]))
      .toEqual([["revoke", "-1"], ["consume", "-1"], ["grant", "5"]]);
    for (const text of [">-1<", ">+5<", ">one too many<", ">pilot league<", ">staff@example.test<", ">user-1<", ">5e5510e1-0000-4000-8000-000000000001<", ">2026-09-16 11:00 UTC<", ">—<"]) {
      expect(html, text).toContain(text);
    }
  });

  it("the ledger is a keyboard-reachable scroll rail: overflow-x-auto with tabindex 0, role region and an accessible name (R5; axe scrollable-region-focusable; page.tsx:284-289's idiom)", () => {
    const rail = tag(render({ rows: [row({})] }), "div", "stream-credits-ledger");
    expect(rail).toContain('tabindex="0"');
    expect(rail).toContain('role="region"');
    expect(rail).toContain('aria-label="Match credits ledger"');
    expect(rail).toMatch(/class="[^"]*\boverflow-x-auto\b/);
  });
});

describe("AdminStreamCreditsPanel — the Adjust-credits modal, opened by its own trigger", () => {
  it("the modal OPENS AT action grant with the three actions in order, amount 1 with min 1 and max = the maxDelta PROP (7 here, not the route's 50), an empty note, NO session field, the submit DISABLED, and Cancel in the FOOTER (C0, C1, C3, C4)", () => {
    const is = island();
    expect(is.tree().find((e) => e.type === Modal), "the modal is open before any click").toBeFalsy();
    click(is, "stream-credits-adjust");
    const modal = is.tree().find((e) => e.type === Modal);
    expect(modal, "the trigger's onClick did not open the modal").toBeTruthy();
    expect(propsOf(modal!).title).toBe("Adjust match credits");

    // Every one of these is a PROP, not text — textOf would never see a single one of them.
    const kind = must(is, "stream-credits-kind");
    expect(propsOf(kind).value).toBe("grant");
    expect(walk(propsOf(kind).children as ReactNode).map((o) => propsOf(o).value))
      .toEqual(["grant", "refund", "revoke"]);
    const amount = must(is, "stream-credits-amount");
    expect(propsOf(amount).value).toBe("1");
    expect(propsOf(amount).min).toBe(1);
    expect(propsOf(amount).max).toBe(7);
    expect(propsOf(must(is, "stream-credits-note")).value).toBe("");
    // A session caps a refund, so a modal that opens at `grant` has no session field at all.
    expect(at(is, "stream-credits-session"), "the session field is present at grant").toBeUndefined();
    expect(propsOf(must(is, "stream-credits-submit")).disabled).toBe(true);
    // Reached only through expandPanel's footer walk (C4): `walk` alone cannot see either button.
    expect(propsOf(must(is, "stream-credits-cancel")).className).toContain("btn-ghost");
    // No error and no replay notice on a freshly opened modal.
    expect(at(is, "stream-credits-error")).toBeUndefined();
    expect(at(is, "stream-credits-replayed")).toBeUndefined();
  });

  it("the submit gate: DISABLED with an empty note and with whitespace only, ENABLED once a real note is typed — the negative assertion with its positive pair (C1)", () => {
    const is = island();
    click(is, "stream-credits-adjust");
    expect(propsOf(must(is, "stream-credits-submit")).disabled).toBe(true);
    change(is, "stream-credits-note", "   ");
    expect(propsOf(must(is, "stream-credits-submit")).disabled, "whitespace is not a note").toBe(true);
    change(is, "stream-credits-note", "pilot league");
    expect(propsOf(must(is, "stream-credits-note")).value).toBe("pilot league");
    expect(propsOf(must(is, "stream-credits-submit")).disabled).toBe(false);
  });

  it("the kind switch: choosing refund adds the session field EMPTY, choosing grant or revoke takes it away again, and the amount and note survive the switch (C1', C1\")", () => {
    const is = island();
    click(is, "stream-credits-adjust");
    change(is, "stream-credits-note", "failed stream");
    change(is, "stream-credits-kind", "refund");
    expect(propsOf(must(is, "stream-credits-kind")).value).toBe("refund");
    expect(propsOf(must(is, "stream-credits-session")).value).toBe("");
    change(is, "stream-credits-kind", "revoke");
    expect(at(is, "stream-credits-session"), "the session field survived a switch to revoke").toBeUndefined();
    change(is, "stream-credits-kind", "grant");
    expect(at(is, "stream-credits-session"), "the session field survived a switch to grant").toBeUndefined();
    // The fields the switch must NOT reset — only the 409 path and a fresh open reset the form.
    expect(propsOf(must(is, "stream-credits-amount")).value).toBe("1");
    expect(propsOf(must(is, "stream-credits-note")).value).toBe("failed stream");
  });
});
