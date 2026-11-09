// Org branding blob helpers (v3/10 #5). The brand colour shares one jsonb column
// with whatever else the blob holds, so every write must merge, never replace.
// Pure + isomorphic so the merge is unit-tested. Sponsors are not in the blob
// (R4 fix batch 3): they live in the `sponsors` table only, and V492 strips the
// legacy `sponsors` key.

export interface OrgBranding {
  colors?: { primary?: string };
  [k: string]: unknown;
}

function asBranding(value: unknown): OrgBranding {
  return typeof value === "object" && value !== null ? { ...(value as OrgBranding) } : {};
}

/** Set/clear the brand color, keeping everything else in the blob. */
export function mergeBrandColor(existing: unknown, primary: string | null): OrgBranding {
  const next = asBranding(existing);
  if (primary === null) delete next.colors;
  else next.colors = { primary: primary.toLowerCase() };
  return next;
}
