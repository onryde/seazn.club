import Link from "@/components/ui/console-link";
import { ChevronRight } from "lucide-react";
// The pure runtime, not `@/lib/i18n` (server-only): Match Day's client shell renders this same list (task A4) — reused, never
// copied. Only `t`/`plural` were ever read from there, and `@/lib/i18n` re-exports them from this module.
import { t, plural } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { ATTENTION_SEVERITY, type Attention, type DrawDoor, type Severity } from "@/lib/division-phase";
import type { DictionaryKey } from "@/lib/i18n-keys";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

export interface NeedsYouItem {
  key: string;
  severity: Severity;
  kind: Attention["kind"];
  title: string;
  sub: string;
  action: { label: string; href: string };
  /** A second, quieter way in, beside `action` (task B4): Match Day's "Find a court" on an unscheduled row (`withFindCourt`,
   *  lib/match-day/view.ts, set by the server). `court_id` is the court it opens (null: the page's list). The desk never sets
   *  one, so the competition page's rows are unchanged. */
  alt?: { label: string; href: string; court_id: string | null };
}

/** A Needs-you row's key: one row per division and kind. The ONE spelling, so a reader that adds to a division's row (Match Day's
 *  "Find a court", `withFindCourt`) finds it by the same function that named it, never by parsing the key. */
export function needsYouKey(divisionId: string, kind: Attention["kind"]): string {
  return `${divisionId}:${kind}`;
}

/**
 * M1 (fix round I, Critical — instance TWELVE): the `needs_draw` action
 * renders the PANEL'S OWN dictionary key, never a copy of its words.
 *
 * There used to be a `desk.needsYou.needs_draw.action` key reading "Compute
 * proposal" in all four locales, hand-copied from `progression.computeCta`.
 * Two things were wrong with that and only one of them was the copy. The
 * copy meant the row could name a button the panel was not showing — the
 * panel offers "Confirm proposal" for a draft and "Recompute" for a stale
 * one, and a fixed label is wrong in two of its three states. And a hand-
 * copied name drifts silently: nothing at any layer compares the two
 * strings. Pointing at the key the button itself renders removes both
 * failure modes by construction, and the dead key was deleted from the four
 * dictionaries.
 *
 * A `Record` over every door, not a ternary, so adding one is a COMPILE
 * error rather than a mislabelled action (phase-pill.tsx's `RED_PILL_KEY`
 * precedent, and the K1 defect that established it).
 */
export const DRAW_DOOR_KEY: Record<DrawDoor, DictionaryKey> = {
  compute: "progression.computeCta",
  confirm: "progression.confirmCta",
  recompute: "progression.recompute",
};

const SEV_ORDER: Severity[] = ["red", "amber", "slate"];
const DOT: Record<Severity, string> = { red: "bg-red-600", amber: "bg-amber-600", slate: "bg-slate-500" };

