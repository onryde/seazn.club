import "server-only";
// W5 app PR A, Task 2: the one way the server raises a round-robin refusal. The status, the code and the English sentence come
// from the client-safe table (`lib/roundrobin-refusals.ts`), so a throw site names only the code; `details` rides on the error
// body as machine-readable hints, the way HttpError's `extra` does everywhere else. The `knockoutRefusal` pattern
// (knockout-refusal.ts): a sentence with a placeholder takes its value from `details` under the same name, and a placeholder
// `details` does not fill is a programming error, thrown by name, never a "{max}" sent to an organiser.
import { HttpError } from "@/lib/errors";
import { ROUND_ROBIN_REFUSALS, type RoundRobinRefusalCode } from "@/lib/roundrobin-refusals";

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
