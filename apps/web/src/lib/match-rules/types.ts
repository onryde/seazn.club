// The shape of one curated match-rule field. Split out of `lib/match-rules.ts`
// so every per-sport file can import it without importing the registry
// (`./index`). Client-safe like the rest of this directory: no "use client", no
// JSX, no `@/components` or `@/server` import.

export interface RuleField {
  key: string;
  label: string;
  help?: string;
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
  options?: { value: string; label: string }[];
  /**
   * Maps the entered value onto the override object (top-level key).
   * `values` is the full raw form snapshot for this sport — read a sibling
   * key from it when one field must assemble a nested object that several
   * rendered inputs jointly describe (e.g. a clock or an overtime block).
   * A field that only renders its own input and contributes nothing on its
   * own returns {} unconditionally.
   */
  build: (value: string, values: Record<string, string>) => Record<string, unknown>;
  /**
   * What to emit when THIS field's own raw value is BLANK. Most fields have
   * no opinion when blank — a blank `halfMinutes` leaves whatever's already
   * saved untouched (no `buildOnBlank`, nothing merged, exactly the
   * pre-R3.5-review behaviour). A field whose blank state must ACTIVELY
   * delete a previously-saved key (R3.5 review F5: shootoutWin/shootoutLoss)
   * implements this instead. Return `undefined` for a key here — never just
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
   * (shootoutWin/shootoutLoss) and for the nine sets-based keys the per-stage
   * override covers (bestOf, setTo, finalSetTo, cap, winBy, and tennis's
   * setType/finalSet/noAd/tiebreakWinBy). The rest stay unimplemented, and
   * that is not a regression: a `build` that writes a DIFFERENT key than
   * `field.key`, derives a scaled number, or picks among several literal
   * shapes needs an inverse as bespoke as itself, field by field.
   */
  read?: (config: Record<string, unknown>) => string | undefined;
}
