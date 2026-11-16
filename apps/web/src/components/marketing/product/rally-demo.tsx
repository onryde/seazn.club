"use client";

import { useRef, useState } from "react";
import type { RallyDemoLabels } from "./rally-demo-labels";
import { matchWinner, openingRally, point, setsWon, undo, type RallyRules, type RallyState, type Side } from "@/lib/marketing/rally-match";

/**
 * The working demo on the rally sports' pages (badminton, table tennis, volleyball): tap a point and the match page,
 * the table and the stream overlay move, as they do in the product. One `RallyState` (lib/marketing/rally-match.ts)
 * drives every tile. Rendered on the server at the opening state, so the page reads complete before, or without,
 * script.
 *
 * The pad here is real buttons, not a picture of the product's pad and not the product's pad: there is no match behind
 * this page. `rules` are the engine's numbers, read on the server and passed in so the engine stays out of the browser.
 */

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const SIDES: Side[] = ["a", "b"];
const TINT: Record<Side, string> = { a: "#9b2c2c", b: "#2563eb" };

export function RallyDemo({
  labels: l,
  teams,
  others,
  rules,
}: {
  labels: RallyDemoLabels;
  teams: Record<Side, string>;
  /** The other two names in the demo's group, one match played between them, so the table has something to move against. */
  others: readonly [string, string];
  rules: RallyRules;
}) {
  const [s, setS] = useState<RallyState>(() => openingRally(rules));
  const [pulse, setPulse] = useState(0);
  const calm = useRef<boolean | null>(null);

  const act = (next: RallyState) => {
    if (next === s) return;
    setS(next);
    if (calm.current === null) calm.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm.current) setPulse((n) => n + 1);
  };

  const winner = matchWinner(s, rules);
  const won = setsWon(s, rules);
  // Once the match is over the last set sits in `sets` and the open score is 0-0: show the set that decided it.
  const open: Record<Side, number> = winner ? { a: s.sets[s.sets.length - 1]![0], b: s.sets[s.sets.length - 1]![1] } : { a: s.a, b: s.b };
  const setNo = winner ? s.sets.length : s.sets.length + 1;
  const target = rules.targets[setNo - 1]!;
  const status = winner ? fill(l["mc.won"], { team: teams[winner] }) : fill(l["mc.toWin"], { unit: l.unit, n: setNo, target });
  const flash = (name: string) => (pulse ? `mkp-${name} mkp-flash` : `mkp-${name}`);

  // Wins and losses only: how a competition turns them into points is the organiser's setting, not this demo's to invent.
  const table = [
    { name: others[0], w: 1, l: 0, me: false },
    { name: others[1], w: 0, l: 1, me: false },
    ...SIDES.map((side) => ({ name: teams[side], w: winner === side ? 1 : 0, l: winner && winner !== side ? 1 : 0, me: side === "a" })),
  ].sort((x, y) => y.w - x.w || x.l - y.l);

  return (
    <div className="mkp-stage" data-testid="rally-demo" data-rally-winner={winner ?? ""}>
      <div className="mkp-tile mkp-t-pad" data-testid="rally-tile-pad">
        <small>
          <b>1</b>
          {l["pad.label"]}
        </small>
        <div className="mkp-pad">
          <div className="mkp-bug">
            <div className="mkp-bug-t">{fill(l.format, { n: setNo, bestOf: rules.bestOf })}</div>
            <div className="mkp-bug-m">
              {SIDES.map((side) => (
                <div key={side}>
                  <small>{teams[side]}</small>
                  <b data-testid={`rally-score-${side}`}>{open[side]}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="mkp-keys mkp-keys2">
            {SIDES.map((side) => (
              <button key={side} type="button" className="mkp-key mkp-p" data-testid={`rally-point-${side}`} onClick={() => act(point(s, side, rules))}>
                {fill(l["pad.point"], { team: teams[side] })}
              </button>
            ))}
          </div>
          <div className="mkp-last">
            <span data-testid="rally-last" aria-live="polite">
              {winner ? fill(l["mc.won"], { team: teams[winner] }) : s.last ? fill(l["pad.last"], { team: teams[s.last] }) : l["pad.lastNone"]}
            </span>
            <button type="button" data-testid="rally-undo" onClick={() => act(undo(s))}>
              {l["pad.undo"]}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-mc" data-testid="rally-tile-matchCentre">
        <small>
          <b>2</b>
          {l["mc.label"]}
        </small>
        <div key={`mc-${pulse}`} className={flash("mc")}>
          <div className="mkp-mc-l">
            <i />
            {winner ? l["stream.final"] : l["mc.live"]}
          </div>
          {SIDES.map((side) => (
            <div className="mkp-mc-r" key={side}>
              <span>
                <i style={{ background: TINT[side] }}>{initials(teams[side])}</i>
                <u>{teams[side]}</u>
              </span>
              <b>
                <span className="mkp-sets" data-testid={`rally-sets-${side}`}>{won[side]}</span>
                <span data-testid={`rally-mc-score-${side}`}>{open[side]}</span>
              </b>
            </div>
          ))}
          <div className="mkp-mc-n" data-testid="rally-status">
            {status}
          </div>
          <div className="mkp-over">
            <small>{l.units}</small>
            {s.sets.map(([a, b], i) => (
              <span key={i} className="mkp-setchip" data-testid="rally-set">
                {a}-{b}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-tb" data-testid="rally-tile-table">
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
                <tr key={r.name} className={r.me ? "mkp-me" : undefined} data-testid={r.me ? "rally-table-me" : undefined}>
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

      <div className="mkp-tile mkp-t-vid mkp-t-wide" data-testid="rally-tile-stream">
        <small>
          <b>4</b>
          {l["stream.label"]}
        </small>
        <div className="mkp-vidwrap">
          <div key={`vid-${pulse}`} className={`mkp-vid mkp-court${pulse ? " mkp-flash" : ""}`} data-testid="rally-stream">
            <span className="mkp-yt">{l["stream.channel"]}</span>
            <div className="mkp-ov">
              <div className="mkp-ov-a">
                <span className="mkp-lv">
                  <i />
                  <span>{winner ? l["stream.final"] : l["stream.live"]}</span>
                </span>
                <span className="mkp-nm">{initials(teams.a, 3)}</span>
                <span className="mkp-sc" data-testid="rally-stream-score">
                  {open.a}-{open.b}
                </span>
                <span className="mkp-nm mkp-nm2">{initials(teams.b, 3)}</span>
                <span className="mkp-ovs">
                  ({won.a}-{won.b})
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
