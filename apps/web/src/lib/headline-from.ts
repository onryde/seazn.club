/**
 * A stored result headline (`ScoreSummary.headline`) reads HOME first, in one shape across the sport registry:
 * `<home> — <away>`, optionally followed by ` · <detail>`, whose `a–b` pairs (set or game scores) are home–away too:
 * "3 — 0", "213/9 (20) — 140/9 (20)", "1 — 2 · 12–25, 12–25, 26–24", "2 — 1 · 6–3 6–7(3) 7–6(5)".
 *
 * A surface that names one side first (/me names the player's own side first) must read the score from that side too,
 * or a walkover the player won reads "Pat vs Ravens 0 — 2". From `"home"` the headline is returned unchanged. From
 * `"away"` the two heads swap and every `a–b` pair in the detail turns ("6–7(3)" becomes "7–6(3)"; tennis notation
 * keeps the tiebreak loser's points in brackets either way). A headline in any other shape answers null: it is never
 * guessed at, and the caller keeps the stored (home-first) order for that row's names instead.
 */
export function headlineFrom(headline: string, side: "home" | "away"): string | null {
  if (side === "home") return headline;
  const at = headline.indexOf(" · ");
  const head = at === -1 ? headline : headline.slice(0, at);
  const detail = at === -1 ? "" : headline.slice(at);
  const heads = head.split(" — ");
  if (heads.length !== 2) return null;
  return `${heads[1]} — ${heads[0]}${detail.replace(/(\d+)–(\d+)/g, "$2–$1")}`;
}
