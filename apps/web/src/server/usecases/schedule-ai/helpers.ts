import "server-only";
// Pure helpers the schedule-ai modules share: the zoned-ISO formatter, the
// string comparator every deterministic sort uses, and ISO -> epoch ms.

export const MS_PER_MIN = 60_000;

// ---------------------------------------------------------------------------
// Timezone-aware ISO (design/v4/01 §2: "ISO-8601 with a UTC offset, in the
// division timezone"). Same offset-probing trick as device-links.ts.
// ---------------------------------------------------------------------------

/** Offset (minutes east of UTC) of `tz` at `instant`. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second),
    );
    return Math.round((asUtc - instant.getTime()) / MS_PER_MIN);
  } catch {
    return 0;
  }
}

/** An instant formatted `YYYY-MM-DDTHH:mm:ss±HH:mm` in the division timezone.
 *  Exported so the Phase B officials pack (officials-ai.ts) formats times the
 *  same way — one zoned-ISO helper, not two. */
export function zonedIso(value: string | number | Date, tz: string): string {
  const d = value instanceof Date ? value : new Date(value);
  const off = tzOffsetMinutes(d, tz);
  const local = new Date(d.getTime() + off * MS_PER_MIN);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const toMs = (iso: string): number => new Date(iso).getTime();
