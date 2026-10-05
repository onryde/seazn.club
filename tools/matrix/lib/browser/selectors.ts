// Every selector and label the browser layer uses, each pinned to the product
// file it must appear in. selectors.test.ts reads those files — and the en
// dictionary — as TEXT; nothing is imported from apps/web (R3). A product
// rename reds the pin test by name instead of timing out mid-run.
import { readFileSync } from "node:fs";
import type { TemplateRowKey } from "../catalogue.ts";
import { templateField } from "../templates.ts";

export interface Pin { readonly file: string; readonly needle: string }
/** A testid. `needle` is its literal `data-testid="…"` in `file` — or, for a
 *  testid the product composes from a prop (ConfirmDialog's
 *  `${testId}-confirm`), the prop at the call site, with `via` pinning the
 *  composition in the dialog. */
export type TestidPin = { readonly id: string } & Pin & { readonly via?: Pin };
/** An accessible name or placeholder. A dictionary label names its en key
 *  and the component that passes it; a hardcoded English one is a Pin. A
 *  dictionary label the component decorates in a template literal carries
 *  `rendered`, that literal verbatim, and its `text` is derived from it (see
 *  `decorated` below). */
export type NamePin = { readonly text: string } & ({ readonly dictKey: string; readonly file: string; readonly rendered?: string; readonly dict?: Dictionary } | Pin);
/** Which en dictionary a label lives in: the organiser UI's (`ui.json`, the
 *  default) or the public site's (`public.json`). */
export type Dictionary = "ui" | "public";
/** An attribute selector with no testid (data-role, data-tile-id, …). */
export type DataPin = { readonly selector: string } & Pin;

/** Frozen, entries included, with the literal keys kept: `TESTID.typo` is a
 *  compile error, never a runtime `undefined`. */
function table<T extends Record<string, object>>(t: T): Readonly<T> {
  for (const v of Object.values(t)) Object.freeze(v);
  return Object.freeze(t);
}

const V2 = "apps/web/src/components/v2";
const STANDINGS_TABLE = "apps/web/src/components/public-site/standings-table.tsx";
const ORG_DIVISION_PAGE = "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx";
const PUBLIC_DIVISION_PAGE = "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx";
/** confirm-dialog.tsx derives both buttons from its `testId` prop. */
const CONFIRM_DIALOG: Pin = Object.freeze({ file: `${V2}/confirm-dialog.tsx`, needle: "`${testId}-confirm`" });

/** A dictionary label rendered inside the product's own template literal.
 *  Its name is DERIVED on read — the en value put through `rendered` — never
 *  retyped, so a dictionary edit moves it. Read lazily, like templateLabel. */
function decorated(dictKey: string, file: string, rendered: string): { readonly text: string; readonly dictKey: string; readonly file: string; readonly rendered: string } {
  return { dictKey, file, rendered, get text(): string { return renderedName(dictKey, rendered); } };
}

/** A dictionary label the component renders as is. Its name is DERIVED on
 *  read — the value in `dict`'s en file — never retyped (Task 5). */
function dictionary(dictKey: string, file: string, dict: Dictionary = "ui"): { readonly text: string; readonly dictKey: string; readonly file: string; readonly dict: Dictionary } {
  return { dictKey, file, dict, get text(): string { return enLabel(dictKey, dict); } };
}

/** A hardcoded English label (no dictionary key to pin). Its name is DERIVED
 *  from `needle`, the product's own literal — a quoted string or an element's
 *  text — never retyped (Task 5). */
function hardcoded(file: string, needle: string): { readonly text: string } & Pin {
  return { file, needle, get text(): string { return literalText(needle); } };
}

const testids = <T extends Record<string, TestidPin>>(t: T): Readonly<T> => table(t);
const names = <T extends Record<string, NamePin>>(t: T): Readonly<T> => table(t);
const data = <T extends Record<string, DataPin>>(t: T): Readonly<T> => table(t);