export function needsYouItems(
  dict: Dict,
  desk: CompetitionDesk,
  divisions: { id: string; name: string; slug: string }[],
  org: string,
  comp: string,
  locale: Locale,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  let waiting = 0;
  // Discipline (owner-approved 3A): pending bans, summed into ONE row like registrations — with the divisions they sit
  // in, in ledger order, so the row can name them and open the first one's Discipline tab.
  let bans = 0;
  const bansIn: { name: string; slug: string }[] = [];
  for (const d of divisions) {
    const dd = desk.divisions.get(d.id);
    if (!dd) continue;
    for (const a of dd.attention) {
      const sev = ATTENTION_SEVERITY[a.kind];
      switch (a.kind) {
        case "needs_draw":
          items.push({
            key: `${d.id}:needs_draw`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.needs_draw", { division: d.name, stage: a.stageName }),
            sub: t(dict, "desk.needsYou.needs_draw.sub"),
            action: { label: t(dict, DRAW_DOOR_KEY[a.door]), href: routes.division(org, comp, d.slug, "fixtures") },
          });
          break;
        // K1 (fix round G, Critical — instance NINE): the row that did not
        // exist. An open stage with nothing to play and no proposal to
        // compute — a knockout waiting to be seeded when the league before
        // it is completed, or a stage whose fixtures were never generated.
        // Both of its doors are on the division's fixtures tab.
        case "needs_fixtures":
          items.push({
            key: `${d.id}:needs_fixtures`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.needs_fixtures", { division: d.name, stage: a.stageName }),
            sub: t(dict, "desk.needsYou.needs_fixtures.sub"),
            action: { label: t(dict, "desk.needsYou.needs_fixtures.action"), href: routes.division(org, comp, d.slug, "fixtures") },
          });
          break;
        case "unscheduled":
          items.push({
            key: needsYouKey(d.id, "unscheduled"), severity: sev, kind: a.kind,
            // C2 fix (review round 3): was a bare `{n} fixtures unscheduled`
            // — "1 fixtures unscheduled" on the common end-of-scheduling
            // case. `plural()` picks the `.one`/`.other` form.
            title: plural(dict, "desk.needsYou.unscheduled", a.count, locale, { division: d.name }),
            sub: t(dict, "desk.needsYou.unscheduled.sub"),
            action: { label: t(dict, "desk.needsYou.unscheduled.action"), href: routes.divisionSchedule(org, comp, d.slug) },
          });
          break;
        // F3 fix (final review, Important): both cases below used to emit
        // ONE ROW PER FIXTURE — a division with 6 overdue fixtures produced
        // 6 identical rows (~900px at 320, ledger below the fold). The
        // resolver now hands one aggregated Attention per division; when it
        // names exactly one fixture the row still names the two teams and
        // deep-links straight to it (unchanged from before); with several,
        // the row states the count and the action goes to the fixtures tab,
        // which shows all of them — the same "several ⇒ somewhere that
        // shows all of them" pattern `unscheduled`/`needs_draw` already use.
        case "no_scorer": {
          const single = a.fixtureIds.length === 1 ? dd.fixture_names[a.fixtureIds[0]!] : null;
          items.push({
            key: `${d.id}:no_scorer`, severity: sev, kind: a.kind,
            title: single
              ? t(dict, "desk.needsYou.no_scorer", { division: d.name, home: single.home ?? "—", away: single.away ?? "—" })
              : plural(dict, "desk.needsYou.no_scorer.count", a.count, locale, { division: d.name }),
            // division-phase.ts:134 minor fix: `minutesSinceKickoff` is null
            // when none of the aggregated fixtures ever carried a
            // scheduledAt — a distinct sub-line, not a permanent "0 min ago".
            sub:
              a.minutesSinceKickoff !== null
                ? t(dict, "desk.needsYou.no_scorer.sub", { minutes: a.minutesSinceKickoff })
                : t(dict, "desk.needsYou.no_scorer.sub_unknown"),
            action: {
              label: t(dict, "desk.needsYou.no_scorer.action"),
              href: single
                ? routes.fixture(org, comp, d.slug, single.fixture_no)
                : routes.division(org, comp, d.slug, "fixtures"),
            },
          });
          break;
        }
        // F3 (round J). Deliberately NOT merged into `no_scorer`'s case even
        // though the shape is identical: the two rows say different things to
        // the organiser ("nominate someone" vs "your scorer has not started"),
        // and one case printing two different sets of words behind a boolean
        // is how a row ends up saying the wrong one.
        case "not_recording": {
          const single = a.fixtureIds.length === 1 ? dd.fixture_names[a.fixtureIds[0]!] : null;
          items.push({
            key: `${d.id}:not_recording`, severity: sev, kind: a.kind,
            title: single
              ? t(dict, "desk.needsYou.not_recording", { division: d.name, home: single.home ?? "—", away: single.away ?? "—" })
              : plural(dict, "desk.needsYou.not_recording.count", a.count, locale, { division: d.name }),
            // No `sub_unknown` twin, unlike `no_scorer`: `minutesSinceKickoff`
            // is a number by construction here (division-phase.ts refuses the
            // row when the elapsed time is unknown), so there is no state this
            // sub-line cannot state.
            sub: t(dict, "desk.needsYou.not_recording.sub", { minutes: a.minutesSinceKickoff }),
            action: {
              label: t(dict, "desk.needsYou.not_recording.action"),
              href: single
                ? routes.fixture(org, comp, d.slug, single.fixture_no)
                : routes.division(org, comp, d.slug, "fixtures"),
            },
          });
          break;
        }
        case "result_missing": {
          const single = a.fixtureIds.length === 1 ? dd.fixture_names[a.fixtureIds[0]!] : null;
          items.push({
            key: `${d.id}:result_missing`, severity: sev, kind: a.kind,
            title: single
              ? t(dict, "desk.needsYou.result_missing", { division: d.name, home: single.home ?? "—", away: single.away ?? "—" })
              : plural(dict, "desk.needsYou.result_missing.count", a.count, locale, { division: d.name }),
            sub: t(dict, "desk.needsYou.result_missing.sub"),
            action: {
              label: t(dict, "desk.needsYou.result_missing.action"),
              href: single
                ? routes.fixture(org, comp, d.slug, single.fixture_no)
                : routes.division(org, comp, d.slug, "fixtures"),
            },
          });
          break;
        }
        // W2a (addendum 9): a held bracket fixture — a level result or a recorded abandon that decided nobody. One
        // names its match and opens its console, whose Settle block serves both shapes (Task 11); several open the
        // fixtures tab, the same fallback the other aggregated rows take.
        case "needs_decision": {
          const single = a.fixtureIds.length === 1 ? dd.fixture_names[a.fixtureIds[0]!] : null;
          items.push({
            key: `${d.id}:needs_decision`, severity: sev, kind: a.kind,
            title: single
              ? t(dict, "desk.needsYou.needs_decision", { division: d.name, home: single.home ?? "—", away: single.away ?? "—" })
              : plural(dict, "desk.needsYou.needs_decision.count", a.count, locale, { division: d.name }),
            sub: t(dict, "desk.needsYou.needs_decision.sub"),
            action: {
              label: t(dict, "desk.needsYou.needs_decision.action"),
              href: single
                ? routes.fixture(org, comp, d.slug, single.fixture_no)
                : routes.division(org, comp, d.slug, "fixtures"),
            },
          });
          break;
        }
        case "registrations_waiting":
          waiting += a.count; // one competition-level row, not one per division
          break;
        case "bans_waiting":
          bans += a.count; // one competition-level row, not one per division
          bansIn.push({ name: d.name, slug: d.slug });
          break;
        default: {
          // Round J: this switch had no exhaustiveness guard, so a new
          // `Attention` kind compiled clean and rendered NOTHING — the inert
          // seam this programme keeps producing, one surface further on. tsc
          // now refuses a kind that reaches here without a case.
          const never: never = a;
          throw new Error(`unhandled attention kind: ${JSON.stringify(never)}`);
        }
      }
    }
  }
  if (waiting > 0) {
    items.push({
      key: "registrations", severity: "slate", kind: "registrations_waiting",
      // C3 fix (review round 3): was a bare `{n} registrations waiting for
      // approval` — "1 registrations waiting for approval".
      title: plural(dict, "desk.needsYou.registrations_waiting", waiting, locale),
      sub: t(dict, "desk.needsYou.registrations_waiting.sub"),
      // M1 enumeration (fix round I): the tab was MISSING — the hub's two
      // tabs are `settings` (its default) and `registrants`
      // (components/registration-hub-tab.ts), and the pending registration
      // this row is about is only on the second. "Review" landed on the
      // settings tab, one click short of the work, which is the same class
      // as instance twelve one surface over. Found by sweeping all six
      // action labels to their landing controls, not by a report.
      action: {
        label: t(dict, "desk.needsYou.registrations_waiting.action"),
        href: routes.competitionRegistration(org, comp, "registrants"),
      },
    });
  }
  if (bans > 0) {
    items.push({
      key: "bans", severity: ATTENTION_SEVERITY.bans_waiting, kind: "bans_waiting",
      title: plural(dict, "desk.needsYou.bans_waiting", bans, locale),
      // Names the divisions rather than counting them: there is no competition-level discipline page, so "Review"
      // opens ONE division's tab — the first listed — and the rest have to be findable from the row itself.
      sub: t(dict, "desk.needsYou.bans_waiting.sub", { divisions: bansIn.map((d) => d.name).join(", ") }),
      action: {
        label: t(dict, "desk.needsYou.bans_waiting.action"),
        href: routes.division(org, comp, bansIn[0]!.slug, "discipline"),
      },
    });
  }
  return items.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
}

