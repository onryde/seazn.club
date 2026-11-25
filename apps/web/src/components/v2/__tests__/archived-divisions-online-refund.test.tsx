// The PURGE dialog says what a paid Online Chess package does when its archived division is purged (spec 2026-11-23 §11).
//
//   - Archive HOLDS the package (it refunds nothing: danger-zone-refund.test.ts "archive keeps the figure"), and the purge —
//     `deleteDivision` on an archived division past the 30-day cool-off — is the delete door, which refunds a paid, unfrozen
//     package in full (delete-doors.test.ts "archive holds the package; restore returns it; purge refunds"). So the dialog owes
//     the same line the delete dialog already says, off the SERVER's own figure (`packageRefund`, `packageRefundPreview`'s split),
//     never one the client works out.
//   - A paid package a round has frozen is never refunded (P7): the purge says so, in the delete dialog's own sentence.
//   - No package (an over-the-board division), an unpaid one (deleted with no money) or no answer: no money line at all.
//
// The words are the delete dialog's own keys (`danger.refundedLabel`, `danger.onlineRefund`, `danger.onlineForfeit`,
// `danger.onlineFrozen`), expected from the English dictionary with the count filled in.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ArchivedDivisions, type ArchivedDivisionLite } from "@/components/v2/archived-divisions";
import uiEn from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/settings",
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: vi.fn(),
}));

const en = uiEn as Record<string, string>;
function plural(base: string, count: number): string {
  const key = `${base}.${count === 1 ? "one" : "other"}`;
  expect(en[key], `the dictionary has ${key}`).toBeTypeOf("string");
  return en[key]!.replaceAll("{count}", String(count));
}

// Archived long ago: the purge cool-off is over, so the Purge button is live.
const row = (id: string, name: string, packageRefund?: ArchivedDivisionLite["packageRefund"]): ArchivedDivisionLite => ({
  id, name, sport_key: "boardgame", archived_at: "2020-01-02T00:00:00.000Z", ...(packageRefund === undefined ? {} : { packageRefund }),
});

type Mounted = ReturnType<typeof mountWith>;
const mountWith = (divisions: ArchivedDivisionLite[]) =>
  renderIsland(ArchivedDivisions, { divisions, canEdit: true, archivedSlotsExplainRefusal: false, viewerPlan: "community" });

/** Press Purge on row `index`, the way the organiser does; the dialog opens on THAT row. */
function pressPurge(h: Mounted, index: number): void {
  const buttons = h.tree().filter((el) => el.type === "button" && textOf(el) === en["archived.purge"]);
  expect(buttons.length, "one Purge button per row").toBeGreaterThan(index);
  expect(propsOf(buttons[index]!).disabled, "the cool-off is over: Purge is live").toBe(false);
  (propsOf(buttons[index]!).onClick as () => void)();
}

function purgeDialog(h: Mounted): ReactElement {
  const dialog = h.tree().find((el) => propsOf(el).confirmLabel === en["archived.purgeConfirm"]);
  if (!dialog) throw new Error("purge dialog not found");
  return dialog;
}

/** The dialog's paragraphs, each read on its own. */
function paragraphs(h: Mounted): string[] {
  const out: string[] = [];
  const walkNode = (n: ReactNode): void => {
    if (Array.isArray(n)) for (const c of n) walkNode(c as ReactNode);
    else if (n !== null && typeof n === "object" && "type" in n) {
      const el = n as ReactElement;
      if (el.type === "p") out.push(textOf(el as unknown as ReactNode));
      else walkNode(propsOf(el).children as ReactNode);
    }
  };
  walkNode(propsOf(purgeDialog(h)).children as ReactNode);
  return out;
}

const MONEY_FRAGMENTS = (): string[] => [
  en["danger.refundedLabel"]!, en["danger.onlineFrozen"]!,
  ...["one", "other"].flatMap((f) => [en[`danger.onlineRefund.${f}`]!.split("{count}")[0]!, en[`danger.onlineForfeit.${f}`]!.split("{count}")[1]!]),
];

