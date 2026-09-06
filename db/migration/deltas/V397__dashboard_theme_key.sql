-- Entitlements v18 W2 / T17 (owner ruling 2026-09-03; design of record
-- docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md §2,
-- amended in the same commit — `entitlements-v18-matrix.test.ts` parses that
-- table and pins every cell below against it).
--
-- `dashboard.branding` was OVERLOADED and nobody knew. One key gated two
-- unrelated things: removing the "Powered by seazn.club" badge, AND the org /
-- competition ACCENT COLOUR on every public surface. The split was already
-- half done — the LOGO has ridden the separate `branding` key since V310 —
-- but colour and badge stayed welded together.
--
-- V396 (T15) then made badge removal enterprise-only by turning
-- `dashboard.branding` false on Pro. That silently took a paying Pro
-- customer's brand colour off their public pages, slideshow and competition
-- pages: a visible downgrade nobody asked for. Four smoke checks caught it
-- and were deliberately left RED rather than edited to match the defect
-- ("pro public page carries the org accent theme", "pro slideshow carries the
-- org accent theme", "pro org landing carries the org color", "competition
-- color overrides the org color").
--
-- Ruling: the colour gets its OWN key, Pro and above. Rejected alternative:
-- letting colour ride the free `branding` key, which would have handed it to
-- Free — the owner chose to keep it as a paid visual differentiator.
--
-- After this file: `dashboard.theme` = the accent/theme colour (Free F, Pro T,
-- Ent T); `dashboard.branding` = badge removal ALONE (enterprise-only, set by
-- V396 and untouched here).

-- ---------------------------------------------------------------------------
-- Step 1: the new key.
--
-- NO PASS ROWS, deliberately. The theme colour is an ORG-level property
-- (`organizations.branding`), so a competition-scoped Event Pass could never
-- lift it — the resolver's pass arm can only GRANT on top of the plan row for
-- one competition, and there is no per-competition org palette to grant. A
-- row here would be inert, and an inert row is a lie in the matrix: it would
-- make the key read as pass-lifted to `pass-scoping-guard.test.ts`, which
-- derives its target set from exactly this table, and send that guard hunting
-- for enforcement sites that must not exist.
--
-- Re-runnable, like every statement in this tree.
insert into plan_entitlements (plan_key, feature_key, bool_value)
values ('community',  'dashboard.theme', false),
       ('pro',        'dashboard.theme', true),
       ('enterprise', 'dashboard.theme', true)
on conflict (plan_key, feature_key) do update set bool_value = excluded.bool_value;

-- ---------------------------------------------------------------------------
-- Step 2: the COMPETITION colour follows the org colour onto the new key.
--
-- `public_competitions_v` empties the branding blob server-side for orgs that
-- are not entitled to it — the same gate `server/public-site/data.ts` applies
-- to the ORG blob, which is why "competition color overrides the org color"
-- is one of the four red smoke checks: both ends of that chain were gated on
-- `dashboard.branding` and both went dark on Pro together.
--
-- Body copied VERBATIM from its effective source (deltas/V306, which itself
-- copied v2-engine/views/V230) with exactly one change: the feature key. The
-- column list is untouched — create-or-replace may only APPEND columns, and a
-- reordered list either fails outright or silently changes a public API.
-- V239's grant on this view is unaffected by create-or-replace.
--
-- The call drops from V306's 3-arg (pass-aware) form to the 2-arg form ON
-- PURPOSE, and it is not a regression: with no pass rows for this key (step 1)
-- the third argument can only resolve to the plan row anyway, so the two forms
-- are identical in behaviour. The 2-arg call says out loud what the ruling
-- says — this key is org-level and a pass never lifts it — where a 3-arg call
-- would advertise an overlay that does not exist.
create or replace view public_competitions_v as
  select id, org_id, name, slug, description, starts_on, ends_on,
         case when org_has_feature(org_id, 'dashboard.theme') then branding
              else '{}'::jsonb end as branding,
         status, created_at, visibility
  from competitions
  where visibility in ('public','unlisted');
