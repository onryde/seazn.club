// A sport's name as the division builder's Sport picker prints it. The registry's own label for the catch-all sport is
// "Generic" (`sport.generic`), but the picker names that tile "Any other game" (`divBuilder.sport.generic`), and an
// organiser looking for it looks for that. Batch 5's posts and tables use the picker's word (fix round 1, M10); every
// other sport keeps `sportLabel`'s. Server-only, like `@/blog/labels`: nothing a page loads imports it.
import ui from "@/dictionaries/en/ui.json";
import { sportLabel } from "@/blog/labels";
import { CATCH_ALL_SPORT } from "@/lib/division-builder/model";

const UI = ui as Record<string, string>;

export function pickerSportName(key: string): string {
  if (key !== CATCH_ALL_SPORT) return sportLabel(key);
  const name = UI["divBuilder.sport.generic"];
  if (typeof name !== "string" || name.length === 0) throw new Error("blog label: the catch-all sport has no picker name (divBuilder.sport.generic)");
  return name;
}
