# RS004 — Registration hub shell + Settings tab

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Org-panel UI session — load `frontend-design:frontend-design`
before any component work.

Branch `feat/rs004-registration-hub-settings` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §5.

## Why

Since RS001 the org panel has NO registration surface at all. Organisers must
be able to configure divisions (including the new category/age, approval,
free-agent fields) before the public flow returns in RS006 — so the hub's
Settings tab lands before the stepper.

## Scope

1. **Route + shell**: `app/o/[orgSlug]/c/[compSlug]/registration/page.tsx`
   (server component + client tabs), tab state via `?tab=settings|registrants`
   query param mirroring the division page's pattern. Registrants tab renders
   a placeholder panel this session (RS005 fills it) — placeholder still
   designed, not a TODO string. Owner/admin only (same guard as competition
   settings); scorer/viewer never see the nav entry.
2. **Nav entry**: "Registration" card/link on the competition overview page,
   with live counts (open divisions, total registered) — pattern-match how
   overview links to schedule/settings today.
3. **Settings tab**: division rows — status pill (open now / scheduled /
   closed, derived from enabled+window), window, capacity meter
   (count/capacity), fee, entrant_kind, category + age badges, approval mode,
   free-agent flag, per-division public register link + copy button (link only
   when competition visibility allows, as the old page did).
4. **Config panel** (row click → panel/drawer): every `registration_settings`
   field (enabled, opens_at/closes_at, capacity, fee+payment method —
   behind the `registration.paid` entitlement gate exactly as before — refund
   lock, payment instructions; currency is org-level since RS001b: render a
   read-only currency chip linking to org settings, NO per-division currency
   input), the **form-fields builder** (port the old
   builder UI from git history of `registration-settings.tsx` — do not
   redesign its data shape), plus new: category select, age_min/age_max,
   approval toggle, allow_free_agents (only for team divisions). Category/age
   write to `divisions` via the existing division PATCH surface (extend it),
   the rest to `registration_settings`.
5. **API**: whatever settings read/update endpoints RS001 preserved need
   extending for the new fields; openapi:gen if api-v1 zod moves.
6. **Org preferred-currency select**: on the org settings page (not this
   hub): select over `REGISTRATION_CURRENCIES` (code + `Intl.DisplayNames`
   name), writing `organizations.currency` via the existing org-settings
   update surface with a zod enum mirroring the constant (not
   `z.string().length(3)`); label strings ×4 locales.

## Acceptance criteria

- [ ] Organiser configures a division end-to-end in the browser: set mixed +
      U18 + manual approval + free agents on a team division, reopen page,
      values persist (Playwright, prod build, localhost:3100)
- [ ] Entitlement: fee section locked without `registration.paid`
      (`data-feature` attr rendered, as the old gate did)
- [ ] Currency: config panel shows the chip (no input); org-settings select
      persists; changed org currency re-renders the hub's fee cells in the
      new currency; select offers exactly `REGISTRATION_CURRENCIES`
- [ ] Register-link copy button yields the working public URL (even though the
      page it points to is still closed-state — assert the URL, not the page)
- [ ] Viewer/scorer: no nav entry, direct URL → 403/redirect matching the
      repo's guard convention
- [ ] Every new string ×4 locales, `i18n:check` green
- [ ] Screenshots 1280/768/320, no horizontal scroll; hub added to
      `mobile.spec.ts` seven-width matrix
- [ ] Old `?tab=` deep links from RS001's deleted route: none survive —
      `git grep -a divisionRegistrations` still zero
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; openapi/i18n-keys
      drift clean

### Test types

- **Unit** — settings update usecase extensions, status-pill derivation.
- **E2E** — the configure-persist loop above + mobile widths.
- **Smoke** — deferred RS010. **Regression** — entitlement gate on fee.

## Gotchas

- The org panel is full-polish surface (only `/admin` is functional-bar).
- Mobile 320 is where config drawers die — the seven-width matrix races over
  ONE org; give this spec its own org/tag if it mutates settings (e2e `TAG` is
  per process).
- `settings.tz` vs `orgTz` — window datetimes render in org timezone; the old
  form had this right, keep it.
- The form-fields builder port is the sneaky-large item; if it blows the
  session budget, ship the builder VERBATIM-ported and note polish debt for
  RS010 in `_INDEX.md` — do not fork its data shape.

## Execution

Scout: competition overview link pattern, division PATCH surface, entitlement
gate component usage, old `registration-settings.tsx` from git history
(`git show <RS001-parent>:apps/web/src/components/v2/registration-settings.tsx`).
Then one implementer loop; frontend-design loaded before components. Reviewer:
guard coverage, tz handling, entitlement bypass, i18n completeness.

## On close

`_INDEX.md`: RS004 → DONE + PR#, config-panel component contract RS005 mounts
beside, any builder-port debt. Memory + snapshot.
