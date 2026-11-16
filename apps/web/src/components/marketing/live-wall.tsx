// The /live wall: every discoverable in-play fixture as a scorebug card on the page's night band. Server-rendered from
// public_discovery_v data only: real fixtures, or an honest empty state with the "start your own" banner. Never
// filler, and never the demo club (owner, 2026-11-16).
import Link from "next/link";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";
import { sportEmoji } from "@/components/discovery-cards";
import { t, type Dict } from "@/lib/i18n";
import { plural } from "@/lib/i18n-runtime";
import type { Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";

export function LiveWall({ fixtures, dict, lang }: { fixtures: DiscoveryLiveFixture[]; dict: Dict; lang: Locale }) {
  return (
    <section aria-label={t(dict, "live.wall.aria")} className="mkp-wall">
      {fixtures.length === 0 ? (
        <div className="mkp-wall-empty">
          <div>
            <p className="mkp-wall-t">{t(dict, "live.wall.emptyTitle")}</p>
            <p className="mkp-wall-b">{t(dict, "live.wall.emptyBody")}</p>
          </div>
          <div className="mkp-wall-start" data-testid="live-start">
            <p className="mkp-wall-t">{t(dict, "live.start.title")}</p>
            <p>{t(dict, "live.start.body")}</p>
            <Link href={`/${lang}/start`} className="mkp-btn">
              {t(dict, "live.start.button")}
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="mkp-wall-count">
            <span className="chip-pulse-dot" aria-hidden />
            {plural(dict, "live.wall.count", fixtures.length, lang)}
          </p>
          <ul className="mkp-wall-grid">
            {fixtures.map((f) => (
              <li key={f.id}>
                <Link href={routes.publicFixture(f.org_slug, f.comp_slug, f.division_slug, f.id)} className="mkp-wall-card">
                  <span className="mkp-wall-comp">
                    <span aria-hidden>{sportEmoji(f.sport_key)}</span>
                    <span>{f.competition_name}</span>
                  </span>
                  <span className="mkp-wall-score">
                    <span>{f.headline ?? t(dict, "discovery.inPlay")}</span>
                    {f.strength ? <i>{f.strength}</i> : null}
                  </span>
                  <span className="mkp-wall-watch">{t(dict, "live.wall.watch")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
