"use client";

import { useRef, useState } from "react";
import type { TennisDemoLabels } from "./tennis-demo-labels";
import { calls, matchWinner, openingTennis, point, setsWon, undo, type Side, type TennisRules, type TennisState } from "@/lib/marketing/tennis-match";

/**
 * The working demo on the tennis page: tap a point and the match page, the table and the stream overlay move. One
 * `TennisState` (lib/marketing/tennis-match.ts) drives every tile; `rules` are the engine's point calls and match
 * length, read on the server. Rendered on the server at the opening state.
 */

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const SIDES: Side[] = ["a", "b"];
const TINT: Record<Side, string> = { a: "#15803d", b: "#b45309" };

export function TennisDemo({ labels: l, teams, others, rules }: { labels: TennisDemoLabels; teams: Record<Side, string>; others: readonly [string, string]; rules: TennisRules }) {
  const [s, setS] = useState<TennisState>(() => openingTennis(rules));
  const [pulse, setPulse] = useState(0);
  const calm = useRef<boolean | null>(null);

  const act = (next: TennisState) => {
    if (next === s) return;
    setS(next);
    if (calm.current === null) calm.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm.current) setPulse((n) => n + 1);
  };

  const winner = matchWinner(s, rules);
  const won = setsWon(s);
  const call = calls(s, rules, l.ad);
  const games = { a: s.ga, b: s.gb };
  const setNo = winner ? s.sets.length : s.sets.length + 1;
  const status = winner ? fill(l["mc.won"], { team: teams[winner] }) : fill(l["mc.status"], { n: setNo, a: s.ga, b: s.gb });
  const flash = (name: string) => (pulse ? `mkp-${name} mkp-flash` : `mkp-${name}`);
  // The set columns each side shows: every finished set, then the open one while the match is live.
  const columns = (side: Side) => [...s.sets.map(([a, b]) => (side === "a" ? a : b)), ...(winner ? [] : [games[side]])];

  const table = [
    { name: others[0], w: 1, l: 0, me: false },
    { name: others[1], w: 0, l: 1, me: false },
    ...SIDES.map((side) => ({ name: teams[side], w: winner === side ? 1 : 0, l: winner && winner !== side ? 1 : 0, me: side === "a" })),
  ].sort((x, y) => y.w - x.w || x.l - y.l);

  return (
    <div className="mkp-stage" data-testid="tennis-demo" data-tennis-winner={winner ?? ""}>
      <div className="mkp-tile mkp-t-pad" data-testid="tennis-tile-pad">
        <small>
          <b>1</b>
          {l["pad.label"]}
        </small>
        <div className="mkp-pad">
          <div className="mkp-bug">
            <div className="mkp-bug-t">{fill(l["pad.format"], { bestOf: rules.bestOf, n: setNo })}</div>
            <div className="mkp-bug-m">
              {SIDES.map((side) => (
                <div key={side}>
                  <small>{teams[side]}</small>
                  <b data-testid={`tennis-call-${side}`}>{winner ? won[side] : call[side]}</b>
                </div>
              ))}
            </div>
            <div className="mkp-bug-b" data-testid="tennis-games">
              {fill(l["pad.games"], { a: games.a, b: games.b, sa: won.a, sb: won.b })}
            </div>
          </div>
          <div className="mkp-keys mkp-keys2">
            {SIDES.map((side) => (
              <button key={side} type="button" className="mkp-key mkp-p" data-testid={`tennis-point-${side}`} onClick={() => act(point(s, side, rules))}>
                {fill(l["pad.point"], { team: teams[side] })}
              </button>
            ))}
          </div>
          <div className="mkp-last">
            <span data-testid="tennis-last" aria-live="polite">
              {winner ? fill(l["mc.won"], { team: teams[winner] }) : s.last ? fill(l["pad.last"], { team: teams[s.last] }) : l["pad.lastNone"]}
            </span>
            <button type="button" data-testid="tennis-undo" onClick={() => act(undo(s))}>
              {l["pad.undo"]}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-mc" data-testid="tennis-tile-matchCentre">
        <small>
          <b>2</b>
          {l["mc.label"]}
        </small>
        <div key={`mc-${pulse}`} className={flash("mc")}>
          <div className="mkp-mc-l">
            <i />
            {winner ? l["mc.final"] : l["mc.live"]}
          </div>
          {SIDES.map((side) => (
            <div className="mkp-mc-r" key={side}>
              <span>
                <i style={{ background: TINT[side] }}>{initials(teams[side])}</i>
                <u>{teams[side]}</u>
              </span>
              <b>
                {columns(side).map((g, i) => (
                  <span key={i} className="mkp-sets" data-testid={`tennis-setcol-${side}`}>
                    {g}
                  </span>
                ))}
                {winner ? null : <span data-testid={`tennis-mc-call-${side}`}>{call[side]}</span>}
              </b>
            </div>
          ))}
          <div className="mkp-mc-n" data-testid="tennis-status">
            {status}
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-tb" data-testid="tennis-tile-table">
        <small>
          <b>3</b>
          {l["table.label"]}
        </small>
        <div key={`tb-${pulse}`} className={flash("tb")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{l["table.group"]}</th>
                <th scope="col">{l["table.p"]}</th>
                <th scope="col">{l["table.w"]}</th>
                <th scope="col">{l["table.l"]}</th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.name} className={r.me ? "mkp-me" : undefined} data-testid={r.me ? "tennis-table-me" : undefined}>
                  <td>{r.name}</td>
                  <td>{r.w + r.l}</td>
                  <td>{r.w}</td>
                  <td>{r.l}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mkp-tile mkp-t-vid mkp-t-wide" data-testid="tennis-tile-stream">
        <small>
          <b>4</b>
          {l["stream.label"]}
        </small>
        <div className="mkp-vidwrap">
          <div key={`vid-${pulse}`} className={`mkp-vid mkp-court${pulse ? " mkp-flash" : ""}`} data-testid="tennis-stream">
            <span className="mkp-yt">{l["stream.channel"]}</span>
            <div className="mkp-ov">
              <div className="mkp-ov-a">
                <span className="mkp-lv">
                  <i />
                  <span>{winner ? l["mc.final"] : l["mc.live"]}</span>
                </span>
                <span className="mkp-nm">{initials(teams.a, 3)}</span>
                <span className="mkp-sc" data-testid="tennis-stream-score">
                  {winner ? `${won.a}-${won.b}` : `${call.a}-${call.b}`}
                </span>
                <span className="mkp-nm mkp-nm2">{initials(teams.b, 3)}</span>
                <span className="mkp-ovs">
                  ({games.a}-{games.b})
                </span>
              </div>
              <div className="mkp-ov-b">
                <b>{status}</b>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function initials(name: string, max = 2): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (max === 3 ? name.replace(/\s+/g, "").slice(0, 3) : words.map((w) => w[0]).slice(0, max).join("")).toUpperCase();
}
