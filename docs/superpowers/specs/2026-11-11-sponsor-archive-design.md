# Archive a sponsor: design

**Status:** the owner approved the behaviour on 2026-11-11 (§1, D1 to D7). The other decisions (D8 to D28) are this spec's; each is marked "This spec" and gives its reason. The owner may overrule any of them at sign-off (§13).
**Plan:** `docs/superpowers/plans/2026-11-11-sponsor-archive.md`.
**Branch:** `feat/sponsor-archive`, cut from `origin/main` at `50cf8aa053`. It is **built after sponsor deals PR 3 (#1176, `feat/sponsor-deals-invoices`) merges**, because it relies on PR 3's numbered-invoice delete fence. It is rebased onto main once #1176 is in. Every line number below was read at `origin/feat/sponsor-deals-invoices` `db49811d45`; re-pin each one after the rebase.

## 1. Intent

A sponsor that holds deal history cannot be deleted. `deleteSponsor` answers 409 `sponsor_has_deal_history` when a deal holds money paid or refunded, a numbered invoice, or a pre-deals order (`dealHoldsHistory`, `usecases/sponsors.ts:346-348`). PR 3's V502 (`V502__sponsor_invoices.sql`) also narrows the tenant's prune policy with `invoice_number is null`, so the database refuses too. A club that has finished with a sponsor therefore has no way to clear it out of its list. **Archive** is that way: the sponsor disappears from everywhere a person sees it, and every record stays.

Owner-approved behaviour (2026-11-11), verbatim in substance:

- An **Archive** button sits on the console sponsor page, next to Delete. Delete stays for sponsors with no deal history. A sponsor with history cannot be deleted (409 `sponsor_has_deal_history`), and that is why Archive exists.
- Archiving hides the sponsor from the Sponsors list, the public pages, the TV slideshow and the stream rotation.
- Archiving keeps everything: deals, invoice numbers, PDFs, payments and click counts.
- Archive is refused while the sponsor has a deal that is live, scheduled or awaiting payment. The copy reads "End or settle its deal first."
- The list gets a slim **"Show archived (N)"** switch, shown only when N > 0. It uses the same house switch as the Sponsors work in #1179 and the retired-packages switch being built now. Archived rows show greyed.
- **Unarchive** puts the sponsor back in the list as it was. A new deal later works normally.
- Old invoice links still open, because an invoice is a record.

**Owner value.** A club's list shows only the sponsors it works with now, and its books stay whole. Without Archive, the only ways out are a delete the server refuses or a list that grows forever with old names.

## 2. Goals

- G1. An editor can archive a sponsor from its own page in the console, and unarchive it from the same page.
- G2. An archived sponsor is absent from:
  - the Sponsors list (unless the switch is on);
  - the On stream tab's tick list;
  - every public surface: the competition page, its hero title line and poster, the match page, embeds and branded exports;
  - both TV slideshows;
  - the stream rotation and assigned breaks;
  - the tracked `/s/` redirect.
- G3. Nothing is deleted or rewritten. Deals, invoice numbers, invoice pages and PDFs, payments, `click_count`, the tier, scope, on-stream tick, status, display order, logo and poster all stay. Unarchive restores the sponsor exactly as it was.
- G4. Archive is refused (409 `sponsor_has_current_deal`, copy "End or settle its deal first.") while any deal could still put the sponsor on a public surface or still asks for money (D9).
- G5. The list carries a slim "Show archived (N)" switch, drawn only when N ≥ 1. With the switch on, archived rows show greyed in their own trailing group.
- G6. All four locales (en, es, fr, nl). The design works at 320, 768 and 1280 with no horizontal page scroll.

## 3. Non-goals

- No change to Delete's rules. A sponsor without history can still be deleted, archived or not.
- No bulk archive and no automatic archive (for example, "archive when the last deal ends").
- No archive for packages. The retired-packages switch is a separate piece of work; this feature only shares its switch component (D23).
- No new plan gate. Archive works on every plan (D25).
- No change to the invoice, report-link or evidence surfaces. They read deals and links, not a sponsor's visibility, and they keep working (D7, D15, D16).
- No public "archived" wording anywhere. To the public, an archived sponsor simply is not there.

## 4. Facts re-pinned against the tree, and false premises

| Fact | Where (PR 3 at `db49811d45` unless named) |
|---|---|
| `sponsors.status` (`active`/`pending`/`inactive`) is written by `applyDealsToSponsor`, the one owner of a deal's effect on its sponsor. A live deal means `active` (or `pending` while parked); open deals mean `inactive`; when the last deal ends the sponsor goes `inactive` (step 5) | `server/sponsors/deal-apply.ts:270-375` |
| `lockSponsorAndDeals` is F2's one lock order: the sponsor `for update`, then its deals. It selects `id, org_id, status, tier, competition_id, on_stream, placement_from_deal_id` | `deal-apply.ts:130-143` |
| Deal rules live in one place, `lib/sponsor-deals.ts` (client-safe): `DEAL_STATUSES` (`draft, awaiting_payment, awaiting_approval, scheduled, live, ended`), `isLiveDeal`, `isOpenDeal` (neither live nor ended) and `endedStillDue` (an offline deal that went live, then ended unpaid as `expired` or `competition_finished`) | `lib/sponsor-deals.ts:13, 99-103, 210-221` |
| `dealHoldsHistory` covers money paid or refunded, a numbered invoice, or a legacy order. `deleteSponsor` checks it before and inside its transaction | `usecases/sponsors.ts:346-411` |
| V502 narrows `sponsor_orders_prune` with `invoice_number is null`, and the invoice number is fixed once set (a trigger) | `db/migration/deltas/V502__sponsor_invoices.sql` (PR 3, #1176) |
| `listSponsorRows` returns every row of the org, tier-ranked, with the deal summary. Both the console page and `GET /sponsors` read it | `usecases/sponsors.ts:197-227` |
| `resolveSponsors` filters `status = 'active'`, scopes to the competition or org-wide, then **dedupes by name**, and collapses tiers to `partner` when `tiered:false` | `usecases/sponsors.ts:464-498` |
| Callers of `resolveSponsors`: the competition page `:166`, the match page `:269`, both slideshows, `embed-data.ts:181`, `exports.ts:188` (`orgBranding`) and `card-source.ts:74` (the stream rotation, `onStream:true`) | grep `resolveSponsors(` |
| Four more SQL sites filter visibility by `status = 'active'` themselves: `resolveSponsorLink` (the uuid arm `:63` and the short-code arm `:70`), `recordClick` `:88`, and `activeSponsorCards` (assigned breaks) | `server/sponsors/clicks.ts`, `server/sponsors/card-source.ts:58-69` |
| `createDeal` reads the sponsor without a lock (`:249`), then locks it in its write transaction (`:310`) and allocates the invoice number in that transaction | `usecases/sponsor-deals.ts:234-340` |
| Every sponsor route is listed in `NEVER_KEY_ROUTES`, and `openapi/v1.public.json` carries no `/sponsors` path | `server/api-v1/key-scopes.ts:345-370` |
| House archive pattern: `POST /…/archive` archives, `DELETE /…/archive` restores, both idempotent, and they answer the row. A list includes archived rows with `?archived=1` (the "1"/"0" boolean-query convention) | `app/api/v1/orgs/[id]/venues/[venueId]/archive/route.ts`; `venues/route.ts:12`; `openapi.ts:75, 107-108, 281-287` |
| Coded sponsor refusals come from one list, `SPONSOR_REFUSAL_CODES`. The console's `save-error.ts` is a `Record` over it, so a new code without words does not compile | `lib/sponsor-refusals.ts` |
| The slim switch: a 44 × 56 tap target `role="switch"` holding a 24 × 44 track and a 20 px knob. It is inline in the On stream tab, and `on-stream-tab.test.tsx:183-230` pins its proportions | `components/sponsors/on-stream-tab.tsx:214-235` |
| Delete is the trash icon in the list row's tools, folded into the ⋯ tray below `md` | `components/sponsors/sponsor-list.tsx:345-356` |
| Public pages expire through `expirePublicSponsors` after the commit (`expireCompetitionShell`, awaited inside the request) | `usecases/sponsors.ts:179-181` |
| Migrations: main holds **V501** (`sponsor_poster`, #1186) and **V502 to V504** (the sponsor invoices, PR 3 #1176: `sponsor_invoices`, `email_outbox_sponsor_deal_paid`, `sponsor_deal_written_off`); this feature authored **V505**, the next free number (provisional: renumbered at merge if main moved). Renumbered to **V508** before merge: staging already had V506 (`quick_matches`) applied and V507 is claimed by two unmerged branches | `db/migration/deltas/` at `9f9ca88d8d` |

**Premises in the brief that proved false or incomplete** (AGENTS.md class 5):

1. **The format pair is not on main.** `2026-11-11-title-sponsor-hero-poster-design.md` and its plan existed only on the **local, unpushed** branch `feat/title-sponsor-poster` (`83dbed62a3`) when this spec was written; they have since merged to main as #1186. This pair copies their shape.
2. **"Next to Delete" on the sponsor page.** The sponsor page (`sponsor-sheet.tsx`) has no Delete. Delete is the trash icon on the list row. This spec puts Archive and Unarchive in a card at the foot of the sponsor page (D20) and points the history-refusal copy at it (D21). Delete stays on the row.
3. **"The same house switch as the Sponsors list (#1179)".** #1179's slim switch is the **On stream tab's rotation switch**. The Sponsors list has none, and no shared component exists. The "retired-packages switch being built now" is on no branch, local or `origin`. This feature extracts the shared component (D23).
4. **"The Add deal sheet's sponsor picker".** There is none. `AddDealSheet` takes one `sponsor` and is opened from that sponsor's row action or page. The filter becomes: do not offer Add deal for an archived sponsor, and refuse it on the server (D10).
5. **"Search/directory if any".** None reads sponsors. The kiosk (`/present`) and its OG images do not draw sponsors either.
6. **"Live, scheduled or awaiting payment"** leaves out `draft` and `awaiting_approval` (both can still go live) and an **ended deal still due** (it still asks for money). D9 covers all of them.
7. **Migration numbers.** When this spec was written, the poster branch's file was **`V503__sponsor_poster.sql`**, colliding with PR 3's `V503__sponsor_deal_written_off.sql`. Resolved on main: the poster merged as **V501** (#1186), PR 3's invoices as **V502 to V504** (#1176), and this feature authored **V505**, renumbered to **V508** before merge (V506 `quick_matches` was already applied on staging; V507 is claimed by two unmerged branches). PR 3 was then still WIP; it merged as #1176 (`9f9ca88d8d`).
8. **The visibility filter is not one place.** Besides `resolveSponsors`, four SQL sites read `status = 'active'` directly (§4 table). Each needs the archive filter, and a sweep pins the set (D27, plan Task 4).
9. **"The v1 API plus OpenAPI regen"** applies to the console only. Every sponsor route is never key-accessible, so only `openapi/v1.json` changes; `v1.public.json` has no sponsor paths.

## 5. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Archive and Unarchive on the console sponsor page. Delete stays, and its rules are unchanged | Owner |
| D2 | Hidden from the Sponsors list, every public page, both TV slideshows and the stream (rotation and assigned breaks) | Owner |
| D3 | Everything is kept: deals, invoice numbers, PDFs, payments, click counts | Owner |
| D4 | Refused while a deal holds the sponsor; copy "End or settle its deal first." | Owner (the set is widened by D9) |
| D5 | "Show archived (N)" slim switch, only when N ≥ 1; archived rows greyed | Owner |
| D6 | Unarchive restores the sponsor as it was; a later new deal works normally | Owner |
| D7 | Old invoice links still open | Owner |
| D8 | **Storage:** a new nullable `sponsors.archived_at timestamptz`, orthogonal to `status`. Archive never writes `status`, tier, scope, `on_stream` or `display_order`. *Reason: `applyDealsToSponsor` owns `status`; a separate column makes Unarchive exact by construction.* | This spec |
| D9 | **What blocks Archive:** any non-legacy deal that is live, open (draft, awaiting_payment, awaiting_approval, scheduled) or `endedStillDue`. One predicate, `blocksArchive(d)`, in `lib/sponsor-deals.ts`, read by the server and the sheet alike. *Reason: each of these can still put the sponsor on a public surface or still asks for money; the owner's three are a subset, and "settle" names the money case.* | This spec |
| D10 | **An archived sponsor cannot receive a new deal:** `createDeal` answers 409 `sponsor_archived`, checked once early (before any Stripe or outbox work) and again under the sponsor lock (before the invoice number is allocated). The console offers no Add deal. *Reason: a deal going live on a hidden row would surprise the club; unarchiving first is one tap and keeps one rule.* | This spec (the brief's recommendation) |
| D11 | **Any PATCH of an archived sponsor is 409 `sponsor_archived`.** `archived_at` is not in any write schema, so `PATCH {archived_at: null}` is stripped and answers 400 `empty patch`. Reorder and Delete are unchanged. *Reason: the archived page is read-only, and one rule beats a per-field list.* | This spec |
| D12 | **`GET /sponsors` excludes archived rows by default; `?archived=1` includes them** (with `archived_at` set). Any other value excludes them. *Reason: venues and divisions already use `?archived=1`; one convention across v1. "Only archived" is a client filter of "include".* Departs from the brief's `include\|only` | This spec |
| D13 | **API:** `POST /orgs/{id}/sponsors/{sponsorId}/archive` archives and `DELETE …/archive` unarchives. Both are idempotent (a second call keeps the first `archived_at`), answer `Sponsor`, require write auth and are in `NEVER_KEY_ROUTES`. `Sponsor` gains `archived_at: string \| null`. **No `api-v1-breaking-changes.md` entry:** the shape change is additive, and no key can reach these routes. *Reason: the house archive pattern; the file lists breaking shapes only.* | This spec |
| D14 | `/s/<id>` and `/s/<code>` of an archived sponsor answer 404 and record no click, as for an inactive sponsor today. `click_count` and `sponsor_clicks` are kept. *Reason: "hidden everywhere" includes the redirect; counts are history and stay.* | This spec |
| D15 | Report links: existing links keep opening (a record, like an invoice). The Overview lists an archived sponsor **only when it has airings or clicks in the period**. *Reason: its numbers are history and must still add up; an empty row each period is clutter.* | This spec |
| D16 | The archived sponsor's deals stay reachable from its page: deal page, invoice page and PDF, refund, evidence pack. *Reason: records and money corrections must not need an unarchive.* | This spec |
| D17 | An ended, paid deal with an open dispute does **not** block Archive. *Reason: nothing is left for the club to end or settle on the deal itself; the evidence pack stays reachable (D16).* | This spec |
| D18 | **Poster and title (#1186, merged from `feat/title-sponsor-poster`; `poster_path` is V501).** Archive leaves `poster_path`, the tier and the scope untouched. The hero's "Presented by" sentence, its poster panel and its band drop because `resolveSponsors` drops the row. Unarchive restores them. A live Title deal blocks Archive (D9), so only a hand-set Title sponsor can be archived. *Reason: the poster is the sponsor's data; visibility is the resolver's.* | This spec |
| D19 | **The list:** archived rows sit in a trailing **"Archived"** group after the tier groups, greyed (`opacity-60`), with an "Archived" chip. They have no move buttons and no row action; the pencil opens the read-only page. *Reason: move and the tier groups read the live order, where an archived row has no place.* | This spec |
| D20 | **Placement:** an "Archive" card at the foot of the sponsor page, editors only. It holds a hint, the button and, when blocked, the visible line "End or settle its deal first." with the button disabled. No confirm dialog; the result is announced in the page's existing `sponsor-notice` live region. *Reason: archive is reversible, and the house confirms only destructive actions.* Two layouts are in §7.4 | This spec |
| D21 | The delete refusal's copy (`sponsors.error.hasDealHistory`) now ends "Archive it instead." in four locales. *Reason: the refusal should point to the way out.* | This spec |
| D22 | Archive and Unarchive await `expirePublicSponsors(orgId, "sponsor.archive" \| "sponsor.unarchive")` after the commit. *Reason: the smoke lesson in `usecases/sponsors.ts:170-178`; the public page must change at once.* | This spec |
| D23 | **The switch:** `components/ui/slim-switch.tsx`, lifted verbatim from the On stream tab's markup, with testids passed in. The On stream tab adopts it (its proportion test is the regression proof). If the retired-packages work lands a shared switch first, use that one and create no second one (AGENTS.md class 18). | This spec |
| D24 | The switch state is local to the page and defaults to off; it is not in the URL. Opening `?sponsor=<archived id>` always works (it is how Unarchive is reached from a link). `?edit=1` on an archived sponsor opens the read-only page. | This spec |
| D25 | Archive is ungated: every plan, including Free and Event Pass orgs. | This spec |
| D26 | Editors only: write auth on the route, and `canEdit` in the console. A viewer sees the archived banner and no buttons. | This spec |
| D27 | One visibility rule in SQL, `status = 'active' and archived_at is null`, at every site in §4. A static sweep finds every `sponsors` read that filters `status = 'active'` and refuses any without `archived_at is null`; it reports its count, and zero is a failure. | This spec |
| D28 | The archive filter runs in SQL **before** the resolver's name dedupe, so a new "Acme" is never hidden behind an archived "Acme". | This spec |

## 6. Data and API

### 6.1 Migration `V508__sponsor_archive.sql` (authored as V505; renumbered to V508 before merge)

```sql
-- V508 — archive a sponsor: hidden everywhere, every record kept (renumbered at merge: rename the file AND this line).
-- Spec: docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §6.1.
alter table sponsors add column archived_at timestamptz null;
```

- There is no index: an org has tens of sponsors, and every read is already scoped by `org_id`.
- There is no backfill: the schema is greenfield.
- RLS and grants are table-level, so nothing else is owed.
- Line 1 self-names (`migration-header-truth.test.ts`), so the renumber is a `git mv` plus a line-1 edit. Tests find the file by the suffix `__sponsor_archive.sql`.

### 6.2 Server

- `SponsorRow.archived_at: string | null`, and `COLS` gains `"archived_at"`. `SponsorItem` (client) mirrors it.
- `LockedSponsor.archived_at` is added to `lockSponsorAndDeals`' select.
- `listSponsorRows(orgId, { includeArchived = false })`. The console's Sponsors tab passes `true` (the switch needs N and the rows); the On stream tab passes `false`; `listSponsors(auth, opts)` follows the route's `?archived=1`.
- `archiveSponsor(auth, id)`, in one transaction:
  1. `lockSponsorAndDeals`, or 404;
  2. if already archived, return the row unchanged;
  3. if `deals.some(blocksArchive)`, refuse 409 `sponsor_has_current_deal`;
  4. `update sponsors set archived_at = now()`.
  Then `expirePublicSponsors`, and `log.info("sponsor_archived")`.
- `unarchiveSponsor(auth, id)`: lock, or 404; if not archived, return unchanged; otherwise `archived_at = null`. Then expire.
- `patchSponsor`: after the lock and before `assertSponsorPatchAllowed`, refuse 409 `sponsor_archived` when `locked.sponsor.archived_at !== null`.
- `createDeal`: refuse 409 `sponsor_archived` in the pre-read (`:249`, now `select archived_at`) and again after `lockSponsorAndDeals` (`:310`), before `allocateInvoiceNumber`.
- `SPONSOR_REFUSAL_CODES` gains `sponsor_has_current_deal` and `sponsor_archived`.
- `blocksArchive(d) = !legacy && (isLiveDeal(d) || isOpenDeal(d) || endedStillDue(d))`, exported from `lib/sponsor-deals.ts`. Its truth table is §8.

### 6.3 API

| Call | Result |
|---|---|
| `GET /orgs/{id}/sponsors` | Rows with `archived_at null` only |
| `GET …/sponsors?archived=1` | Every row, archived ones with `archived_at` set |
| `GET …/sponsors?archived=0` or `?archived=yes` | As the default (only `"1"` includes) |
| `POST …/sponsors/{sid}/archive` | 200 `Sponsor` with `archived_at`. A second call returns 200 with the same `archived_at`. 409 `sponsor_has_current_deal`. 404 for another org's sponsor or an unknown one |
| `DELETE …/sponsors/{sid}/archive` | 200 `Sponsor` with `archived_at: null`. Idempotent. 404 as above |
| `PATCH …/sponsors/{sid}` while archived | 409 `sponsor_archived`, row unchanged |
| `PATCH {archived_at: null}` | 400 `empty patch` (an unknown key is stripped) |
| `POST …/sponsors/{sid}/deals` while archived | 409 `sponsor_archived`; no deal row, no invoice number used |
| `DELETE …/sponsors/{sid}` while archived | Unchanged rules: 409 `sponsor_has_deal_history`, or deleted |

OpenAPI: add the two archive rows and the `archived` query on the list. Amend the PATCH, deals and DELETE summaries with the new 409s. `Sponsor.archived_at` is `z.string().nullable()`. Regenerate `openapi/v1.json`; `v1.public.json` should not move (check that it doesn't).

## 7. Console UI

### 7.1 The list (Sponsors tab)

- `OrgSponsors` keeps every row and derives two sets: `live = archived_at === null` and `archived`.
- `SponsorList` renders `live` as today.
- **Switch row**, drawn only when `archived.length ≥ 1`. It sits directly above the list: `flex min-w-0 items-center justify-end gap-2`, a label `sponsors.archive.show` with the count, then the slim switch (`data-testid="sponsors-archived-switch"`, `role="switch"`, `aria-checked`, `aria-labelledby` the label). At 320 the row is one line; the longest label, nl "Gearchiveerde tonen (12)", fits in 288 px.
- **Switch on:** after the tier groups, a group `data-testid="sponsor-group" data-tier="archived"` whose header is "Archived". Each row is `data-archived="true"` with `opacity-60`, carries the "Archived" chip, and keeps its logo, name, clicks and the pencil (which opens the read-only page). It has no move buttons, no deal action and no Add deal. The trash stays, under the unchanged Delete rules.
- **Switch off (default):** archived rows are not in the DOM.
- When the last archived sponsor is unarchived, the switch disappears and its state resets to off.

### 7.2 The sponsor page, live sponsor (editor)

A new card at the foot of the page, after Report link: `data-testid="sponsor-sheet-archive"`, using the page's `CARD` class. It holds:
- the title "Archive";
- the hint (`sponsors.archive.hint`);
- the button `sponsor-sheet-archive-button` (`SMALL_BTN`, Archive icon, `aria-label` "Archive {name}", `min-h-11` below `md`).

When the sponsor's deals block it (`blocksArchive`), the button is `disabled` with `aria-describedby` pointing to a visible line `sponsor-sheet-archive-blocked`: "End or settle its deal first." A viewer has no card.

### 7.3 The sponsor page, archived sponsor

- A banner at the top of the page (`sponsor-sheet-archived`, `rounded-xl bg-slate-100 p-3 text-sm`): "Archived on {date}. It is hidden from your lists, public pages, the TV slideshow and the stream." The date is `fmtPublicDate` in the org's timezone.
- Editors also get the **Unarchive** button (`sponsor-sheet-unarchive`, `aria-label` "Unarchive {name}").
- The page is read-only: there is no Edit pencil, no editor (`?edit=1` is ignored), no stream tick (the read-only "On/Off" text shows instead), no Show again and no Add deal.
- Deals, past deals, deal pages and Report link stay.
- The Archive card is replaced by the banner's Unarchive.

### 7.4 Two layouts considered (owner checklist: show ≥ 2 options)

- **A (recommended): a card at the foot of the page.** It reads as an end-of-life action, cannot be mistaken for a deal action, and has room for the blocked line at 320.
- **B: a button in the page header beside the name.** It is quicker to reach, but at 320 the header already wraps a 43-character name, and the blocked line has no home there.

Recommendation: **A**. The cost is one scroll on a long deals list, for an action a club takes rarely.

### 7.5 Widths

- **320:** the card is full width; the button and blocked line stack; the hint wraps (`break-words`, `min-w-0` down the chain). The banner wraps; Unarchive sits below its text.
- **768:** as 320, with the button inline after the hint.
- **1280:** the side sheet; the same card.
- No horizontal page scroll at any width, checked with a 43-character name in es and nl.

### 7.6 On stream tab and Overview

- On stream: the tick list is built from `listSponsorRows(…, { includeArchived: false })`.
- Overview: `sponsorOverview` adds `and (s.archived_at is null or air.sponsor_id is not null or clk.sponsor_id is not null)` to the sponsor arm (D15). An archived row there shows the "Archived" chip.

## 8. The blocking rule (D9), as a table

The expected values in tests come from this table, never from `blocksArchive` itself.

| Deal | Blocks |
|---|---|
| No deals | no |
| `draft` | yes |
| `awaiting_payment` | yes |
| `awaiting_approval` | yes |
| `scheduled` (paid or unpaid) | yes |
| `live` (including parked by a dispute) | yes |
| `ended` and `endedStillDue` (offline, went live, unpaid, `expired` or `competition_finished`) | yes |
| `ended` as `ended_now`, `refunded`, `written_off`, `dispute_lost` or paid | no |
| `ended`, offline, unpaid, never went live | no |
| `ended`, online, unpaid (`expired`) | no (claims nothing: its link is gone) |
| `ended`, paid, open dispute | no (D17) |
| Legacy order (`ended_reason = legacy`) | no |

## 9. Sequences, and the plan and gate states

| Sequence | Expected |
|---|---|
| Archive, then archive again | The second call answers the same `archived_at` |
| Archive, unarchive, archive again | Each succeeds; after the unarchive, the row equals the pre-archive snapshot on every column but `archived_at` |
| Live deal: archive | 409; then End now; then archive works |
| Offline deal ends `expired` unpaid: archive | 409; then Write off (or Mark paid); then archive works |
| Archived with numbered invoices | Invoice page and PDF open; delete is still 409 `sponsor_has_deal_history` |
| Archived with only a complimentary ended deal (no number) | Archive works; delete still works (no history) |
| Archived, then Add deal | 409 `sponsor_archived`; the invoice counter is unchanged |
| Unarchived, then Add deal | Works; goes live by its rule; shown publicly |
| Free org (no `sponsors.tiers`) | Archive and unarchive work; the free strip drops and regains the row |
| Event Pass org | As Pro on the pass's competition |
| Free org with a leftover Title row, archived then unarchived | Returns as `partner` on the strip (the resolver collapse is unchanged) |
| Another org's sponsor | 404 on archive and unarchive |
| Archive racing Add deal | Both take the sponsor lock: either the deal exists and the archive is refused, or the sponsor is archived and the deal is refused. Never both |

## 10. Locales

All keys go in `ui.json`, in a new block (no reorder; #1176 and the poster branch edit the same files). Regenerate `lib/i18n-keys.ts` and run `npm run i18n:check`.

| Key | en | es | fr | nl |
|---|---|---|---|---|
| `sponsors.archive.title` | Archive | Archivar | Archiver | Archiveren |
| `sponsors.archive.button` | Archive | Archivar | Archiver | Archiveren |
| `sponsors.archive.buttonLabel` | Archive {name} | Archivar {name} | Archiver {name} | {name} archiveren |
| `sponsors.archive.hint` | Hides this sponsor from your Sponsors list, your public pages, the TV slideshow and the stream. Its deals, invoices, payments and click counts are kept. | Oculta este patrocinador de tu lista de patrocinadores, tus páginas públicas, la presentación de TV y la retransmisión. Se conservan sus acuerdos, facturas, pagos y clics. | Masque ce sponsor de votre liste de sponsors, de vos pages publiques, du diaporama TV et du direct. Ses accords, factures, paiements et clics sont conservés. | Verbergt deze sponsor in je sponsorlijst, op je openbare pagina's, in de tv-diavoorstelling en in de stream. Deals, facturen, betalingen en klikken blijven bewaard. |
| `sponsors.archive.blocked` | End or settle its deal first. | Primero termina o liquida su acuerdo. | Terminez ou réglez d'abord son accord. | Beëindig of vereffen eerst de deal. |
| `sponsors.archive.done` | {name} is archived. | {name} se ha archivado. | {name} est archivé. | {name} is gearchiveerd. |
| `sponsors.archive.banner` | Archived on {date}. It is hidden from your lists, public pages, the TV slideshow and the stream. | Archivado el {date}. Está oculto en tus listas, páginas públicas, la presentación de TV y la retransmisión. | Archivé le {date}. Il est masqué de vos listes, pages publiques, du diaporama TV et du direct. | Gearchiveerd op {date}. Verborgen in je lijsten, op openbare pagina's, in de tv-diavoorstelling en in de stream. |
| `sponsors.archive.unarchive` | Unarchive | Desarchivar | Désarchiver | Uit archief halen |
| `sponsors.archive.unarchiveLabel` | Unarchive {name} | Desarchivar {name} | Désarchiver {name} | {name} uit archief halen |
| `sponsors.archive.unarchived` | {name} is back in your list. | {name} vuelve a estar en tu lista. | {name} est de retour dans votre liste. | {name} staat weer in je lijst. |
| `sponsors.archive.show` | Show archived ({count}) | Mostrar archivados ({count}) | Afficher les archivés ({count}) | Gearchiveerde tonen ({count}) |
| `sponsors.archive.group` | Archived | Archivados | Archivés | Gearchiveerd |
| `sponsors.archive.chip` | Archived | Archivado | Archivé | Gearchiveerd |
| `sponsors.error.archived` | This sponsor is archived. Unarchive it first. | Este patrocinador está archivado. Desarchívalo primero. | Ce sponsor est archivé. Désarchivez-le d'abord. | Deze sponsor is gearchiveerd. Haal hem eerst uit het archief. |
| `sponsors.error.hasDealHistory` (changed value, same key) | This sponsor has invoices or payments on record, so it can't be deleted. Archive it instead. | Este patrocinador tiene facturas o pagos registrados, así que no se puede eliminar. Archívalo en su lugar. | Ce sponsor a des factures ou des paiements enregistrés : il ne peut pas être supprimé. Archivez-le plutôt. | Deze sponsor heeft geregistreerde facturen of betalingen, dus hij kan niet worden verwijderd. Archiveer hem in plaats daarvan. |

`save-error.ts` maps `sponsor_has_current_deal` to `sponsors.archive.blocked` and `sponsor_archived` to `sponsors.error.archived`.

## 11. Readers: the inventory by behaviour (D27)

| Reader | Today's filter | Change |
|---|---|---|
| `resolveSponsors` (competition page, hero title and poster, match page, both slideshows, `embed-data`, `orgBranding`, `card-source.cardsFor`) | `status = 'active'` | Add `and archived_at is null`, before the dedupe |
| `resolveSponsorLink`, uuid arm | `status = 'active'` | Add the archive filter |
| `resolveSponsorLink`, short-code arm | `sp.status = 'active'` | Add the archive filter |
| `recordClick` | `status = 'active'` | Add the archive filter |
| `activeSponsorCards` (assigned breaks) | `status = 'active'` | Add the archive filter |
| `listSponsorRows` (console list, On stream tab, `GET /sponsors`) | none | `includeArchived` option |
| `sponsorOverview` | none | D15 predicate |
| `createDeal`, `patchSponsor` | none | Refuse `sponsor_archived` |
| `invoiceDocByToken`, invoice PDF, pay route | reads the deal | **None** (D7). A regression test pins that it still opens |
| `sponsorReport` (report links) | none | **None** (D15). A regression test pins it |
| `airings` ingest | org-scoped | **None**: a proof of play that aired is a record |
| `shortCodesFor`, `mintShortCode` | none | **None**: they are fed only sponsors the card source resolved (covered transitively) |
| `deleteSponsor`, `deleteCompetition` sweep | history and money guards | **None** |

## 12. Tests owed (the plan carries them per task)

- **Unit and DB:**
  - the migration (nullable, no default, found by suffix);
  - `blocksArchive` over §8's table (a sweep over `DEAL_STATUSES` × money × end reason, count reported);
  - §9's sequences through the usecases, read back from the stored row;
  - each reader in §11 with its positive pair;
  - the name-dedupe case;
  - the static reader sweep;
  - the refusal codes through the real v1 handler (`save-error.test.ts`);
  - the list, the switch and the page markup;
  - the slim-switch proportion test kept green.
- **E2E:**
  - a new `apps/web/e2e/sponsor-archive.spec.ts`, covering the UI golden path, the blocked state, the public page logged out, the invoice link after archive, the switch, Unarchive, and a new deal after it;
  - `mobile.spec.ts` at seven widths for the archived page and the list with the switch.
- **Smoke:** `scripts/smoke/suites/sponsors.ts` rows for archive, refuse, public HTML absent and present, `/s/` 404, the list default and `?archived=1`, unarchive, and the Free org.
- **Regression:**
  - delete still refused for history;
  - an invoice page opens for an archived sponsor;
  - PATCH `{archived_at}` cannot unarchive;
  - a new "Acme" is not hidden by an archived "Acme";
  - the On stream switch keeps its proportions.
- **Sign-off:** CI captures at 320, 768 and 1280, on a page at `:8765`, with the owner's verdict for each screen.

## 13. Open questions for the owner

1. **The blocking set (D9)** is wider than the three named states: it adds draft, awaiting approval and ended-but-still-due. **Recommendation:** keep it. Each of these can still go live or still asks for money, and the copy already says "settle".
2. **Where Archive sits (D20, §7.4).** Delete is on the list row, not the sponsor page. **Recommendation:** layout A (the card at the foot of the page). Should Delete also move to the page? Not in this feature.
3. **Archived rows as a trailing group (D19)** instead of greyed in place inside their tier group. **Recommendation:** the trailing group, judged in the sign-off screenshots.
4. **The Overview (D15)** keeps an archived sponsor only in periods where it has numbers. **Recommendation:** yes. The totals stay true, and there are no empty rows.
