import "server-only";
// W4 app-A: the one way the server raises a knockout refusal. The status, the code and the English sentence come from
// the client-safe table (`lib/knockout-refusals.ts`), so a throw site names only the code; `details` rides on the error
// body as machine-readable hints, the way HttpError's `extra` does everywhere else (`api-v1/http.ts` merges it into the
// envelope). The `swissRefusal` pattern (swiss-refusal.ts).
//
// W4 T9: a sentence with a placeholder (`{stage}`) takes its value from `details` under the same name — the one place the
// client reads it too, rendering the row's key with the envelope's fields. A placeholder `details` does not fill is a
// programming error, thrown by name, never a "{stage}" sent to an organiser.
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS, type KnockoutRefusalCode } from "@/lib/knockout-refusals";

export function knockoutRefusal(code: KnockoutRefusalCode, details?: Record<string, unknown>): HttpError {
  const { status, en } = KNOCKOUT_REFUSALS[code];
  const message = en.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = details?.[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`knockoutRefusal ${code}: its sentence needs details.${name}`);
    }
    return String(value);
  });
  return new HttpError(status, message, code, details);
}
