// A pool's display label — ONE authority for every surface that names a pool:
// the public division page, the embed, the competition hub, the poster's draw,
// both slideshows and the organiser console.
//
// Never `pools.name`. The generator stores it once, as the English
// "Pool " + key (`server/usecases/stages/`), and nothing renames it, so
// printing it put English in front of every Spanish, French and Dutch reader
// (2026-10-06). The label is rebuilt from the pool's KEY through the reader's
// own `public` dictionary instead: "Group A", "Grupo A", "Poule A". The stored
// name is left as it is — this is display only.
//
// Pure (no `server-only`): the dictionary is passed in, already chosen by the
// caller for its audience (the org's locale on an ISR public page, the
// viewer's on the console).
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { comparePools, type PoolOrderRef } from "@/lib/pool-order";

/** One pool's label in `dict`'s locale, from its key. A missing or empty key
 *  is the bare pool word (`table.pool`) — never "Pool " with nothing after it,
 *  and never the literal "undefined" interpolation would otherwise print. */
export function poolLabel(dict: Dict, key: string | null | undefined): string {
  return key ? t(dict, "table.poolLabel", { key }) : t(dict, "table.pool");
}

/** A division's pools in display order (`comparePools`: key, then name, then id), each with its label in `dict`'s locale. What the
 *  fixtures tab hands the stage cards so a round's bar can say which pool it is for - the two authorities above, composed once. */
export function poolLabelsInOrder(dict: Dict, pools: readonly PoolOrderRef[]): { id: string; label: string }[] {
  return [...pools].sort(comparePools).map((p) => ({ id: p.id, label: poolLabel(dict, p.key) }));
}