export const TESTID = testids({
  templateStartBlank: { id: "template-start-blank", file: `${V2}/template-gallery.tsx`, needle: 'data-testid="template-start-blank"' },
  builderName: { id: "division-builder-name", file: `${V2}/division-builder.tsx`, needle: 'data-testid="division-builder-name"' },
  builderNext: { id: "division-builder-next", file: `${V2}/division-builder.tsx`, needle: 'data-testid="division-builder-next"' },
  builderCreate: { id: "division-builder-create", file: `${V2}/division-builder.tsx`, needle: 'data-testid="division-builder-create"' },
  launchStart: { id: "launch-start-division", file: `${V2}/launch-actions.tsx`, needle: 'data-testid="launch-start-division"' },
  startConfirm: { id: "start-confirm-confirm", file: `${V2}/start-confirm-dialog.tsx`, needle: 'testId="start-confirm"', via: CONFIRM_DIALOG },
  gateConfirm: { id: "board-gate-confirm", file: `${V2}/board/schedule-gate-dialog.tsx`, needle: 'testId="board-gate"', via: CONFIRM_DIALOG },
  railTrigger: { id: "stage-rail-trigger", file: `${V2}/desk/stage-rail.tsx`, needle: 'data-testid="stage-rail-trigger"' },
  railSheet: { id: "stage-rail-sheet", file: `${V2}/desk/stage-rail.tsx`, needle: 'data-testid="stage-rail-sheet"' },
  stageGenerate: { id: "stage-generate", file: `${V2}/desk/stage-rail.tsx`, needle: 'data-testid="stage-generate"' },
  stageComplete: { id: "stage-complete", file: `${V2}/desk/stage-rail.tsx`, needle: 'data-testid="stage-complete"' },
  entrantWithdraw: { id: "entrant-row-withdraw", file: `${V2}/entrants-panel.tsx`, needle: 'data-testid="entrant-row-withdraw"' },
  // desk/run-sheet.tsx, not stages-panel.tsx (the brief's file; re-pinned at Step 0).
  runSheetFilter: { id: "run-sheet-filter", file: `${V2}/desk/run-sheet.tsx`, needle: 'data-testid="run-sheet-filter"' },
  scorePad: { id: "score-pad", file: `${V2}/fixture-console.tsx`, needle: 'data-testid="score-pad"' },
  // Task 5: the entrant row's name button, and the builder's refusal line.
  entrantDisclosure: { id: "entrant-row-disclosure", file: `${V2}/entrants-panel.tsx`, needle: 'data-testid="entrant-row-disclosure"' },
  builderError: { id: "division-builder-error", file: `${V2}/division-builder.tsx`, needle: 'data-testid="division-builder-error"' },
  // W1-driving Task 13: the template detail sheet's "Use this template" (template-gallery.tsx:421).
  templateDetailSubmit: { id: "template-detail-submit", file: `${V2}/template-gallery.tsx`, needle: 'data-testid="template-detail-submit"' },
  // Pad and console chassis testids are NOT restated here (ruling 38): they are the bench's
  // START_MATCH_TESTID, SEND_NOW_TESTID, FINALIZE_TESTID, FORFEIT_TESTID, FORFEIT_SIDE_TESTID_PREFIX,
  // PROMPT_REASON_TESTID, PROMPT_SUBMIT_TESTID, DOCK_CHIP_TESTID_PREFIX (scorer.ts:165-176), and the
  // sheet/tile/half selectors come from its selectorForTapStep (:140). Only the pins the bench
  // lacks are added, in PAD_PINS below.
});

/** Needles the bench's own pins never check (`score-start-match`,
 *  `pad-send-now`, `score-finalize`, `data-tile-id`, `pad-sheet-number`,
 *  `pad-sheet-confirm` are unpinned bench-side). Each maps a bench constant, or
 *  a `selectorForTapStep` output, to the product file it must appear in, so a
 *  product rename reds HERE and not as a timeout mid-run. */
export const PAD_PINS: readonly Readonly<{ name: string } & Pin>[] = Object.freeze([
  { name: "START_MATCH_TESTID", needle: "score-start-match", file: `${V2}/fixture-console.tsx` },
  { name: "FINALIZE_TESTID", needle: "score-finalize", file: `${V2}/fixture-console.tsx` },
  { name: "SEND_NOW_TESTID", needle: "pad-send-now", file: `${V2}/scorepad/v3/detail-dock.tsx` },
  { name: "tile", needle: "data-tile-id", file: `${V2}/scorepad/v3/tile-grid.tsx` },
  { name: "number", needle: "pad-sheet-number", file: `${V2}/scorepad/v3/guided-sheet.tsx` },
  { name: "confirm", needle: "pad-sheet-confirm", file: `${V2}/scorepad/v3/guided-sheet.tsx` },
  { name: "choice", needle: "data-choice-option-id", file: `${V2}/scorepad/v3/guided-sheet.tsx` },
  // A data-role, not a testid: the phone twin of the device hand-over.
  { name: "DEVICE_HANDOVER_PHONE", needle: 'data-role="device-handover-phone"', file: `${V2}/fixture-console.tsx` },
].map((p) => Object.freeze(p)));

/** W1-driving Task 13: the gallery composes each card's testid from its
 *  template's key (template-gallery.tsx:242) — pinned as that composition,
 *  verbatim; templateCardTestid fills it. */
