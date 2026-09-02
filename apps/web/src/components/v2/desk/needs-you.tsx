import Link from "@/components/ui/console-link";
import { t, plural } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { ATTENTION_SEVERITY, type Attention, type Severity } from "@/lib/division-phase";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

export interface NeedsYouItem {
  key: string;
  severity: Severity;
  kind: Attention["kind"];
  title: string;
  sub: string;
  action: { label: string; href: string };
}

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
            action: { label: t(dict, "desk.needsYou.needs_draw.action"), href: routes.division(org, comp, d.slug, "fixtures") },
          });
          break;
        case "unscheduled":
          items.push({
            key: `${d.id}:unscheduled`, severity: sev, kind: a.kind,
            // C2 fix (review round 3): was a bare `{n} fixtures unscheduled`
            // — "1 fixtures unscheduled" on the common end-of-scheduling
            // case. `plural()` picks the `.one`/`.other` form.
            title: plural(dict, "desk.needsYou.unscheduled", a.count, locale, { division: d.name }),
            sub: t(dict, "desk.needsYou.unscheduled.sub"),
            action: { label: t(dict, "desk.needsYou.unscheduled.action"), href: routes.divisionSchedule(org, comp, d.slug) },
          });
          break;
        case "no_scorer": {
          const f = dd.fixture_names[a.fixtureId];
          items.push({
            key: `${d.id}:no_scorer:${a.fixtureId}`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.no_scorer", { division: d.name, home: f?.home ?? "—", away: f?.away ?? "—" }),
            sub: t(dict, "desk.needsYou.no_scorer.sub", { minutes: a.minutesSinceKickoff }),
            action: { label: t(dict, "desk.needsYou.no_scorer.action"), href: routes.fixture(org, comp, d.slug, f?.fixture_no ?? 0) },
          });
          break;
        }
        case "result_missing": {
          const f = dd.fixture_names[a.fixtureId];
          items.push({
            key: `${d.id}:result_missing:${a.fixtureId}`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.result_missing", { division: d.name, home: f?.home ?? "—", away: f?.away ?? "—" }),
            sub: t(dict, "desk.needsYou.result_missing.sub"),
            action: { label: t(dict, "desk.needsYou.result_missing.action"), href: routes.fixture(org, comp, d.slug, f?.fixture_no ?? 0) },
          });
          break;
        }
        case "registrations_waiting":
          waiting += a.count; // one competition-level row, not one per division
          break;
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
      action: { label: t(dict, "desk.needsYou.registrations_waiting.action"), href: routes.competitionRegistration(org, comp) },
    });
  }
  return items.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
}

export function NeedsYou({ dict, items }: { dict: Dict; items: NeedsYouItem[] }) {
  if (items.length === 0) return null;
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
            </div>
            {/* Desktop, `md` and up — unchanged three-column layout. */}
            <div className="hidden items-center gap-3 px-4 py-3 md:flex">
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[it.severity]}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-900">{it.title}</p>
                <p className="text-xs text-slate-600">{it.sub}</p>
              </div>
              <Link href={it.action.href} className={`btn ${it.severity === "red" ? "btn-primary" : "btn-ghost"} shrink-0 px-3 py-1.5 text-xs`}>
                {it.action.label}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
