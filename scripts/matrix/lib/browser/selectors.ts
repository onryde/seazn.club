// Every selector and label the browser layer uses, each pinned to the product
// file it must appear in. selectors.test.ts reads those files — and the en
// dictionary — as TEXT; nothing is imported from apps/web (R3). A product
// rename reds the pin test by name instead of timing out mid-run.
import { readFileSync } from "node:fs";
import type { TemplateRowKey } from "../catalogue.ts";

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
export type NamePin = { readonly text: string } & ({ readonly dictKey: string; readonly file: string; readonly rendered?: string } | Pin);
/** An attribute selector with no testid (data-role, data-tile-id, …). */
export type DataPin = { readonly selector: string } & Pin;

/** Frozen, entries included, with the literal keys kept: `TESTID.typo` is a
 *  compile error, never a runtime `undefined`. */
function table<T extends Record<string, object>>(t: T): Readonly<T> {
  for (const v of Object.values(t)) Object.freeze(v);
  return Object.freeze(t);
}

const V2 = "apps/web/src/components/v2";
/** confirm-dialog.tsx derives both buttons from its `testId` prop. */
const CONFIRM_DIALOG: Pin = Object.freeze({ file: `${V2}/confirm-dialog.tsx`, needle: "`${testId}-confirm`" });

/** A dictionary label rendered inside the product's own template literal.
 *  Its name is DERIVED on read — the en value put through `rendered` — never
 *  retyped, so a dictionary edit moves it. Read lazily, like templateLabel. */
function decorated(dictKey: string, file: string, rendered: string): { readonly text: string; readonly dictKey: string; readonly file: string; readonly rendered: string } {
  return { dictKey, file, rendered, get text(): string { return renderedName(dictKey, rendered); } };
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
});

export const DATA = data({
  scorebugHalf: { selector: '[data-role="v3-scorebug-half"]', file: `${V2}/scorepad/v3/scorebug.tsx`, needle: 'data-role="v3-scorebug-half"' },
  tile: { selector: "[data-tile-id]", file: `${V2}/scorepad/v3/tile-grid.tsx`, needle: "data-tile-id={" },
  choiceOption: { selector: "[data-choice-option-id]", file: `${V2}/scorepad/v3/guided-sheet.tsx`, needle: "data-choice-option-id={" },
  rowAction: { selector: "[data-row-action]", file: `${V2}/desk/run-sheet-row.tsx`, needle: "data-row-action={action.kind}" },
  fixtureRow: { selector: "li[data-fixture-no]", file: `${V2}/desk/run-sheet-row.tsx`, needle: "<li data-fixture-no={" },
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

/** apps/web/src/dictionaries/en/ui.json, read once, as text. */
let enUi: Readonly<Record<string, unknown>> | null = null;
function en(): Readonly<Record<string, unknown>> {
  enUi ??= JSON.parse(readFileSync(new URL("../../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8")) as Record<string, unknown>;
  return enUi;
}
function enLabel(key: string): string {
  const v = en()[key];
  if (typeof v !== "string" || v === "") throw new MissingLabel(key);
  return v;
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
