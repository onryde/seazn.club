"use client";

import { useState } from "react";
import type { FormatDemoLabels } from "./format-demo-labels";
import { FORMAT_DEMO_LIMITS, FORMAT_DEMO_MINUTES, FORMAT_DEMO_START } from "./format-demo-config";
import { bestFitSlug, rankFormats } from "@/lib/format-recommend";
import { funnelFormatMin } from "@/lib/funnel-formats";

/**
 * The Format page's working demo: say how many teams, pitches and hours you have, and see which formats fit. This is
 * NOT a model of the product: it calls the product's own recommender (`rankFormats` / `bestFitSlug`,
 * lib/format-recommend.ts), the same functions the setup wizard's format cards use, so the matches, hours and Best fit
 * shown here are exactly what an organiser gets after signing up. Rendered on the server at the opening day.
 */

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
type Knob = keyof typeof FORMAT_DEMO_LIMITS;
const KNOBS: Knob[] = ["entrants", "courts", "hours"];

export function FormatDemo({ labels: l }: { labels: FormatDemoLabels }) {
  const [day, setDay] = useState(FORMAT_DEMO_START);
  const ranked = rankFormats(day);
  const best = bestFitSlug(ranked);
  const step = (knob: Knob, by: number) => {
    const [min, max] = FORMAT_DEMO_LIMITS[knob];
    setDay({ ...day, [knob]: Math.min(max, Math.max(min, day[knob] + by)) });
  };

  return (
    <div className="mkp-stage mkp-s2" data-testid="format-demo">
      {/* Not `mkp-t-pad`: that class sends a scoring pad below its screens on a phone. Here the controls come first. */}
      <div className="mkp-tile">
        <small>
          <b>1</b>
          {l["entrants"]} · {l["courts"]} · {l["hours"]}
        </small>
        <div className="mkp-pad mkp-knobs">
          {KNOBS.map((knob) => {
            const [min, max] = FORMAT_DEMO_LIMITS[knob];
            return (
              <div className="mkp-knob" key={knob}>
                <span>{l[knob]}</span>
                <div>
                  <button type="button" aria-label={fill(l["stepper.less"], { label: l[knob] })} disabled={day[knob] <= min} data-testid={`format-${knob}-less`} onClick={() => step(knob, -1)}>
                    −
                  </button>
                  <output data-testid={`format-${knob}`} aria-live="polite">
                    {day[knob]}
                  </output>
                  <button type="button" aria-label={fill(l["stepper.more"], { label: l[knob] })} disabled={day[knob] >= max} data-testid={`format-${knob}-more`} onClick={() => step(knob, 1)}>
                    +
                  </button>
                </div>
              </div>
            );
          })}
          <div className="mkp-knob mkp-knob-m">
            <span id="mkp-minutes">{l["minutes"]}</span>
            <div role="group" aria-labelledby="mkp-minutes">
              {FORMAT_DEMO_MINUTES.map((m) => (
                <button key={m} type="button" className="mkp-min" aria-pressed={day.matchMinutes === m} data-testid={`format-minutes-${m}`} onClick={() => setDay({ ...day, matchMinutes: m })}>
                  {fill(l["minutesValue"], { n: m })}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mkp-tile">
        <small>
          <b>2</b>
          {l["cards"]}
        </small>
        <ul className="mkp-fmts">
          {ranked.map((r) => {
            const f = l.formats[r.slug];
            const state = !r.available ? "unavailable" : r.fits ? "fits" : "over";
            return (
              <li key={r.slug} className={`mkp-fmt mkp-fmt-${state}${best === r.slug ? " mkp-fmt-best" : ""}`} data-testid={`format-card-${r.slug}`} data-state={state} data-best={best === r.slug ? "true" : "false"}>
                <div>
                  <b>{f.name}</b>
                  <span>{f.tagline}</span>
                </div>
                <div className="mkp-fmt-n">
                  {r.available ? (
                    <>
                      <b data-testid={`format-card-${r.slug}-matches`}>{fill(l[r.matches === 1 ? "matchesCount.one" : "matchesCount.other"], { count: r.matches })}</b>
                      <span>
                        {fill(l["estHours"], { hours: r.estHours })} · {fill(l["perEntrant"], { n: r.perEntrant })}
                      </span>
                    </>
                  ) : (
                    <span>{fill(l["needsAtLeast"], { min: funnelFormatMin(r.slug) })}</span>
                  )}
                </div>
                {r.available ? <i className="mkp-fmt-b">{best === r.slug ? l["bestFit"] : r.fits ? l["fits"] : l["runsOver"]}</i> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