export const TEMPLATE_CARD: Readonly<Pin> = Object.freeze({ file: `${V2}/template-gallery.tsx`, needle: "data-testid={`template-card-${template.key}`}" });

/** The card testid for a catalog template's key. The prefix is read out of
 *  TEMPLATE_CARD's needle (never retyped), and the key must name a catalog
 *  template (templateField refuses an unknown or unsafe one by name), so no
 *  page object waits on a card the gallery never renders. */
export function templateCardTestid(key: string): string {
  templateField(key);
  const prefix = /`([\w-]+)\$\{template\.key\}`/.exec(TEMPLATE_CARD.needle)?.[1];
  if (prefix === undefined) throw new Error(`selectors: cannot read the card prefix out of ${TEMPLATE_CARD.needle}`);
  return `${prefix}${key}`;
}

export const NAME = names({
  // Hardcoded English in the product (scout C; no dictionary key to pin): the
  // quoted literal is the submit button's, not the section heading's text node.
  addEntrant: { text: "Add entrant", file: `${V2}/entrants-panel.tsx`, needle: '"Add entrant"' },
  withdrawConfirm: { text: "Withdraw entrant", dictKey: "confirm.withdrawEntrant.label", file: `${V2}/entrants-panel.tsx` },
  sportSelect: { text: "Sport", dictKey: "wizard.sport", file: `${V2}/division-builder.tsx` },
  variantSelect: { text: "Variant", dictKey: "wizard.variant", file: `${V2}/division-builder.tsx` },
  formatTab: { text: "Format", dictKey: "wizard.tab.format", file: `${V2}/division-builder.tsx` },
  // The field's accessible name is "Ends on *" — the required star is the
  // component's, not the dictionary's (review M-4).
  endsOn: decorated("comp.wizard.endsOn", `${V2}/competition-wizard.tsx`, "`${msg(\"comp.wizard.endsOn\")} *`"),
  // "Create competition", not the brief's "Create" (re-pinned at Step 0; "Create" is clubs.list.create).
  createCompetition: { text: "Create competition", dictKey: "comp.wizard.create", file: `${V2}/competition-wizard.tsx` },
  // Two more for Task 5's createCompetitionUi (its brief asks for them here).
  competitionNamePlaceholder: { text: "Summer Championship 2026", dictKey: "comp.wizard.name.placeholder", file: `${V2}/competition-wizard.tsx` },
  // The unlisted option renders as "Link only" (visibility-picker.tsx OPTIONS).
  visibilityUnlisted: { text: "Link only", dictKey: "visibility.unlisted.label", file: "apps/web/src/components/ui/visibility-picker.tsx" },
  // Task 5. The add-entrant form's two field labels are hardcoded English
  // (entrants-panel.tsx NewEntrantFields) — a concern routed, not fixed here.
  entrantName: hardcoded(`${V2}/entrants-panel.tsx`, '<span className="label">Name</span>'),
  entrantSeed: hardcoded(`${V2}/entrants-panel.tsx`, '<span className="label">Seed</span>'),
  // The organiser standings tab's no-table note (d/[divSlug]/page.tsx), and the
  // public page's champion banner label (public dictionary).
  standingsEmpty: dictionary("div.detail.standings.empty", ORG_DIVISION_PAGE),
  // W1-driving Task 13: the template detail sheet's two fields (template-gallery.tsx:437-462).
  // Its Ends on is decorated exactly as the blank wizard's.
  templateName: dictionary("comp.wizard.name.label", `${V2}/template-gallery.tsx`),
  templateEndsOn: decorated("comp.wizard.endsOn", `${V2}/template-gallery.tsx`, "`${msg(\"comp.wizard.endsOn\")} *`"),
  championLabel: dictionary("table.champion", PUBLIC_DIVISION_PAGE, "public"),
  // W1d Task 14 (item 15e): the console's "Void last entry" has no testid; its accessible name is the dictionary's
  // value (fixture-console.tsx renders msg("score.voidLast") inside the button, which also carries a title naming
  // the entry it would void, score.voidLastTitle).
  voidLast: dictionary("score.voidLast", `${V2}/fixture-console.tsx`),
});

