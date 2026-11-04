// W3 app-B T3 (owner Q2, 2026-11-03) - the marks beside a Swiss row's name: a pairing bye ("Bye R3") and a late join ("From R3",
// the rounds before it counting as unplayed). ONE component for both standings tables - the division page / embed / console
// (`standings-table.tsx`) and the hub (`standings-table-view.tsx`) - so the two cannot mark the same row differently; the words
// are already resolved by `rowMarkers` (server/public-site/standings-view.ts), so this holds no vocabulary and no locale, and
// is safe in the hub's client component.
//
// House look, no new language: the same small neutral chip the table's "Withdrawn" mark already is (`DEPARTED_STATUS_CHIPS`).
// It sits on a line of its own UNDER the name rather than beside it: the name column is the one that crushes at 320 (the hub's
// `NAME_MIN_PHONE_PX` floor, the division page's `max-md:min-w-[7.5rem]`), and a chip beside it would take that width. A row
// with no mark renders nothing, so the unmarked table is byte-for-byte what it was.
//
// Accessible name: the chip's short text is `aria-hidden` and the sentence rides as `sr-only` text (a pointer also gets it as
// the `title`) - the same fold the column headers use. A phone has no hover, so the short text itself says what it is:
// "Bye R3" and "From R3" read without the title.
import type { RowMarkerT } from "@/server/public-site/competition-hub-schema";

export function StandingsRowMarkers({
  markers,
  testid,
  indented = false,
}: {
  markers: readonly RowMarkerT[] | undefined;
  /** `${testid}-bye` / `${testid}-late` - the caller's per-row prefix (the hub's is per table, so a division's overall table
   *  and a pool's table, which both hold an entrant, never emit one id twice). */
  testid: string;
  /** The row has a crest: line the chips up under the name, not under the crest (20px crest + 8px gap). */
  indented?: boolean;
}) {
  if (markers === undefined || markers.length === 0) return null;
  return (
    <span className={`mt-1 flex flex-wrap gap-1${indented ? " pl-7" : ""}`}>
      {markers.map((m) => (
        <span
          key={m.kind}
          data-marker={m.kind}
          data-testid={`${testid}-${m.kind}`}
          title={m.title}
          className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium leading-tight text-zinc-600"
        >
          <span aria-hidden="true">{m.text}</span>
          <span className="sr-only">{m.title}</span>
        </span>
      ))}
    </span>
  );
}
