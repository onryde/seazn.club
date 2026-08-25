// Console route builders (PROMPT-30, v3/01 §2): slug hierarchy under /o —
// /o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[fixtureNo]. Every console
// <Link>/redirect() builds its href here, never by string concatenation
// (ESLint bans hardcoded console paths), so URL shapes change in one place.
// The URL — not the seazn_org cookie — is the source of truth for which org
// a page shows; multi-org tabs stay independent.

type Slug = string;

export const routes = {
  orgHome: (org: Slug) => `/o/${org}`,
  orgSettings: (org: Slug, tab?: string) =>
    tab ? `/o/${org}/settings?tab=${tab}` : `/o/${org}/settings`,
  billing: (org: Slug) => `/o/${org}/settings/billing`,
  /** AI-credit wallet home — its own Settings tab (moved off the billing page). */
  credits: (org: Slug) => `/o/${org}/settings/credits`,
  /** Purchasable add-ons — extra organisations today (SPEC-6 §A5, v17 gap
   *  #293). Plural so the seat and size-pack rows, which have no UI yet, can
   *  land here without a rename. `lib/feature-copy.ts`'s 402 offer names this
   *  route in prose as "Settings → Add-ons" in all four locales: renaming the
   *  path means rewriting that sentence too. */
  addOns: (org: Slug) => `/o/${org}/settings/add-ons`,
  /** Entry-fee collection: Stripe Connect + offline instructions (spec 2026-07-12).
   *  Renamed from /settings/payments (2026-07-18); the old path redirects. */
  connect: (org: Slug) => `/o/${org}/settings/connect`,
  competitionNew: (org: Slug) => `/o/${org}/c/new`,
  competition: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}`,
  competitionSettings: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/settings`,
  /** Event Pass purchase page — embedded one-time checkout (v3/07 §3). */
  competitionUpgrade: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/upgrade`,
  competitionSchedule: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/schedule`,
  /** Competition-level Registration hub (design §5) — replaces the
   *  division-level `divisionRegistrations` route RS001 deleted. Settings is
   *  the landing tab; `?tab=registrants` switches panels
   *  (registration/page.tsx's `resolveRegistrationHubTab`).
   *
   *  `divisionId` (RS005 R2) appends `&division_id=<uuid>` — the param
   *  `registration-list-query.ts`'s `parseRegistrationListQuery` and the
   *  hub's own `data.ts` (`parseRegistrantsQuery`) both read to pre-filter
   *  the Registrants table. It composes independently of `tab` (either can
   *  be given without the other) so every existing no-division-id call site
   *  keeps its exact prior output. This is the division page's own link
   *  into the hub, filtered to itself — design §5's obligation RS004
   *  deliberately deferred ("the filter lands with the real Registrants
   *  table"). */
  competitionRegistration: (org: Slug, comp: Slug, tab?: string, divisionId?: string) => {
    const params: string[] = [];
    if (tab) params.push(`tab=${tab}`);
    if (divisionId) params.push(`division_id=${divisionId}`);
    const base = `/o/${org}/c/${comp}/registration`;
    return params.length ? `${base}?${params.join("&")}` : base;
  },
  divisionNew: (org: Slug, comp: Slug) => `/o/${org}/c/${comp}/d/new`,
  division: (org: Slug, comp: Slug, div: Slug, tab?: string) =>
    tab ? `/o/${org}/c/${comp}/d/${div}?tab=${tab}` : `/o/${org}/c/${comp}/d/${div}`,
  divisionSchedule: (org: Slug, comp: Slug, div: Slug) =>
    `/o/${org}/c/${comp}/d/${div}/schedule`,
  /** Fixtures are addressed by per-division ordinal — human-quotable ("match 14"). */
  fixture: (org: Slug, comp: Slug, div: Slug, no: number) =>
    `/o/${org}/c/${comp}/d/${div}/f/${no}`,
  /** Token/chromeless surfaces stay id-based — no slug chain in kiosk URLs. */
  slideshowCompetition: (competitionId: string) => `/slideshow/competitions/${competitionId}`,
  slideshowDivision: (divisionId: string) => `/slideshow/divisions/${divisionId}`,
  /** Public dashboard — slug-based already, marker-less scheme, unchanged. */
  shared: (orgSlug: Slug, compSlug?: Slug, divSlug?: Slug) =>
    ["/shared", orgSlug, compSlug, divSlug].filter(Boolean).join("/"),
  /** Public register page (design §5) — competition-scoped (one cart can
   *  span divisions), so the SAME url is shown on every Registration hub
   *  row rather than a per-division link. */
  publicRegister: (orgSlug: Slug, compSlug: Slug) => `/shared/${orgSlug}/${compSlug}/register`,
  /** Public fixture page (spectator view — the link /me hands a player). */
  sharedFixture: (orgSlug: Slug, compSlug: Slug, divSlug: Slug, fixtureId: string) =>
    `/shared/${orgSlug}/${compSlug}/${divSlug}/fixtures/${fixtureId}`,
  /** Player home (PROMPT-53) — cross-org, deliberately NOT under /o. */
  me: () => "/me",
  /** Token surfaces (PROMPT-53): the token IS the address, no org in the URL. */
  claim: (token: string) => `/claim/${token}`,
  checkin: (token: string) => `/checkin/${token}`,
} as const;
