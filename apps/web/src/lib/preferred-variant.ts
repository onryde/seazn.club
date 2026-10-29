// The variant a NEW division of each sport is offered first: the builder preselects it and the /start funnel creates it.
// ONE table and ONE pick, so the two creation paths cannot disagree (W2e D1/D2: badminton is 3x15 from the day W2e ships).
//
// Client-safe and import-free on purpose: the builder (a client component) and the funnel (server) both read it, and
// tools/matrix pins this literal against its own `BUILDER_PREFERRED_VARIANT` (catalogue.test.ts parses the text below, so
// keep it a plain object literal of `key: "value"` entries - no computed key, no spread).

// The most common variant to preselect per sport (else the first listed).
export const PREFERRED_VARIANT: Record<string, string> = {
  cricket: "t20",
  tennis: "tour",
  icehockey: "iihf",
  hockey: "fih-outdoor",
  badminton: "bwf-3x15",
};

/** The variant a new division of `sportKey` starts on: the sport's preferred one when it is offered, else the first listed
 *  (`""` for a sport with none). `Object.hasOwn`: a sport key such as `constructor` is not a table entry. */
export function pickVariant(sportKey: string, variants: readonly { key: string }[]): string {
  const lower = sportKey.toLowerCase();
  const pref = Object.hasOwn(PREFERRED_VARIANT, lower) ? PREFERRED_VARIANT[lower] : undefined;
  if (pref && variants.some((v) => v.key === pref)) return pref;
  return variants[0]?.key ?? "";
}
