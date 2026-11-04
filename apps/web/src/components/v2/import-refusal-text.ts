// UI5 fix round 1 (controller ruling Q3): the CSV import's one-team refusal (409 PERSON_ON_OTHER_TEAM) in the organiser's
// language. The commit is refused whole and the payload names the FILE ROWS (`extra.rows`, the numbers the preview's issue
// list calls "Row n"), as the import's Lichess refusal does (`lichessImportRefusalText`); the server's sentence is English
// only, so the wizard never shows it for this code.

export interface ImportRefusalDeps {
  /** Joins labels the way the locale writes a list ("2, 3 and 5"). */
  list: (labels: string[]) => string;
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
  text: (key: string) => string;
}

/** The refusal's text: `import.personOnOtherTeam.one` / `.other` naming the rows, `.unnamed` when the payload names none.
 *  Null when `err` is not PERSON_ON_OTHER_TEAM (the caller keeps its own handling). */
export function importPersonOnOtherTeamText(err: { code?: string; extra?: Record<string, unknown> }, deps: ImportRefusalDeps): string | null {
  if (err.code !== "PERSON_ON_OTHER_TEAM") return null;
  const rows = Array.isArray(err.extra?.rows) ? err.extra.rows.filter((n): n is number => Number.isInteger(n)) : [];
  return rows.length > 0
    ? deps.plural("import.personOnOtherTeam", rows.length, { rows: deps.list(rows.map(String)) })
    : deps.text("import.personOnOtherTeam.unnamed");
}
