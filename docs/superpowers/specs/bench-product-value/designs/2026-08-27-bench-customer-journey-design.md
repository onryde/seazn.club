# Bench: registration funnel + customer-journey suite — design

Date: 2026-08-27. Status: approved in brainstorm, awaiting owner spec review.
Amends the scheduler bench spec of record
(`2026-08-12-scheduler-bench-design.md`) — additive; nothing there is
re-derived here. Prompts: `../bench-prompts/B03r-registration-layer.md`,
`B16-pack-club-open.md`, and an amendment to `B18-full-run-closeout.md`
(all to be authored after this spec is approved).

## 1. Why

The bench today proves scheduling + scoring for entrants that were
**admin-seeded** (B03). A real customer never admin-seeds: they create a
competition, put restrictions on divisions (U16, Mixed Doubles, Men's),
publish a registration link, some divisions charge a fee, captains enter
and pay, teammates join, the organiser approves, and only then are there
entrants to schedule and matches to play.

Owner ruling (2026-08-27): **the bench must prove the product works the
way a customer uses it.** So the bench gains (a) a registration entry
path and (b) one suite that runs the entire journey through product
surfaces — including the scoring pad — with zero API shortcuts where a
UI exists.

## 2. Decisions (closed — do not re-open)

| # | Decision | Ruling |
|---|---|---|
| D1 | Sequencing | Registration leg waits for **RS007, RS008, RS009, RS011, RS010 merged**. Owner: "I can wait for finishing all RS." |
| D2 | Which suites register | End state = every suite *can* (Q2-C), delivered as: suite 13 *must* every run; suites 1–12 admin-seeded by default, register via `--entry registration` (API path, free/open/auto) in B18 and on demand, report-only. |
| D3 | Paid divisions | **Real Stripe test mode** — Connect fixture `acct_1U8o7FBlv9TBkyYa`, hosted Checkout driven in a browser with a test card, `stripe listen` forwards `checkout.session.completed`. No synthetic webhooks. |
| D4 | Organiser-side steps gated | manual approve/reject, eligibility rejection (RS011 + public-time), waitlist + promote + pay-on-promotion, join code + consent. Free-agent assignment is **report-only** in v1. |
| D5 | Suite shape | One fictional club org, one competition, four divisions (§4). |
| D6 | One pipeline, not two | Registration is an entry mode of `seed.ts`; everything downstream (schedule, checker, simulate, oracles) is the existing bench. No separate "registration bench". |
| D7 | Customer journey = UI-first | Suite 13 drives every step through the product UI (Playwright). Suites 1–12 stay API-first (engine/scheduler bench). Bench never *builds* UI; it *drives* it. The bench is not CI-wired, so runtime and browser fragility are accepted costs. |
| D8 | Playing | Suite 13 plays every match on **ScoringPad v3, tapped**. Suites 1–12 keep B05 event-stream POSTs. |
| D9 | Stripe ruling scoped | "No Stripe involved" (bench spec `:116`) stays true for entitlements (`setPlan` SQL). Suite 13 is the single sanctioned Stripe surface in the bench, test mode only. |
| D10 | Provenance | New enum value `synthetic` for suite 13's event streams and entry layer. Additive PackSchema change, escalated in the B03r PR (frozen-schema rule). |

## 3. Entry modes

`divisions[].entry: "admin" | "registration-api" | "registration-ui"`
(default `admin`). CLI `--entry admin|registration` overrides every
division of every selected suite: `registration` resolves to
`registration-api` for suites 1–12 and leaves suite 13 on
`registration-ui`. Historical suites under `--entry registration`
register free / open / auto-approve — no restrictions, no fees, no
Stripe — as a **volume pass**.

One `Captain` / `Player` / `Organiser` / `Scorer` driver interface, two
implementations:

- `http` — cookie-jar sessions over `lib/http.ts` (B01). Used by
  `registration-api`.
- `browser` — Playwright Chromium, one context per person, parallel
  across captains, strictly sequential within a division's organiser
  action list and within a fixture's pad taps (`expected_seq` rule).
  Used by `registration-ui` and by suite 13's organiser + scorer legs.

Funnel oracle, organiser action sequence, and stage-0 validation are
shared; only the driver differs.

## 4. Pack contract (additive)

```ts
persons[].dob?: string        // ISO date; required when any division the
persons[].gender?: "m"|"f"    // person enters carries an age band / category

divisions[].entry: "admin" | "registration-api" | "registration-ui"
divisions[].registration?: {
  category: "open"|"mens"|"womens"|"mixed",
  age_min?: number, age_max?: number,
  entrant_kind: "team"|"individual"|"pair",
  fee_cents: number, currency: string,
  approval: "auto"|"manual", capacity?: number,
  entries: [{
    ext_key: string, captain: string /* person ext_key */,
    roster: string[], pay: boolean,
    expect: "entrant"|"rejected_eligibility"|"waitlisted"|"rejected_manual"
  }],
  joins:     [{ entry: string, person: string, consent: "granted"|"guardian" }],
  organiser: [{ action: "approve"|"reject"|"promote"|"assign_free_agent", target: string }],
  expect: { entrants: number, waitlisted: number, rejected: number, paid_cents: number }
}
```

Maps onto `registration_settings` (per-division PK, V118: `entrant_kind`,
`capacity`, `fee_cents`, `currency`, `opens_at/closes_at`) and
`divisions.category` / `age_min` / `age_max` (V364). Free division ⇔
`fee_cents = 0`.

**Stage-0 (offline, before any HTTP)** additionally checks: every
`rejected_eligibility` entry actually violates its division's
restriction given the persons' `dob`/`gender` (else the pack lies);
`expect` arithmetic = entries − rejections − waitlisted; `capacity` vs
admitted entries produces exactly the declared waitlist; `pay:true`
requires `fee_cents > 0`; `entry:registration-*` with an age band or
category requires `dob`/`gender` on every entering person. Any failure
dies in seconds.

## 5. Suite 13 — "Club Open" (customer journey)

Org: fictional "Riverside Sports Club". One competition. Four divisions:

| Division | Sport | Restriction | Kind | Fee | Approval | Entries | Offender | Cap → waitlist | Organiser actions | Format |
|---|---|---|---|---|---|---|---|---|---|---|
| U16 Singles | badminton | `age_max 15` | individual | free | auto | 16 | 1 over-age | — | none | KO (15 matches) |
| Mixed Doubles | badminton | `mixed` | pair | paid | auto | 6 pairs + 2 free agents | 1 M+M pair | — | assign free agents (report-only) | RR (15) |
| Open Men's 5s | football | `mens` | team | paid | manual | 10 teams × 6 | 1 team with a woman on roster (blocked at submit → 9) | 8 → 1 waitlisted | approve ×7, reject ×1, promote ×1 (promoted captain pays) → 8 entrants | 2 groups + final (13) |
| Women's Open | tennis | `womens` | individual | free | manual | 8 | 1 male entry | — | approve ×7 | KO (7) |

~50 matches, ~5k pad taps. A few persons play two divisions →
career-rollup oracle applies.

### 5.1 Journey (every row is a product surface; no API where a UI exists)

| Step | Actor | Surface |
|---|---|---|
| Sign up, create org | organiser | signup / magic-link |
| Create competition + 4 divisions with restrictions | organiser | competition + division forms |
| Registration settings per division | organiser | hub Settings tab (RS004) |
| Enter (stepper); pay via Checkout test card | captain | public `/shared/<org>/<comp>/register`, status page (RS006/RS007) |
| Join by code; consent (incl. guardian) | teammate / guardian | join route, consent link (RS007/RS008) |
| Approve / reject / promote / assign free agent | organiser | hub Registrants tab (RS005/RS007/RS009) |
| Generate fixtures, auto-schedule, resolve conflicts | organiser | board toolbar (#650) |
| Play every match | scorer | ScoringPad v3, tapped |
| Results, tables, champion | public | public standings / results pages |

Oracles are read back through public pages **and** the API; the
independent checker (B04) still recomputes conflicts from fetched
fixtures. Entrants produced by registration reach B04 exactly as
admin-seeded ones do (`ext_key` matching) — the scheduling layer must not
know the difference.

### 5.2 Funnel oracle (gated)

Per registration division: entrant count == `expect.entrants`; each
offender's status == its `expect`; waitlist count; Σ paid
`registration_groups.amount_cents` == `expect.paid_cents`; every
`rejected_eligibility` offender is blocked at public submit **and**
blocked if the organiser tries to force it in (RS011). An expected
rejection that succeeds reds as "offender admitted".

### 5.3 Error handling

Unexpected 4xx/5xx or a failed UI step → red, response body /
screenshot + Playwright trace attached to the report. Stripe/Checkout
failure → red with `stripe listen` output. Paid-status poll timeout → red
(an unpaid entry is a wrong *state*, not a slow one). `--keep` leaves the
org browsable, including the hub Registrants tab, and keeps traces.
Funnel wall-time and pad-tapping wall-time are **report-only**, never
gated (load-sensitive-timing rule).

## 6. Pre-flight additions (`lib/env.ts`)

`STRIPE_SECRET_KEY` with a test-mode prefix; `STRIPE_CONNECT_TEST_ACCOUNT`;
`stripe listen` reachable (webhook secret present); Playwright Chromium
installed. Missing → abort **only if** a selected division has
`pay:true` or `entry:registration-ui`; otherwise warn. `playwright` is
already a root dependency (`package.json`, `^1.61.1`) — only the Chromium
binary check is new. Bench code runs under `--experimental-strip-types`,
so browser drivers use plain `playwright`, never `@playwright/test`, and
helpers lifted from `apps/web/e2e/walkthrough/` are copied without TS-only
constructs (enum trap).

## 7. Report additions (`lib/report.ts`)

Per registration division: entries / entrants / waitlisted / rejected
(eligibility vs manual) / paid cents / funnel wall-time / pad wall-time.
Under `--entry registration` for suites 1–12 the same table appears in a
"Registration at volume" section with no gates. B18 commits the first
such pass as the baseline.

## 8. Sessions and sequencing

| Session | What | Depends on |
|---|---|---|
| **B03r** registration layer | `scripts/bench/lib/register.ts` + `lib/drivers/{http,browser}/`; PackSchema block (§4) + `synthetic` provenance (escalated); stage-0 funnel checks; `--entry` flag; pre-flight (§6); report (§7); `_tiny` gains one `registration-ui` free division | B03; **RS007–RS011 + RS010 merged** |
| **B16** suite 13 | pack `club-open.json` + `build-packs/club-open.ts`, journey run, funnel + result oracles; standing "does my product work for a customer" smoke via `--suite club-open` | B03r, B05, B06 pilot; parallel-safe with B07–B15 |
| **B18** (amended) | adds one `--entry registration` full pass + "Registration at volume" baseline | all |

```
RS010 ──► B03r
B03 ──► B03r ──► B04 ──► B05 ──► B06 ──► B07..B15 ‖ B16 ──► B17 ──► B18
```

## 9. Testing (bench `_RULES.md` §1 — all four types)

- **Unit**: registration-block fold (offender detection, `expect`
  arithmetic), `http` driver request shapes against recorded fixtures,
  report renderer.
- **Regression**: stage-0 rejects a pack whose offender does not violate
  its restriction; rejects `pay:true` with `fee_cents:0`; rejects
  `registration-*` under an age band with null `dob`.
- **Smoke**: `_tiny` suite's new `registration-ui` division (2 entries,
  1 approve, no Stripe) in the daily tiny run. Browser drivers have no
  meaningful unit test (no jsdom rule) — this is their floor.
- **E2E**: the B16 journey run; one B18 `--entry registration` pass.

## 10. Out of scope / follow-up rule

Live-mode Stripe; UI-driven registration for suites 1–12; new app
features. Any product defect the journey finds → RS follow-up issue and
a separate PR, never patched inside a bench PR (blast-radius rule).
`--play ui` for other suites is a later option, not part of this spec.