describe("the purge dialog says what a paid Online Chess package gives back", () => {
  it("paid, unfrozen: the credits that come back, off the server figure, as a paragraph of its own", () => {
    const h = mountWith([row("d1", "Club Rapid", { back: 8, forfeited: 0 })]);
    pressPurge(h, 0);
    const paras = paragraphs(h);
    const line = paras.filter((p) => p.includes(en["danger.refundedLabel"]!));
    expect(line, "the refund line, once").toHaveLength(1);
    expect(line[0]).toContain(plural("danger.onlineRefund", 8));
    for (const n of [0, 1, 8]) expect(paras.join(" "), `no forfeit sentence at forfeited 0 (${n})`).not.toContain(plural("danger.onlineForfeit", n));
    expect(paras.some((p) => p.includes(en["danger.destroyedLabel"]!) && p.includes(en["archived.destroyedText"]!)), "the dialog's own copy is untouched").toBe(true);
    expect(paras.at(-1), "and the can't-undo line still closes it").toBe(en["danger.cannotUndo"]);
  });

  it("the singular is its own sentence; an earlier month's included credits are said as not coming back", () => {
    const one = mountWith([row("d1", "Club Rapid", { back: 1, forfeited: 0 })]);
    pressPurge(one, 0);
    expect(paragraphs(one).join(" ")).toContain(plural("danger.onlineRefund", 1));
    const lost = mountWith([row("d1", "Club Rapid", { back: 3, forfeited: 2 })]);
    pressPurge(lost, 0);
    const text = paragraphs(lost).join(" ");
    expect(text).toContain(plural("danger.onlineRefund", 3));
    expect(text).toContain(plural("danger.onlineForfeit", 2));
  });

  it("paid and frozen (a round has opened): the purge says it is not refunded, and promises no credits", () => {
    const h = mountWith([row("d1", "Club Rapid", { frozen: true })]);
    pressPurge(h, 0);
    const paras = paragraphs(h);
    expect(paras.filter((p) => p === en["danger.onlineFrozen"]), "the frozen line, once, on its own").toHaveLength(1);
    const text = paras.join(" ");
    expect(text).not.toContain(en["danger.refundedLabel"]);
    for (const f of ["one", "other"]) expect(text).not.toContain(en[`danger.onlineRefund.${f}`]!.split("{count}")[0]!);
  });

  it("no package (over the board), unpaid (server null) or no answer: the dialog reads as it always did", () => {
    let checked = 0;
    for (const packageRefund of [null, undefined] as const) {
      const h = mountWith([row("d1", "Club Rapid", packageRefund)]);
      pressPurge(h, 0);
      const text = paragraphs(h).join(" ");
      for (const fragment of MONEY_FRAGMENTS()) expect(text, `${String(packageRefund)}: ${fragment}`).not.toContain(fragment);
      expect(paragraphs(h), "exactly the three lines it always had").toHaveLength(3);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the line follows the row purged: a second row's dialog does not carry the first row's money", () => {
    const h = mountWith([row("d1", "Paid One", { back: 8, forfeited: 0 }), row("d2", "Over The Board", null), row("d3", "Frozen One", { frozen: true })]);
    let checked = 0;
    const expectOn = (index: number, check: (text: string) => void): void => {
      pressPurge(h, index);
      expect(propsOf(purgeDialog(h)).open, `row ${index}: the dialog is open`).toBe(true);
      check(paragraphs(h).join(" "));
      checked += 1;
    };
    expectOn(0, (t) => { expect(t).toContain(plural("danger.onlineRefund", 8)); expect(t).not.toContain(en["danger.onlineFrozen"]); });
    expectOn(1, (t) => { for (const f of MONEY_FRAGMENTS()) expect(t).not.toContain(f); });
    expectOn(2, (t) => { expect(t).toContain(en["danger.onlineFrozen"]); expect(t).not.toContain(en["danger.refundedLabel"]); });
    expect(checked).toBe(3);
  });
});
