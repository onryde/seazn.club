// The shape of one curated match-rule field. Split out of `lib/match-rules.ts`
// so every per-sport file can import it without importing the registry
// (`./index`). Client-safe like the rest of this directory: no "use client", no
// JSX, no `@/components` or `@/server` import. The one `@/` import is a TYPE (`MessageKey`), which is erased: nothing
// loads at runtime, so tools/matrix still loads this directory under plain `node --experimental-strip-types`.
import type { MessageKey } from "@/lib/messages";

/** One choice of a `select` field. `labelKey` localizes `label` exactly as `RuleField.labelKey` does the field's. */
export interface RuleFieldOption {
  value: string;
  label: string;
  labelKey?: MessageKey;
}

export interface RuleField {
  key: string;
  /** The English text. Canonical English like every rule label (design 2026-09-17), and the FALLBACK of `labelKey`. */
  label: string;
  /**
   * W2e Task 28 (owner D5, ruling 157): the dictionary key that localizes `label`, in all four locales. A field that
   * names one is drawn from the dictionary (`RuleFieldControl`); one that does not keeps its English `label`, as every
   * field did before D5. The English dictionary value and `label` are the same sentence (pinned in `w2e-fields.test.ts`),
   * so the fallback and the localized text cannot drift.
   */
  labelKey?: MessageKey;
  help?: string;
  /** `help`'s dictionary key, as `labelKey` is `label`'s. */
  helpKey?: MessageKey;
  /**
   * W2c X-SR-1 — the engine `ruleKeys` entries this field edits, as declared cfg paths ("overtime.minutes", "set").
   * REQUIRED, so the compiler lists every field that has not named its key. `lib/rule-scope.ts` sorts fields into the
   * stage, match and points forms by the SCOPE the engine gives these keys, and each sport's contract test
   * (`match-rules/__tests__/<sport>.contract.test.ts`) checks them against that declaration. Several fields may edit
   * one key (ice hockey's overtime on/off and its skaters both edit `overtime`); one field may name several.
   */
  edits: readonly string[];
  /** number input, or a Default/On/Off select for booleans, or an option list, or an ORDERED list of options (value =
   *  the chosen option values, comma-joined, in order; blank = the engine's own default order). */
  kind: "number" | "bool" | "select" | "sequence";
  min?: number;
  max?: number;
  options?: RuleFieldOption[];
  /**
   * Saved values this select SHOWS as themselves but never OFFERS (tennis's Fast4 as it was played before W2e). Their labels
   * are found by `ruleOptionLabel`, so the open dropdown and the stage card's summary line read the same words; they are not
   * in `options`, which the picker, the contract harness and the matrix enumerate as the choices an organiser has.
   */
  legacyOptions?: readonly RuleFieldOption[];
  /**
   * A `sequence` field only (W2c Task 17): the raw value that stands for the EMPTY list. A blank raw value means "unset"
   * everywhere in the editor, so a list the organiser has emptied on purpose ("no tie-break games": a drawn game is held
   * for the organiser) needs a token of its own, and the control that edits the list has to be able to write it. Absent
   * on a field whose empty list means nothing.
   */
  emptyValue?: string;
  /**
   * Maps the entered value onto the override object (top-level key).
   * `values` is the full raw form snapshot for this sport — read a sibling
   * key from it when one field must assemble a nested object that several
   * rendered inputs jointly describe (e.g. a clock or an overtime block).
   * A field that only renders its own input and contributes nothing on its
   * own returns {} unconditionally.
   *
   * `inherited` (W2e Task 8c, owner D19) is the config the value falls back to - the one every caller of this directory
   * already threads for the best-of-1 fold: the division's saved config for a stage fragment or the Settings tab, the
   * stage's resolved cfg for a match, the variant's preset for the builder. A field whose number is a SCALED one reads the
   * scale from it (cricket's overs count in `inherited.ballsPerOver`, five on The Hundred), and declares which keys in
   * `context`. Absent: the field's own default, exactly as before the argument existed.
   */
  build: (value: string, values: Record<string, string>, inherited?: Record<string, unknown>) => Record<string, unknown>;
  /**
   * The cfg keys, beyond `edits`, that `build` and `read` convert by, taken from `inherited` (cricket's `overs`:
   * `ballsPerOver`). Declared so a caller that knows only a variant's preset (the division builder) can hand over exactly
   * those keys - `ruleContextFor` - and not the whole preset, which would change what the builder shows as a default or
   * a best-of.
   */
  context?: readonly string[];
  /**
   * What to emit when THIS field's own raw value is BLANK. Most fields have
   * no opinion when blank — a blank `halfMinutes` leaves whatever's already
   * saved untouched (no `buildOnBlank`, nothing merged, exactly the
   * pre-R3.5-review behaviour). A field whose blank state must ACTIVELY
   * delete a previously-saved key (R3.5 review F5: football's shoot-out points
   * pair, retired in W2d) implements this instead. Return `undefined` for a key here — never just
   * omit it — to signal "delete": division-settings.tsx's applyFormat
   * merges this return value on top of the division's existing saved
   * `points`, so omitting a key would leave that stale value in place, not
   * remove it. applyFormat resolves the `undefined` markers into a real
   * deletion before the PATCH goes out.
   */
  buildOnBlank?: (values: Record<string, string>) => Record<string, unknown>;
  /**
   * Inverse of `build`: given a saved config, return this field's current raw
   * value (what the input should show on reopen), or `undefined` if there is
   * nothing to show. Optional — a field with no `read` always reopens blank,
   * same as every field did before R3.5/Task Q.
   *
   * Report ONLY what the config actually carries; NEVER fall back to a
   * default. `hydrateRuleValues` is also fed a stage's rules FRAGMENT, where a
   * key's absence is meaningful — it means "inherit the division" — so a
   * defaulting `read` would make every field look overridden and the
   * organiser's first save would pin the whole division format onto the stage.
   *
   * Implemented for the two fields the original bug was reported against
   * (football's shoot-out points pair, retired in W2d) and for the nine sets-based keys the per-stage
   * override covers (bestOf, setTo, finalSetTo, cap, winBy, and tennis's
   * setType/finalSet/noAd/tiebreakWinBy). The rest stay unimplemented, and
   * that is not a regression: a `build` that writes a DIFFERENT key than
   * `field.key`, derives a scaled number, or picks among several literal
   * shapes needs an inverse as bespoke as itself, field by field.
   *
   * `inherited` is `build`'s: the config the value falls back to. A scaled number (cricket's overs) needs the scale of
   * the config it is read against, and a stage's FRAGMENT does not carry it - the division's does. It supplies the SCALE
   * only: a value the fragment does not carry still reads blank.
   */
  read?: (config: Record<string, unknown>, inherited?: Record<string, unknown>) => string | undefined;
}