// ---- Where the list lives (Match Day B1, spec 2026-10-31 §9: "Needs you lives in one place at a time") ----------------------

/** The two surfaces that can carry the Needs-you list. */
export type NeedsYouHome = "competition" | "match_day";

/**
 * Where the WHOLE Needs-you list lives, from the competition desk's `fixtures_today` (A2's `countFixturesToday`): in Match Day
 * on a match day — the same condition that puts Open Match Day on the competition page — and on the competition page before
 * the day. Never split, never in both: the competition page and Match Day each ask this one function.
 *
 * The empty case first: no match today is the competition page's. A count that is not one (negative, fractional, NaN) is a
 * broken read, not a day — refused, rather than silently landing the list on either surface.
 */
export function needsYouHome(fixturesToday: number): NeedsYouHome {
  if (!Number.isInteger(fixturesToday) || fixturesToday < 0) {
    throw new RangeError(`needsYouHome: fixtures_today must be a whole count, got ${fixturesToday}`);
  }
  if (fixturesToday === 0) return "competition";
  return "match_day";
}

/** The Needs-you rows `surface` shows: all of them when it is their home (`needsYouHome`), none otherwise. */
export function needsYouAt(surface: NeedsYouHome, fixturesToday: number, items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return needsYouHome(fixturesToday) === surface ? [...items] : [];
}