export const DATA = data({
  scorebugHalf: { selector: '[data-role="v3-scorebug-half"]', file: `${V2}/scorepad/v3/scorebug.tsx`, needle: 'data-role="v3-scorebug-half"' },
  tile: { selector: "[data-tile-id]", file: `${V2}/scorepad/v3/tile-grid.tsx`, needle: "data-tile-id={" },
  choiceOption: { selector: "[data-choice-option-id]", file: `${V2}/scorepad/v3/guided-sheet.tsx`, needle: "data-choice-option-id={" },
  rowAction: { selector: "[data-row-action]", file: `${V2}/desk/run-sheet-row.tsx`, needle: "data-row-action={action.kind}" },
  fixtureRow: { selector: "li[data-fixture-no]", file: `${V2}/desk/run-sheet-row.tsx`, needle: "<li data-fixture-no={" },
  // Task 5.
  templateRadio: { selector: '[name="template"]', file: `${V2}/division-builder.tsx`, needle: 'name="template"' },
  entrantKind: { selector: "[data-kind]", file: `${V2}/entrants-panel.tsx`, needle: "data-kind={k}" },
  entrantStatus: { selector: "[data-entrant-status]", file: `${V2}/entrants-panel.tsx`, needle: "data-entrant-status={entrant.status}" },
  runSheetFilterOption: { selector: "[data-filter]", file: `${V2}/desk/run-sheet.tsx`, needle: "data-filter={f.value}" },
  standingsRegion: { selector: '[role="region"]', file: STANDINGS_TABLE, needle: 'role="region"' },
  standingsRowHeader: { selector: '[scope="row"]', file: STANDINGS_TABLE, needle: 'scope="row"' },
  standingsRowName: { selector: "[title]", file: STANDINGS_TABLE, needle: "title={entrantNames[row.entrantId] ?? row.entrantId}" },
  // W1-driving Task 13: the sheet's form, which scopes its fields (the CTA in
  // the modal footer submits it by `form="template-detail-form"`).
  templateDetailForm: { selector: 'form[id="template-detail-form"]', file: `${V2}/template-gallery.tsx`, needle: '<form id="template-detail-form"' },
});

export class MissingLabel extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`selectors: the en dictionary has no label ${key} — the builder would render the raw key, and the page object would click nothing`);
    this.name = "MissingLabel";
    this.key = key;
  }
}

export class UnrenderableName extends Error {
  readonly key: string;
  readonly rendered: string;
  constructor(key: string, rendered: string) {
    super(`selectors: cannot derive the name for ${key} from ${rendered} — it must be a template literal with exactly one \${msg("${key}")} and no other interpolation`);
    this.name = "UnrenderableName";
    this.key = key;
    this.rendered = rendered;
  }
}

export class UnreadableLiteral extends Error {
  readonly needle: string;
  constructor(needle: string) {
    super(`selectors: cannot read a label out of ${needle} — a hardcoded name's needle must be one quoted string or one element's text`);
    this.name = "UnreadableLiteral";
    this.needle = needle;
  }
}

/** apps/web/src/dictionaries/en/<dict>.json, each read once, as text. */
const enDicts = new Map<Dictionary, Readonly<Record<string, unknown>>>();
function en(dict: Dictionary): Readonly<Record<string, unknown>> {
  let d = enDicts.get(dict);
  if (d === undefined) {
    d = JSON.parse(readFileSync(new URL(`../../../../apps/web/src/dictionaries/en/${dict}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    enDicts.set(dict, d);
  }
  return d;
}
function enLabel(key: string, dict: Dictionary = "ui"): string {
  const v = en(dict)[key];
  if (typeof v !== "string" || v === "") throw new MissingLabel(key);
  return v;
}

/** The label a hardcoded needle carries: the whole of a quoted string
 *  (`"Add entrant"`), or the text of one element (`<span …>Seed</span>`).
 *  Refuses anything else rather than guess which words are the name. */
export function literalText(needle: string): string {
  const text = /^"([^"]+)"$/.exec(needle)?.[1] ?? /^<(\w+)[^<>]*>([^<>{}]+)<\/\1>$/.exec(needle)?.[2];
  if (text === undefined || text.trim() !== text) throw new UnreadableLiteral(needle);
  return text;
}

/** The builder's label for a template row (division-builder.tsx renders
 *  `format.template.<row>.label`), from the en dictionary. */
export function templateLabel(row: TemplateRowKey): string {
  return enLabel(`format.template.${row}.label`);
}

/** The name the product renders from `rendered` — its template literal,
 *  verbatim — with the en value of `dictKey` in place of its one
 *  `${msg("<dictKey>")}`. Refuses what it cannot fill: not a template literal,
 *  not exactly one such call, or another interpolation left over. */
export function renderedName(dictKey: string, rendered: string): string {
  const call = "${msg(\"" + dictKey + "\")}";
  const body = /^`([^`]*)`$/.exec(rendered)?.[1];
  const parts = body?.split(call);
  if (parts === undefined || parts.length !== 2 || parts.join("").includes("${")) throw new UnrenderableName(dictKey, rendered);
  return `${parts[0]}${enLabel(dictKey)}${parts[1]}`;
}
