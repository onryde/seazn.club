"use client";

import { useRef, useState } from "react";
import type { GoalDemoLabels } from "./goal-demo-labels";
import { card, fullTime, goal, openingGoal, outcome, undo, type GoalState, type Side } from "@/lib/marketing/goal-match";

/**
 * The working demo on the goal sports' pages (football, hockey, ice hockey): tap a goal and the match page, the table
 * and the stream overlay move, as they do in the product. One `GoalState` (lib/marketing/goal-match.ts) drives every
 * tile. Rendered on the server at the opening state, so the page reads complete before, or without, script.
 *
 * The pad here is real buttons, not the product's pad: there is no match behind this page.
 */

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const SIDES: Side[] = ["a", "b"];
const TINT: Record<Side, string> = { a: "#2563eb", b: "#15803d" };

export function GoalDemo({ labels: l, teams, others }: { labels: GoalDemoLabels; teams: Record<Side, string>; others: readonly [string, string] }) {
  const [s, setS] = useState<GoalState>(openingGoal);
  const [pulse, setPulse] = useState(0);
  const calm = useRef<boolean | null>(null);

  const act = (next: GoalState) => {
    if (next === s) return;
    setS(next);
    if (calm.current === null) calm.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm.current) setPulse((n) => n + 1);
  };

  const result = outcome(s);
  const status = result === null ? l.format : result === "draw" ? l["mc.draw"] : fill(l["mc.won"], { team: teams[result] });
  const lastEvent = s.history.length ? s.events[s.events.length - 1] : undefined;
  const lastText = result !== null ? status : lastEvent ? fill(l["pad.last"], { what: lastEvent.kind === "goal" ? l["mc.goal"] : l.card, team: teams[lastEvent.side] }) : l["pad.lastNone"];
  const flash = (name: string) => (pulse ? `mkp-${name} mkp-flash` : `mkp-${name}`);
  const score = { a: s.a, b: s.b };

  // Wins, draws and losses only: the points a competition gives for each are the organiser's setting.
  const row = (side: Side) => ({
    name: teams[side],
    w: result === side ? 1 : 0,
    d: result === "draw" ? 1 : 0,
    l: result !== null && result !== "draw" && result !== side ? 1 : 0,
    me: side === "a",
  });
  const table = [{ name: others[0], w: 1, d: 0, l: 0, me: false }, { name: others[1], w: 0, d: 0, l: 1, me: false }, row("a"), row("b")].sort((x, y) => y.w - x.w || y.d - x.d || x.l - y.l);

  return (
    <div className="mkp-stage" data-testid="goal-demo" data-goal-result={result ?? ""}>
      <div className="mkp-tile mkp-t-pad" data-testid="goal-tile-pad">
        <small>
          <b>1</b>
          {l["pad.label"]}
        </small>
        <div className="mkp-pad">
          <div className="mkp-bug">
            <div className="mkp-bug-t">{result === null ? l.format : l["mc.fullTime"]}</div>
            <div className="mkp-bug-m">
              {SIDES.map((side) => (
                <div key={side}>
                  <small>{teams[side]}</small>
                  <b data-testid={`goal-score-${side}`}>{score[side]}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="mkp-keys mkp-keys2">
            {SIDES.map((side) => (
              <button key={side} type="button" className="mkp-key mkp-p" data-testid={`goal-key-goal-${side}`} onClick={() => act(goal(s, side))}>
                {fill(l["pad.goal"], { team: teams[side] })}
              </button>
            ))}
            {SIDES.map((side) => (
              <button key={side} type="button" className="mkp-key" data-testid={`goal-key-card-${side}`} onClick={() => act(card(s, side))}>
                {l.card}
                <span className="mkp-key-sub">{teams[side]}</span>
              </button>
            ))}
            <button type="button" className="mkp-key mkp-w" data-testid="goal-key-fulltime" onClick={() => act(fullTime(s))}>
              {l["pad.fullTime"]}
            </button>
          </div>
          <div className="mkp-last">
            <span data-testid="goal-last" aria-live="polite">
              {lastText}
            </span>
            <button type="button" data-testid="goal-undo" onClick={() => act(undo(s))}>
              {l["pad.undo"]}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-mc" data-testid="goal-tile-matchCentre">
        <small>
          <b>2</b>
          {l["mc.label"]}
        </small>
        <div key={`mc-${pulse}`} className={flash("mc")}>
          <div className="mkp-mc-l">
            <i />
            {result === null ? l["mc.live"] : l["mc.fullTime"]}
          </div>
          {SIDES.map((side) => (
            <div className="mkp-mc-r" key={side}>
              <span>
                <i style={{ background: TINT[side] }}>{initials(teams[side])}</i>
                <u>{teams[side]}</u>
              </span>
              <b data-testid={`goal-mc-score-${side}`}>{score[side]}</b>
            </div>
          ))}
          <div className="mkp-mc-n" data-testid="goal-status">
            {status}
          </div>
          <div className="mkp-over">
            <small>{l["mc.timeline"]}</small>
            {s.events.map((e, i) => (
              <span key={i} className={`mkp-setchip${e.kind === "card" ? " mkp-cardchip" : ""}`} data-testid="goal-event" data-event-kind={e.kind}>
                {e.minute}&prime; {e.kind === "goal" ? l["mc.goal"] : l.card} · {initials(teams[e.side], 3)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-tb" data-testid="goal-tile-table">
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
                <th scope="col">{l["table.d"]}</th>
                <th scope="col">{l["table.l"]}</th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.name} className={r.me ? "mkp-me" : undefined} data-testid={r.me ? "goal-table-me" : undefined}>
                  <td>{r.name}</td>
                  <td>{r.w + r.d + r.l}</td>
                  <td>{r.w}</td>
                  <td>{r.d}</td>
                  <td>{r.l}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mkp-tile mkp-t-vid mkp-t-wide" data-testid="goal-tile-stream">
        <small>
          <b>4</b>
          {l["stream.label"]}
        </small>
        <div className="mkp-vidwrap">
          <div key={`vid-${pulse}`} className={`mkp-vid mkp-pitch${pulse ? " mkp-flash" : ""}`} data-testid="goal-stream">
            <span className="mkp-yt">{l["stream.channel"]}</span>
            <div className="mkp-ov">
              <div className="mkp-ov-a">
                <span className="mkp-lv">
                  <i />
                  <span>{result === null ? l["mc.live"] : l["mc.fullTime"]}</span>
                </span>
                <span className="mkp-nm">{initials(teams.a, 3)}</span>
                <span className="mkp-sc" data-testid="goal-stream-score">
                  {s.a}-{s.b}
                </span>
                <span className="mkp-nm mkp-nm2">{initials(teams.b, 3)}</span>
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
