"use client";

import { useState } from "react";
import type { MatchDayDemoLabels } from "./match-day-demo-labels";
import { MATCHES, blockedBy, call, nextFor, openingDay, result, start, streamOf, undoCall, type DayState } from "@/lib/marketing/match-day";

/**
 * The working demo on the Match Day page: three courts and a line of matches. Call a match from the desk and the
 * volunteer's phone and each court's camera follow. The day itself is lib/marketing/match-day.ts; this island only
 * draws it. Rendered on the server at the opening day (one match playing, two courts free).
 */

/** Which courts have a camera phone linked: the third has none, so it never streams. */
const LINKED = [true, true, false] as const;
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function MatchDayDemo({ labels: l, teams }: { labels: MatchDayDemoLabels; teams: readonly string[] }) {
  const [day, setDay] = useState<DayState>(openingDay);
  const court = (i: number) => fill(l.court, { n: i + 1 });
  const name = (id: string) => fill(l.vs, { a: teams[MATCHES[id]!.a]!, b: teams[MATCHES[id]!.b]! });
  const next = nextFor(day);
  const held = day.waiting.find((id) => blockedBy(day, id) !== null);
  const heldNote = (() => {
    if (!held) return null;
    const at = blockedBy(day, held)!;
    const c = day.courts[at]!;
    const on = c.kind === "free" ? null : MATCHES[c.match]!;
    const m = MATCHES[held]!;
    const team = on && [m.a, m.b].find((x) => x === on.a || x === on.b);
    return team === null || team === undefined ? null : fill(l.blocked, { match: name(held), team: teams[team]!, court: court(at) });
  })();
  const last = day.last;

  return (
    <div className="mkp-stage" data-testid="md-demo">
      <div className="mkp-tile mkp-t-pad">
        <small>
          <b>1</b>
          {l["desk.label"]}
        </small>
        <div className="mkp-pad mkp-mdpad">
          {day.courts.map((c, i) => (
            <div key={i} className="mkp-mdcourt" data-testid={`md-court-${i}`} data-court-state={c.kind}>
              <div className="mkp-mdcourt-h">
                <b>{court(i)}</b>
                <span className={`mkp-mdpill mkp-md-${c.kind}`}>{l[`state.${c.kind}`]}</span>
              </div>
              {c.kind === "free" ? (
                next ? (
                  <>
                    <p data-testid="md-next">{fill(l.next, { match: name(next) })}</p>
                    <button type="button" className="mkp-key mkp-p" data-act="call" onClick={() => setDay(call(day, i))}>
                      {l["act.call"]}
                    </button>
                  </>
                ) : (
                  <p>{l["act.none"]}</p>
                )
              ) : (
                <>
                  <p>{name(c.match)}</p>
                  {c.kind === "called" ? (
                    <div className="mkp-mdkeys">
                      <button type="button" className="mkp-key mkp-p" data-act="start" onClick={() => setDay(start(day, i))}>
                        {l["act.start"]}
                      </button>
                      <button type="button" className="mkp-key" data-act="undo" onClick={() => setDay(undoCall(day, i))}>
                        {l["act.undo"]}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="mkp-key" data-act="result" onClick={() => setDay(result(day, i))}>
                      {l["act.result"]}
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
          {heldNote ? (
            <p className="mkp-mdheld" data-testid="md-held">
              {heldNote}
            </p>
          ) : null}
          <div className="mkp-dealfoot">
            <span data-testid="md-waiting" data-waiting={day.waiting.length}>
              {fill(l.waiting, { n: day.waiting.length })} · <span data-testid="md-done">{fill(l.done, { n: day.done.length })}</span>
            </span>
            <button type="button" data-testid="md-reset" onClick={() => setDay(openingDay())}>
              {l.reset}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile">
        <small>
          <b>2</b>
          {l["phone.label"]}
        </small>
        <div className="mkp-mdphone" data-testid="md-phone">
          <strong>{l["phone.heading"]}</strong>
          <p className="mkp-mdevent" aria-live="polite" data-testid="md-event" data-event={last?.type ?? ""}>
            {last ? fill(l[`event.${last.type}`], { court: court(last.court), match: name(last.match) }) : l["event.none"]}
          </p>
          <ul>
            {day.courts.map((c, i) => (
              <li key={i} data-phone-state={c.kind}>
                <i className={`mkp-md-${c.kind}`} />
                <b>{court(i)}</b>
                <span>{c.kind === "free" ? l["phone.free"] : name(c.match)}</span>
                <em>{c.kind === "called" ? l["phone.called"] : l[`state.${c.kind}`]}</em>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mkp-tile">
        <small>
          <b>3</b>
          {l["stream.label"]}
        </small>
        <ul className="mkp-mdcams" data-testid="md-cams">
          {day.courts.map((c, i) => {
            const st = streamOf(day, i, LINKED);
            return (
              <li key={i} data-stream={st}>
                <b>{court(i)}</b>
                <span>{st === "live" && c.kind !== "free" ? name(c.match) : " "}</span>
                <em>{l[`stream.${st}`]}</em>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
