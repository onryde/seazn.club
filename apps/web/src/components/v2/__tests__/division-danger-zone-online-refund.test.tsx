// The danger zone tells an organiser what happens to a paid Online Chess package (spec 2026-11-23 §11; final review m2 and Q7).
//
//   - The delete dialog says how many credits come back, and how many included credits of an earlier month do not — the figure the
//     SERVER read (`divisionPackageRefund`, the refund's own split), never one the client works out. Only when the delete would
//     take the package: a started division's delete is refused, so the dialog must not promise its refund.
//   - Archive does NOT refund (archive holds the package). Once a division has started, delete is refused and pivots to archive —
//     so the refused-delete copy, and the archive dialog, send the organiser to switch Online Chess off, which is the door that
//     gives the credits back (danger-zone-refund.test.ts drives that door). Every other division keeps the copy it had.
//
// Expected sentences are the English dictionary's own plurals with the count filled in; the server figure is the prop.
//
// Mutant table (each run once by hand; results in the commit message):
//   U1 the delete dialog's refund line ignores `onDelete`          -> "a started division's delete dialog promises nothing"
//   U2 the forfeited sentence shown at 0                            -> "the delete dialog says how many credits come back …"
//   U3 the refused-delete pivot keeps the generic copy               -> "a refused delete pivots to archive copy that sends …"
//   U4 the archive hint shown when nothing would come back (back 0)  -> "nothing to get back: the archive copy is the generic one"
//   U5 the archive hint also shown under the pivot (said twice)      -> "a refused delete pivots to archive copy … only that sentence, once"
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { DivisionDangerZone } from "@/components/v2/division-danger-zone";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push, replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});
const api = vi.mocked(apiV1);

const BASE = { divisionId: "d1", divisionName: "Open", orgSlug: "org", compSlug: "comp" };
type Refund = { back: number; forfeited: number; onDelete: boolean } | null | undefined;

const mount = (packageRefund: Refund) => renderIsland(DivisionDangerZone, { ...BASE, packageRefund });

const en = uiEn as Record<string, string>;
/** The English plural for `count`, from the dictionary (en: `one` for 1, `other` otherwise), the count filled in. */
function plural(base: string, count: number): string {
  const key = `${base}.${count === 1 ? "one" : "other"}`;
  expect(en[key], `the dictionary has ${key}`).toBeTypeOf("string");
  return en[key]!.replaceAll("{count}", String(count));
}

/** A dialog's body, read as the string the reader meets (renderIsland renders one level deep, so the dialog's children are built). */
function dialogBody(h: ReturnType<typeof mount>, confirmKey: "danger.deleteConfirm" | "danger.archiveConfirm"): string {
  const dialog = h.tree().find((el: ReactElement) => propsOf(el).confirmLabel === en[confirmKey]);
  if (!dialog) throw new Error(`${confirmKey} dialog not found`);
  return textOf(propsOf(dialog).children as ReactNode);
}
const deleteBody = (h: ReturnType<typeof mount>) => dialogBody(h, "danger.deleteConfirm");
const archiveBody = (h: ReturnType<typeof mount>) => dialogBody(h, "danger.archiveConfirm");

/** The refund-line fragments that must NOT appear when there is no refund to talk about. */
const ONLINE_FRAGMENTS = () => [en["danger.refundedLabel"]!, ...["one", "other"].flatMap((f) => [
  en[`danger.onlineRefund.${f}`]!.split("{count}")[0]!, en[`danger.archiveOnline.${f}`]!.split("{count}")[0]!,
  en[`danger.suggestArchiveOnline.${f}`]!.split("{count}")[0]!,
])];

/** Press Delete's confirm and let the refused DELETE land (a 409 DIVISION_HAS_RESULTS: the division has started). */
async function refusedDelete(h: ReturnType<typeof mount>): Promise<void> {
  api.mockRejectedValueOnce(new ApiV1Error("started", 409, "DIVISION_HAS_RESULTS", { archive: true }));
  const dialog = h.tree().find((el: ReactElement) => propsOf(el).confirmLabel === en["danger.deleteConfirm"])!;
  (propsOf(dialog).onConfirm as () => void)();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  expect(push, "a refused delete navigates nowhere").not.toHaveBeenCalled();
  expect(propsOf(h.tree().find((el: ReactElement) => propsOf(el).confirmLabel === en["danger.archiveConfirm"])!).open, "it pivoted to archive")
    .toBe(true);
}

