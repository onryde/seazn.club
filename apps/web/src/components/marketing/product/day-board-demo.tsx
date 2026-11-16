"use client";

import { useState } from "react";
import { DAY_TEAMS, type DayBoardLabels } from "./day-board-labels";
import { COURTS, DELAY_STEP, MATCHES, MAX_DELAY, SLOTS, clockAt, delay, fillRest, isComplete, openingDay, pick, placeAt, publicRows, publish, type DayState, type Match } from "@/lib/marketing/day-board";

/**
 * The Scheduling page's working demo: a small day board. Tap a match, tap a free time; a move that would put a team in
 * two matches at once, or two matches on one court, is refused, as the real board refuses it. Publish, then push the
 * day back, and the "what players see" list moves with it. State and rules live in lib/marketing/day-board.ts.
 */

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function DayBoardDemo({ labels: l }: { labels: DayBoardLabels }) {
  const [day, setDay] = useState<DayState>(openingDay);
  const [justDelayed, setJustDelayed] = useState(false);
  const act = (next: DayState, delayed = false) => {
    setDay(next);
    setJustDelayed(delayed);
  };
  const name = (m: Match) => fill(l["match"], { home: DAY_TEAMS[m.home]!, away: DAY_TEAMS[m.away]! });
  const court = (c: number) => fill(l["court"], { n: c + 1 });
  const at = (c: number, s: number) => MATCHES.find((m) => day.placed[m.id]?.court === c && day.placed[m.id]?.slot === s);
  const tray = MATCHES.filter((m) => !day.placed[m.id]);
  const picked = MATCHES.find((m) => m.id === day.picked);
  const complete = isComplete(day);
  const rows = publicRows(day);

  const status = day.refused
    ? day.refused.kind === "team"
      ? fill(l["status.team"], { team: DAY_TEAMS[day.refused.team]! })
      : l["status.court"]
    : justDelayed && day.published
      ? fill(l["status.delayed"], { n: day.delayMinutes })
      : day.published
        ? l["status.published"]
        : picked
          ? fill(l["status.picked"], { match: name(picked) })
          : complete
            ? l["status.complete"]
            : l["status.start"];

  return (
    <div className="mkp-stage mkp-s2 mkp-s2r" data-testid="day-demo" data-published={day.published ? "true" : "false"} data-delay={day.delayMinutes}>
      <div className="mkp-tile">
        <small>
          <b>1</b>
          {l["board"]}
        </small>
        <div className="mkp-pad mkp-day">
          <div className="mkp-day-grid" style={{ gridTemplateColumns: `auto repeat(${COURTS}, minmax(0, 1fr))` }}>
            <span />
            {range(COURTS).map((c) => (
              <span className="mkp-day-h" key={c}>
                {court(c)}
              </span>
            ))}
            {range(SLOTS).map((s) => [
              <span className="mkp-day-t" key={`t${s}`}>
                {clockAt(s, day.delayMinutes)}
              </span>,
              ...range(COURTS).map((c) => {
                const m = at(c, s);
                const time = clockAt(s, day.delayMinutes);
                return m ? (
                  <button key={`${c}-${s}`} type="button" className="mkp-day-c mkp-day-on" data-testid={`day-cell-${c}-${s}`} data-match={m.id} aria-label={fill(l["lift"], { match: name(m), court: court(c), time })} onClick={() => act(pick(day, m.id))}>
                    {name(m)}
                  </button>
                ) : (
                  <button key={`${c}-${s}`} type="button" className="mkp-day-c" data-testid={`day-cell-${c}-${s}`} data-match="" aria-label={fill(l["place"], { court: court(c), time })} disabled={!picked} onClick={() => act(placeAt(day, { court: c, slot: s }))}>
                    {l["free"]}
                  </button>
                );
              }),
            ])}
          </div>

          <p className="mkp-day-k">{l["tray"]}</p>
          <div className="mkp-day-tray" data-testid="day-tray">
            {tray.length === 0 ? (
              <span className="mkp-day-none">{l["trayEmpty"]}</span>
            ) : (
              tray.map((m) => (
                <button key={m.id} type="button" className="mkp-day-chip" aria-pressed={day.picked === m.id} data-testid={`day-tray-${m.id}`} onClick={() => act(pick(day, m.id))}>
                  {name(m)}
                </button>
              ))
            )}
          </div>

          <div className="mkp-day-acts">
            <button type="button" data-testid="day-fill" disabled={complete} onClick={() => act(fillRest(day))}>
              {l["fill"]}
            </button>
            <button type="button" className="mkp-day-pub" data-testid="day-publish" disabled={!complete || day.published} onClick={() => act(publish(day))}>
              {l["publish"]}
            </button>
            <button type="button" data-testid="day-delay" disabled={day.delayMinutes >= MAX_DELAY} onClick={() => act(delay(day), true)}>
              {fill(l["delay"], { n: DELAY_STEP })}
            </button>
          </div>
          <p className={`mkp-badge${day.refused ? " mkp-off" : ""}`} role="status" aria-live="polite" data-testid="day-status" data-refused={day.refused?.kind ?? ""}>
            {status}
          </p>
        </div>
      </div>

      <div className="mkp-tile">
        <small>
          <b>2</b>
          {l["public"]}
        </small>
        <div className="mkp-day-pubcard" data-testid="day-public">
          {rows.length === 0 ? (
            <p className="mkp-day-none">{l["notPublished"]}</p>
          ) : (
            <>
              {day.delayMinutes > 0 ? (
                <p className="mkp-day-upd" data-testid="day-updated">
                  {fill(l["updated"], { n: day.delayMinutes })}
                </p>
              ) : null}
              <ol>
                {rows.map((r) => (
                  <li key={r.matchId} data-testid={`day-row-${r.matchId}`}>
                    <b>{r.time}</b>
                    <span>{name(MATCHES.find((m) => m.id === r.matchId)!)}</span>
                    <i>{court(r.court)}</i>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
