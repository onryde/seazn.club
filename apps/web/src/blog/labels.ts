// The words an example prints, taken from the product's own English dictionaries so a post says what the
// organiser's screen says (design: "Words in example output are the product's own labels, never keys").
// A key with no label THROWS, naming it: an example never prints an engine key by falling back to it.
import pub from "@/dictionaries/en/public.json";
import ui from "@/dictionaries/en/ui.json";

const UI = ui as Record<string, string>;
const PUBLIC = pub as Record<string, string>;

function need(dict: Record<string, string>, id: string, what: string, key: string): string {
  const v = dict[id];
  if (typeof v !== "string" || v.length === 0) throw new Error(`blog label: no ${what} label for '${key}' (${id})`);
  return v;
}

/** A tie-break key's name on the organiser's screen: "points", "wins", "Buchholz Cut-1" (`div.detail.tiebreak.rule.<key>`). */
export function tiebreakLabel(key: string): string {
  return need(UI, `div.detail.tiebreak.rule.${key}`, "tie-break", key);
}

/** A result column's heading on the public table: "Won", "Drawn", "Lost", "Ties", "Points" (`table.col.<key>`). */
export function resultLabel(key: string): string {
  return need(PUBLIC, `table.col.${key}`, "result", key);
}

/** A sport's name as the product prints it: "Chess" for `boardgame`, "Table tennis" (`sport.<key>`). */
export function sportLabel(key: string): string {
  return need(UI, `sport.${key}`, "sport", key);
}
