// The entrants tab: adding entrants one at a time, and withdrawing one
// (Task 5). Product facts, read at Step 0 (components/v2/entrants-panel.tsx):
//  - AddEntrantForm (:684-758) is a <form> holding NewEntrantFields
//    (:940-1143) — unless the org has teams and the division takes a team
//    kind, when it opens on "Existing team" (hardcoded English toggle, not
//    handled here: a concern routed; the harness's orgs have no teams).
//  - NewEntrantFields: the Kind chips `data-kind={k}` + aria-pressed inside
//    role=group (:1028-1052) only when the division offers more than one kind
//    — else a static caption; `<label><span class="label">Name</span><input>`
//    and `<label><span class="label">Seed</span><input type=number>` (:1059-
//    1081, both labels hardcoded English); the button "Add entrant" (:1140,
//    hardcoded English; "Saving…" while busy), disabled while the name is
//    blank (:1137). submit() (:1005-1017) sends `{kind, display_name,
//    seed: seed ? Number(seed) : null, members}` — THE FORM SEEDS (the
//    brief's Step 0 question), so each entrant's seed is typed — and only
//    after the answer clears the fields (name "", seed "").
//  - The panel POSTs /api/v1/divisions/<id>/entrants (:397-409) — one row
//    per add.
//  - A row (:1480-1560): `entrant-row-disclosure` (the name, then ▸/▾);
//    `data-entrant-status={entrant.status}`; `entrant-row-withdraw` swapped
//    for `entrant-row-reinstate` once withdrawn. Withdraw (:584-597) asks
//    confirmDialog (role=alertdialog, ui/confirm-provider.tsx:153; confirm
//    button confirm.withdrawEntrant.label), then POSTs
//    /api/v1/entrants/<id>/withdraw with {}.
import type { Locator, Page } from "playwright";
import { actAndAwait } from "../respond.ts";
import { DATA, NAME, TESTID } from "../selectors.ts";
import type { EntrantKind, EntrantRow, WithdrawOut } from "../../driver/types.ts";
import { actBudget, attrEquals, awaitScreen, entrantNameMatcher, exactPath, navBudget, shoot, visit, type DivisionWhere, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";

export interface EntrantIn { displayName: string; seed: number | null; kind: EntrantKind }
/** The product's Entrant row (api-v1 schemas.ts Entrant). */
export type EntrantOut = EntrantRow & { kind: string };

export class EntrantNotAsTyped extends Error {
  constructor(field: "kind" | "display_name" | "seed", typed: unknown, stored: unknown) {
    super(`browser: the add form was given ${field} ${JSON.stringify(typed)}, and the product stored ${JSON.stringify(stored)} — what was typed never reached the form's state`);
    this.name = "EntrantNotAsTyped";
  }
}

/** The stored entrant is the one typed: kind, name and seed (null for blank). */
export function assertEntrantAsTyped(sent: EntrantIn, got: Pick<EntrantOut, "kind" | "display_name" | "seed">): void {
  if (got.kind !== sent.kind) throw new EntrantNotAsTyped("kind", sent.kind, got.kind);
  if (got.display_name !== sent.displayName) throw new EntrantNotAsTyped("display_name", sent.displayName, got.display_name);
  if (got.seed !== sent.seed) throw new EntrantNotAsTyped("seed", sent.seed, got.seed);
}

/** An entrant's row in the table, by its whole display name. */
function entrantRow(page: Page, displayName: string): Locator {
  return page.locator("tr").filter({ has: page.getByTestId(TESTID.entrantDisclosure.id).filter({ hasText: entrantNameMatcher(displayName) }) });
}

/** Adds `entrants`, one request each, in the order given (the caller's seed
 *  order); the product's rows. None to add is no visit and no picture. */
export async function addEntrantsUi(c: PageCtx, where: DivisionWhere, entrants: readonly EntrantIn[]): Promise<EntrantOut[]> {
  if (entrants.length === 0) return [];
  const { page } = c;
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const submit = page.getByRole("button", { name: NAME.addEntrant.text, exact: true });
  const form = page.locator("form").filter({ has: submit });
  const name = form.getByLabel(NAME.entrantName.text, { exact: true });
  // The first act is a kind chip where the form offers them, else the name.
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug, "entrants"), { control: form.locator(DATA.entrantKind.selector).or(name), what: "the add-entrant form's kind chips and name field" });
  await awaitScreen(() => name.waitFor({ state: "visible", timeout: nav }), "the add-entrant form", nav);
  const before = await shoot(c, "03-entrants-before");
  const out: EntrantOut[] = [];
  for (const e of entrants) {
    const chips = form.locator(DATA.entrantKind.selector);
    if ((await chips.count()) > 0) {
      const chip = attrEquals(DATA.entrantKind.selector, "entrant kind", e.kind);
      await form.locator(chip).click({ timeout: t });
      await awaitScreen(() => form.locator(`${chip}[aria-pressed="true"]`).waitFor({ state: "attached", timeout: t }), `the ${e.kind} kind, picked`, t);
    }
    await name.fill(e.displayName, { timeout: t });
    await form.getByLabel(NAME.entrantSeed.text, { exact: true }).fill(e.seed === null ? "" : String(e.seed), { timeout: t });
    const { data } = await actAndAwait<EntrantOut>(page, { method: "POST", path: exactPath(`/api/v1/divisions/${where.divisionId}/entrants`) },
      () => form.getByRole("button", { name: NAME.addEntrant.text, exact: true }).click({ timeout: t }), t);
    assertEntrantAsTyped(e, data);
    await awaitScreen(() => entrantRow(page, e.displayName).waitFor({ state: "attached", timeout: nav }), `${e.displayName}'s row`, nav);
    // The form clears itself after the answer: typing the next one earlier would be wiped.
    await awaitScreen(() => form.getByRole("button", { name: NAME.addEntrant.text, exact: true, disabled: true }).waitFor({ state: "attached", timeout: nav }), "the add-entrant form, cleared", nav);
    out.push(data);
  }
  await shoot(c, "03-entrants", before);
  return out;
}

/** Withdraws one entrant from its row; the product's WithdrawOut. */
export async function withdrawUi(c: PageCtx, where: DivisionWhere, entrant: { id: string; displayName: string }): Promise<WithdrawOut> {
  const { page } = c;
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const row = entrantRow(page, entrant.displayName);
  const withdraw = row.getByTestId(TESTID.entrantWithdraw.id);
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug, "entrants"), { control: withdraw, what: `${entrant.displayName}'s Withdraw` });
  await awaitScreen(() => row.waitFor({ state: "attached", timeout: nav }), `${entrant.displayName}'s row`, nav);
  const before = await shoot(c, "06-withdrawn-before");
  await withdraw.click({ timeout: t });
  const { data } = await actAndAwait<WithdrawOut>(page, { method: "POST", path: exactPath(`/api/v1/entrants/${entrant.id}/withdraw`) },
    () => page.getByRole("alertdialog").getByRole("button", { name: NAME.withdrawConfirm.text, exact: true }).click({ timeout: t }), t);
  const status = attrEquals(DATA.entrantStatus.selector, "entrant status", data.status);
  await awaitScreen(() => row.locator(status).waitFor({ state: "attached", timeout: nav }), `${entrant.displayName}'s row showing ${data.status}`, nav);
  await shoot(c, "06-withdrawn", before);
  return data;
}
