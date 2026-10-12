// The match room's translator type and the small copy helpers its pieces
// share. Every room component takes `t` as a prop (the shell binds `useT`),
// so each renders bare in a node test without a DictProvider.
import type { TKey } from "@/lib/i18n-runtime";

export type RoomT = (key: TKey, vars?: Record<string, string | number>) => string;
export type RoomPlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** The canvas addresses the opponent by first name in running copy ("Ada ·
 *  on camera", "Ada offers a draw") and by full name where it names them
 *  (the clocks strip, the check-in line). A one-word name is used whole. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : name;
}

/** The header's compact time control, "10+5" (Lichess's own notation). */
export function compactClock(limitSeconds: number, incrementSeconds: number): string {
  const minutes = limitSeconds / 60;
  const m = Number.isInteger(minutes) ? String(minutes) : String(Math.round(minutes * 100) / 100);
  return `${m}+${incrementSeconds}`;
}

/** The check-in's spelled-out time control, "10 minutes + 5 seconds"; a
 *  limit that is not whole minutes is spelled in seconds; no increment, no
 *  "+ 0 seconds". */
export function spokenClock(limitSeconds: number, incrementSeconds: number, plural: RoomPlural): string {
  const limit =
    limitSeconds % 60 === 0
      ? plural("externalPlay.room.minutes", limitSeconds / 60)
      : plural("externalPlay.room.seconds", limitSeconds);
  return incrementSeconds > 0 ? `${limit} + ${plural("externalPlay.room.seconds", incrementSeconds)}` : limit;
}
