// Decoder for the `platform_settings.platform_fee_percent` jsonb value.
//
// Deliberately its own module, with ZERO imports: `lib/platform-settings.ts`
// is `server-only` and pulls in the db and Redis clients, and the Playwright
// fixture (`e2e/helpers.ts`) needs this same decision without any of that in
// its runtime. One authority for the rule, two callers.

/**
 * Read a `platform_settings` jsonb value as a fee percent, or `null` when the
 * row cannot be read as one (absent, wrong type, or out of the 0..100 band).
 *
 * `Number()` is NOT a decoder here, and that is the whole point. The column is
 * jsonb and postgres.js hands back whatever JSON says — `null` for a jsonb
 * `null` row, a string or boolean for a hand-written one — and `Number(null)`,
 * `Number("")`, `Number(false)` and `Number([])` are each a *finite* `0`. A
 * bare `Number(value)` therefore reads a valueless row as a perfectly good
 * 0% platform cut, which is in range, passes every bounds check, and silently
 * OVERRIDES the PLATFORM_FEE_PERCENT/5 fallback that an absent row correctly
 * falls through to. The platform's entire cut on entry fees, zeroed by a row
 * that says nothing.
 *
 * Only a JSON number is a fee. A numeric STRING is rejected on purpose: the
 * seed writes `'5'::jsonb` and `setPlatformFeeDefault` writes `sql.json(pct)`,
 * so every legitimate writer produces a JSON number. A string in that column
 * is a hand-edit, and guessing at a hand-edit's intent is how a typo becomes
 * a billing rate.
 */
export function decodeFeePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 100 ? value : null;
}