/** How many matches owe a result: the desk's `result_missing` attentions, summed across divisions. One sum for Match Day's
 *  `results_owed` (match-day.ts) and the competition page's line into Match Day, so the line's count is the one Match Day's
 *  header opens with (`needsYouCount`). */
export function resultsOwedOf(desk: Pick<CompetitionDesk, "divisions">): number {
  let owed = 0;
  for (const d of desk.divisions.values()) for (const a of d.attention) if (a.kind === "result_missing") owed += a.count;
  return owed;
}

export function NeedsYou({
  dict,
  items,
  onAlt,
}: {
  dict: Dict;
  items: NeedsYouItem[];
  /** A client island's own handling of a row's `alt` (Match Day opens the court in place); the link's `href` still works
   *  without it — opened in a new tab, or before the island hydrates. */
  onAlt?: (item: NeedsYouItem) => void;
}) {
  if (items.length === 0) return null;
  const altLink = (it: NeedsYouItem, className: string) =>
    it.alt === undefined ? null : (
      <Link
        href={it.alt.href}
        data-needs-you-alt
        onClick={
          onAlt === undefined
            ? undefined
            : (e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onAlt(it);
              }
        }
        className={className}
      >
        {it.alt.label}
      </Link>
    );
  return (
    <section data-testid="desk-needs-you" className="mb-6">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-slate-600">
        {t(dict, "desk.needsYou.title")} · {items.length}
      </h2>
      <div className="card divide-y divide-purple-50">
        {items.map((it) => (
          <div key={it.key} data-attention={it.kind} data-severity={it.severity}>
            {/* Mobile (owner ruling, review round 1): the old layout centred
                the dot against a wrapped multi-line title and squeezed the
                text beside the button. Restacked instead — dot + title on
                one line, sub-line beneath, then a full-width, >=44px action
                under both. */}
            <div className="p-4 md:hidden">
              <div className="flex items-center gap-2">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[it.severity]}`} />
                <p className="min-w-0 flex-1 text-sm text-slate-900">{it.title}</p>
              </div>
              <p className="mt-1 text-xs text-slate-600">{it.sub}</p>
              <Link
                href={it.action.href}
                className={`btn ${it.severity === "red" ? "btn-primary" : "btn-ghost"} mt-3 flex w-full items-center justify-center py-3 text-sm`}
              >
                {it.action.label}
              </Link>
              {altLink(
                it,
                "mt-1 flex min-h-11 w-full items-center justify-center rounded-lg text-sm font-medium text-purple-700 underline-offset-2 hover:underline",
              )}
            </div>
            {/* Desktop, `md` and up — unchanged three-column layout. */}
            <div className="hidden items-center gap-3 px-4 py-3 md:flex">
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[it.severity]}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-900">{it.title}</p>
                <p className="text-xs text-slate-600">{it.sub}</p>
              </div>
              {/* Loop R M7(e): this row shows from md (768), and 768 and 834 are touch widths — 44px there; the compact
                  28px button only from lg, a mouse width. */}
              {altLink(
                it,
                "inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-xs font-medium text-purple-700 underline-offset-2 hover:underline lg:min-h-0 lg:py-1.5",
              )}
              <Link href={it.action.href} className={`btn ${it.severity === "red" ? "btn-primary" : "btn-ghost"} min-h-11 shrink-0 px-3 py-1.5 text-xs lg:min-h-0`}>
                {it.action.label}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The competition page's one line on a match day (B1, spec §9: "N things need you, in Match Day"), in place of the list it
 * would otherwise show: the whole list lives in Match Day then. One full-width row, the most urgent row's colour on its dot,
 * at the tap floor at every width. The arrow is an icon, not a character in the copy, so no locale carries punctuation that
 * only reads left to right.
 */
export function NeedsYouInMatchDay({ href, label, severity }: { href: string; label: string; severity: Severity }) {
  return (
    <Link
      href={href}
      data-testid="desk-needs-you-in-match-day"
      data-severity={severity}
      className="card mb-6 flex min-h-11 items-center gap-3 px-4 py-3 text-sm text-slate-900 transition-colors hover:bg-purple-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
    >
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[severity]}`} />
      <span className="min-w-0 flex-1">{label}</span>
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.75} />
    </Link>
  );
}
