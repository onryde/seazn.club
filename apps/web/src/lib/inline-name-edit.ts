// The rules a name edited IN PLACE follows, shared by the two places a console
// renames something where it is shown: an entrant's Name field
// (entrants-panel.tsx) and a player's ✎ in the directory (persons-panel.tsx).
//
// Pure and dependency-free, so the markup tests pin the rules directly.

/** What a blur on a name field saves: the trimmed name when it is a real
 *  change, or `null` — save nothing and put the name back — when the field was
 *  emptied (a name cannot be empty) or left as it was. */
export function nameFieldCommit(typed: string, current: string): string | null {
  const next = typed.trim();
  if (next === "" || next === current) return null;
  return next;
}

/** The `keyCode` a browser gives a keydown that an input method (Japanese,
 *  Chinese or Korean input) is handling — the "Process" key. */
export const IME_PROCESS_KEY_CODE = 229;

/** Is an input method handling this keydown? `isComposing` alone is not
 *  enough. Safari fires the Enter that COMMITS a composition after
 *  `compositionend`, so `isComposing` is already false, but the keydown still
 *  carries keyCode 229. Acting on that Enter would save the text a moment
 *  before the candidate the user just picked lands in it. */
function imeOwnsKey(isComposing: boolean, keyCode: number): boolean {
  return isComposing || keyCode === IME_PROCESS_KEY_CODE;
}

/** Does this keydown commit the field? Enter does, except while an input
 *  method owns the key (`imeOwnsKey`): there Enter picks the candidate, and
 *  committing then would save half-typed text. */
export function nameFieldEnterCommits(key: string, isComposing: boolean, keyCode: number): boolean {
  return key === "Enter" && !imeOwnsKey(isComposing, keyCode);
}

/** Does this keydown abandon the edit? Escape does, except while an input
 *  method owns the key: there Escape drops the candidate being composed, and
 *  the typing around it stays. */
export function nameFieldEscapeCancels(key: string, isComposing: boolean, keyCode: number): boolean {
  return key === "Escape" && !imeOwnsKey(isComposing, keyCode);
}
