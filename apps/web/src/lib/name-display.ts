// Youth privacy (v3/11 gap 8): per-division public name rendering. The DB
// stores full names (organiser-side lists and exports are untouched); public
// surfaces — dashboards, /r/[ref], slideshow, OG images — mask through here.

export type NameDisplay = "full" | "first_initial";

/** NULL column resolves at read time: youth defaults to first_initial. */
export function resolveNameDisplay(
  setting: string | null | undefined,
  youth: boolean,
): NameDisplay {
  if (setting === "full" || setting === "first_initial") return setting;
  return youth ? "first_initial" : "full";
}

function maskOne(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/**
 * "Arun Kumar" → "Arun K." (first_initial). Pair display names joined with
 * "&" or "/" mask each side. Full mode is the identity.
 */
export function maskDisplayName(name: string, mode: NameDisplay): string {
  if (mode === "full") return name;
  return name
    .split(/\s*([&/])\s*/)
    .map((part) => (part === "&" || part === "/" ? ` ${part} ` : maskOne(part)))
    .join("")
    .trim();
}

/**
 * RS008 — the single display-name resolver for every public surface that
 * prints a PERSON's name (as opposed to a team's own declared name, which
 * carries no personal consent and is never routed through this function —
 * every call site special-cases `kind === "team"` before reaching here,
 * matching the existing `public.ts`/`public_entrants_v` precedent).
 *
 * Two independent axes, stricter wins:
 *  - the DIVISION's own youth/player_name_display policy (unchanged,
 *    `resolveNameDisplay` above — this is the pre-existing safeguarding
 *    control, and it alone already protects minors regardless of consent:
 *    `_INDEX.md` #21);
 *  - the PERSON's own `consent.public_name` opt-out (RS007 default: newly
 *    created persons get `public_name: true` — "registering is consent to a
 *    public name; opt-out happens later, on the person, never here", owner
 *    ruling 5). Only an EXPLICIT `false` masks — `consent` being `null`,
 *    `undefined`, or `{}` (no opt-out recorded, e.g. a captain-entered row
 *    with no linked person yet) must never be treated as an opt-out, or
 *    every not-yet-claimed roster row would wrongly mask by default.
 *
 * Delegates the actual masking to `maskDisplayName` (this file's existing,
 * grapheme-naive `.split(/\s+/)` convention) — a pair's "Arun Kumar & Dev
 * Patel" still masks each side correctly, since that split already runs
 * inside `maskDisplayName` regardless of which axis triggered it. Reuses the
 * SAME "Arun K." first-name + last-initial convention throughout; the
 * separate SQL-side `public_person_name()` function (its own "J.S."
 * initials-only convention, used by discipline.ts/player-stats.ts) is a
 * distinct, already-correct surface this resolver does not touch.
 *
 * Known, pre-existing, out-of-scope limitation inherited from `maskOne`
 * (unchanged by this function): the "last name initial" is taken from the
 * first UTF-16 code unit of the last whitespace-separated part
 * (`parts[...]![0]`), not a grapheme cluster — a surrogate-pair or
 * combining-mark last name could initialise on half a character. Not fixed
 * here: `maskOne` is shared, pre-existing, and out of this task's stated
 * scope.
 */
export function resolvePersonDisplayName(
  fullName: string,
  consent: { public_name?: boolean } | null | undefined,
  divisionSetting: string | null | undefined,
  youth: boolean,
): string {
  const optedOut = consent?.public_name === false;
  if (!optedOut && resolveNameDisplay(divisionSetting, youth) === "full") return fullName;
  return maskDisplayName(fullName, "first_initial");
}

/**
 * RS008 — "stricter wins" applied ACROSS several people who share ONE
 * display_name string (a pair's compound "Alice & Bob", a team roster is
 * never checked at all — team names carry no personal consent). A single
 * explicit opt-out among them is enough to mask the whole string; nobody
 * having opted out (true, absent, `null`, or `{}` for every one of them)
 * never does. Callers with a per-person breakdown available (one row per
 * person, e.g. `entry-card.tsx`'s own roster list) mask each row directly
 * through `resolvePersonDisplayName` instead — this helper exists only for
 * the coarser, single-string sites (`publicRegistrationStatusByRef`,
 * `buildAdmitTicketsDoc`, the slideshow) that have no separate per-person
 * rendering to fall back on.
 */
export function anyOptedOut(consents: ({ public_name?: boolean } | null | undefined)[]): boolean {
  return consents.some((c) => c?.public_name === false);
}
