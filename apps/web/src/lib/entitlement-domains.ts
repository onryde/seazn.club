// Domain grouping for entitlement keys — shared by /pricing and
// /admin/entitlements so the two surfaces tell the same story (V290).
// Keys NOT listed here are deliberately unadvertised (vestigial D9 keys) —
// /admin still shows them under "other". `domains.custom` used to be named
// here as "unadvertised until Spec 2 ships"; V393 deleted the key entirely, so
// there is no longer a row to advertise later.
export const ENTITLEMENT_DOMAINS: { slug: string; features: string[] }[] = [
  // scorers.max is not listed here because the KEY no longer exists: V395
  // (entitlements v18 W2 T12, owner ruling 2026-09-03) deleted it from
  // plan_entitlements outright, and both enforcement branches now draw on
  // members.max. It used to be described here as "deliberately absent (#244) —
  // dormant legacy, surfaced under /admin's `other`"; there is nothing left for
  // /admin to surface. The scorer ROLE is untouched (#707).
  { slug: "scale", features: [
    "competitions.max_active", "orgs.max_owned", "divisions.per_competition.max",
    "entrants.per_division.max", "members.max",
    "clubs.max", "teams.max", "teams.squad_max",
    "stages.per_division.max", "dashboard.public.max", "import.bulk",
  ]},
  { slug: "money", features: [
    "registration.enabled", "registration.paid", "sponsors.tiers", "sponsors.monetize",
  ]},
  { slug: "formats", features: [
    "formats.advanced", "formats.double_elim", "standings.custom_points",
    "standings.carry_over", "tiebreakers.custom", "discipline.enforced",
  ]},
  // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
  // the AI credit wallet meters runs on every tier now, not a plan-graded
  // per-division count — the comparison table has nothing left to show here.
  { slug: "scheduling", features: [
    "scheduling.board", "scheduling.constraints", "scheduling.multi_division",
    "scheduling.ai",
    "schedule.checkpoints.max", "schedule.versioning",
  ]},
  // W1 (entitlements v18, owner ruling 2026-08-30): `scoring.ball_by_ball`,
  // `scoring.rally_by_rally` and `scoring.match_timeline` are NOT listed —
  // V390 deleted their `plan_entitlements` rows, so a comparison row here
  // would render an empty column on every plan while telling a reader that
  // recording detail is something plans differ on. It is not: every band is
  // free on every plan.
  { slug: "scoring", features: [
    // W3-A (2026-09-06): `stats.player` (the per-division record) is now free
    // on every plan — kept in this list rather than removed, same precedent
    // as `formats.double_elim` above (an all-true row still tells the "this
    // is included" story). `stats.player.career` is the NEW key for the
    // leverage half split off it — the cross-division career rollup,
    // Pro + pass — placed immediately after so the pair reads as one split
    // rather than two unrelated rows.
    "scoring.device_links", "cricket.dls", "stats.player", "stats.player.career",
    // The public player card that carries those stats. Grouped with the player
    // data rather than with `brand` so a reader comparing plans finds both
    // player rows together; the `dashboard.` prefix is not a domain signal
    // (dashboard.public.max sits under scale, dashboard.branding under brand).
    "dashboard.player_profiles",
  ]},
  // officials.per_fixture.max is absent: V319 makes it ∞ on every plan, so a
  // comparison row would read ∞/∞/∞/∞ and tell no story. The roles_multi/marks
  // ticks already say "officials are included on every plan"; officials.auto is
  // the only real differentiator left.
  { slug: "officials", features: [
    "officials.roles_multi", "officials.auto", "officials.marks",
  ]},
  // `dashboard.branding` left this list in W2 (entitlements v18 T17) and
  // `dashboard.theme` took its place. Not a rename — a correction of which key
  // the row was ever describing. The label has always read "Your colours on
  // public pages" — and the colour is exactly what V397 split out, while
  // `dashboard.branding` is badge removal alone. The four locale strings are
  // re-pointed rather than duplicated: nothing else read the old key.
  //
  // The badge row does not simply move across, for the same reason
  // `support.priority` left below: V396 made badge removal ENTERPRISE-only,
  // enterprise is not a `/pricing` column (design §4 — it is the Contact-us
  // strip under the table), so the row would render a tick-free line in all
  // four columns. Worse than telling no story: it would have told a Pro
  // subscriber their colours are not included, which is what it did between
  // V396 and V397. Badge removal is a Contact-us conversation now.
  //
  // /admin keeps showing `dashboard.branding` — `entitlement-admin.ts` files
  // every key this list omits under its trailing "other" section.
  { slug: "brand", features: [
    "branding", "dashboard.theme", "realtime", "embeds.enabled",
    "discovery.listed", "discovery.featured", "discovery.branding",
    "exports", "exports.branded", "news.auto",
  ]},
  // support.priority left this list in W2 (entitlements v18): V393 deleted the
  // key from `plan_entitlements`, and a comparison row for a key with no rows
  // renders "—" in every column — a paywall tick for something no plan grants.
  // Priority support is now a Contact-us conversation (design §4), not a matrix
  // row. The `pricing.matrix.support.priority` label stays in the four
  // dictionaries as an unused key: `lib/i18n-keys.ts` is generated from the en
  // dictionaries and NOT from this list, so nothing here orphans it, and the
  // dictionary tree is W3's to prune.
  { slug: "platform", features: [
    "clubs.hierarchy", "logos.bulk", "api.access", "api.write",
  ]},
];
