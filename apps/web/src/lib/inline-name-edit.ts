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

/** Does this keydown commit the field? Enter does, except while an input
 *  method is composing (Japanese, Chinese or Korean input): there Enter picks
 *  the candidate, and committing then would save half-typed text. */
export function nameFieldEnterCommits(key: string, isComposing: boolean): boolean {
  return key === "Enter" && !isComposing;
}

/** Does this keydown abandon the edit? Escape does, except while an input
 *  method is composing: there Escape drops the candidate being composed, and
 *  the typing around it stays. */
export function nameFieldEscapeCancels(key: string, isComposing: boolean): boolean {
  return key === "Escape" && !isComposing;
}
