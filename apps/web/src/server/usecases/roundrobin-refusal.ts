import "server-only";
// W5 app PR A, Task 2: the one way the server raises a round-robin refusal. The status, the code and the English sentence come
// from the client-safe table (`lib/roundrobin-refusals.ts`), so a throw site names only the code; `details` rides on the error
// body as machine-readable hints, the way HttpError's `extra` does everywhere else. The `knockoutRefusal` pattern
// (knockout-refusal.ts): a sentence with a placeholder takes its value from `details` under the same name, and a placeholder
// `details` does not fill is a programming error, thrown by name, never a "{max}" sent to an organiser.
import { HttpError } from "@/lib/errors";
import { FORMAT_MAX_LATE_ENTRY, FORMAT_MAX_PROMOTION, ROUND_ROBIN_REFUSALS, type RoundRobinRefusalCode } from "@/lib/roundrobin-refusals";

export function roundRobinRefusal(code: RoundRobinRefusalCode, details?: Record<string, unknown>): HttpError {
  const { status, en } = ROUND_ROBIN_REFUSALS[code];
  const message = en.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = details?.[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`roundRobinRefusal ${code}: its sentence needs details.${name}`);
    }
    return String(value);
  });
  return new HttpError(status, message, code, details);
}

/** B4 review m-8: an organiser's promotion refused at the format's max. The draw doors' code, status and fields, in the promotion's
 *  own sentence (`FORMAT_MAX_PROMOTION`) - the draw sentence read "up to 100 entrants. This division has 100." at the max itself. */
export function formatMaxPromotionRefusal(max: number, active: number): HttpError {
  const { status } = ROUND_ROBIN_REFUSALS.FORMAT_TOO_MANY_ENTRANTS;
  const message = FORMAT_MAX_PROMOTION.en.replace("{max}", String(max)).replace("{entrants}", String(active));
  return new HttpError(status, message, "FORMAT_TOO_MANY_ENTRANTS", { max, entrants: active });
}

/** B4 re-review N-3: a late add into a running table refused at the format's max, in the late add's own sentence
 *  (`FORMAT_MAX_LATE_ENTRY`): `entrants` is the field the add would make. The draw doors' code, status and fields. */
export function formatMaxLateEntryRefusal(max: number, entrants: number): HttpError {
  const { status } = ROUND_ROBIN_REFUSALS.FORMAT_TOO_MANY_ENTRANTS;
  const message = FORMAT_MAX_LATE_ENTRY.en.replace("{max}", String(max)).replace("{entrants}", String(entrants));
  return new HttpError(status, message, "FORMAT_TOO_MANY_ENTRANTS", { max, entrants });
}