describe("the delete dialog says what a paid Online Chess package gives back", () => {
  it("the delete dialog says how many credits come back, and no earlier-month sentence when none are lost", () => {
    const body = deleteBody(mount({ back: 8, forfeited: 0, onDelete: true }));
    expect(body).toContain(en["danger.refundedLabel"]);
    expect(body).toContain(plural("danger.onlineRefund", 8));
    for (const n of [0, 1, 8]) expect(body, `no forfeit sentence (${n})`).not.toContain(plural("danger.onlineForfeit", n));
    // The singular is its own sentence, not the plural with a 1 in it.
    expect(deleteBody(mount({ back: 1, forfeited: 0, onDelete: true }))).toContain(plural("danger.onlineRefund", 1));
  });

  it("an earlier month's included credits are counted as not coming back", () => {
    const body = deleteBody(mount({ back: 3, forfeited: 2, onDelete: true }));
    expect(body).toContain(plural("danger.onlineRefund", 3));
    expect(body).toContain(plural("danger.onlineForfeit", 2));
    // Nothing comes back but the loss is still said (every included credit was an earlier month's).
    const lost = deleteBody(mount({ back: 0, forfeited: 5, onDelete: true }));
    expect(lost).toContain(plural("danger.onlineRefund", 0));
    expect(lost).toContain(plural("danger.onlineForfeit", 5));
  });

  it("a started division's delete dialog promises nothing (the delete would be refused, not refund)", () => {
    const body = deleteBody(mount({ back: 8, forfeited: 0, onDelete: false }));
    expect(body).not.toContain(en["danger.refundedLabel"]);
    expect(body).not.toContain(plural("danger.onlineRefund", 8));
    expect(body, "the dialog's own copy is untouched").toContain(en["danger.destroyedText"]);
  });

  it("no paid package (none, unpaid or frozen: the server reads null) or no answer at all: the dialogs read as they always did", () => {
    let checked = 0;
    for (const refund of [null, undefined] as const) {
      const h = mount(refund);
      const text = `${deleteBody(h)} ${archiveBody(h)}`;
      for (const fragment of ONLINE_FRAGMENTS()) expect(text, `${String(refund)}: ${fragment}`).not.toContain(fragment);
      expect(archiveBody(h)).toBe(en["danger.archiveBody"]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe("archive keeps the package: the copy sends the organiser to switch Online Chess off", () => {
  it("the archive dialog says archiving does not refund, and how to get the credits back", () => {
    const h = mount({ back: 8, forfeited: 0, onDelete: true });
    expect(archiveBody(h)).toContain(en["danger.archiveBody"]);
    expect(archiveBody(h)).toContain(plural("danger.archiveOnline", 8));
    // A started division too: archive is its only other way out.
    expect(archiveBody(mount({ back: 2, forfeited: 1, onDelete: false }))).toContain(plural("danger.archiveOnline", 2));
  });

  it("nothing to get back: the archive copy is the generic one", () => {
    const h = mount({ back: 0, forfeited: 5, onDelete: true });
    expect(archiveBody(h)).toBe(en["danger.archiveBody"]);
  });

  it("a refused delete pivots to archive copy that sends the organiser to switch Online Chess off — and only that sentence, once", async () => {
    const h = mount({ back: 8, forfeited: 0, onDelete: false });
    await refusedDelete(h);
    const body = archiveBody(h);
    expect(body).toContain(plural("danger.suggestArchiveOnline", 8));
    expect(body, "the generic refused-delete copy is replaced, not stacked").not.toContain(en["danger.suggestArchive"]);
    expect(body, "the hint is not said twice").not.toContain(plural("danger.archiveOnline", 8));
  });

  it("a refused delete of a division with no paid package keeps the copy it always had", async () => {
    const h = mount(null);
    await refusedDelete(h);
    const body = archiveBody(h);
    expect(body).toContain(en["danger.suggestArchive"]);
    for (const fragment of ONLINE_FRAGMENTS()) expect(body, fragment).not.toContain(fragment);
  });
});

describe("the way out the copy names is the screen's own words, in every locale", () => {
  // The archive copy names where the switch is: the Fixtures tab, its Division rules, the Online Chess control. A rename of any
  // of the three must move this copy with it, so each locale's sentence is checked against that locale's own labels.
  it("each locale's switch-off copy names its Fixtures tab, Division rules and Online Chess labels", () => {
    const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const labels = [dict["div.detail.tab.fixtures"], dict["rulesStrip.title"], dict["divset.onlinePlay.label"]];
      for (const l of labels) expect(l, `${locale}: premise, the label exists`).toBeTypeOf("string");
      for (const key of ["danger.archiveOnline.one", "danger.archiveOnline.other", "danger.suggestArchiveOnline.one", "danger.suggestArchiveOnline.other"]) {
        const copy = dict[key];
        expect(copy, `${locale} ${key}`).toBeTypeOf("string");
        for (const l of labels) expect(copy, `${locale} ${key} names "${l}"`).toContain(l);
        expect(copy, `${locale} ${key} carries the count`).toContain("{count}");
        checked += 1;
      }
    }
    expect(checked, "4 locales x 4 keys").toBe(16);
  });
});
