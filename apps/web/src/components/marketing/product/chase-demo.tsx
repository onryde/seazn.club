"use client";

import { useRef, useState } from "react";
import type { ChaseDemoLabels } from "./chase-demo-labels";
import {
  CHASE,
  ballsLeft,
  chaseMoment,
  chaseOver,
  needText,
  openingChase,
  oversText,
  tap,
  undo,
  type ChaseKey,
  type ChaseState,
} from "@/lib/marketing/cricket-chase";

/**
 * The product pages' working demo: a visitor taps a scoring pad and the other screens on the page move, as they do in
 * the product. One `ChaseState` (lib/marketing/cricket-chase.ts) drives every tile. Rendered on the server at the
 * opening state, so the page reads complete before, or without, script.
 *
 * The pad here is real buttons styled after the cricket pad, not a picture of it and not the product's pad: there is
 * no match behind this page.
 */

export type ChaseTile = "pad" | "matchCentre" | "table" | "stream";
type StreamStyle = "bar" | "bug";
type StreamState = "soon" | "live" | "recon" | "final";

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const KEYS: { key: ChaseKey; cls: string }[] = [
  { key: "0", cls: "mkp-key mkp-p" }, { key: "1", cls: "mkp-key mkp-p" }, { key: "2", cls: "mkp-key" },
  { key: "3", cls: "mkp-key" }, { key: "4", cls: "mkp-key" }, { key: "6", cls: "mkp-key" },
  { key: "wide", cls: "mkp-key mkp-w" }, { key: "out", cls: "mkp-key mkp-out" },
];
/** The other three sides of the demo's group, played one, so the table has something to move against. */
const TABLE_OTHERS = [["Hadleigh Hawks", 1, 2], ["Leigh Lions", 0, 0]] as const;
const POINTS_FOR_WIN = 2;
const FIRST_INNINGS_WICKETS = 3;

export function ChaseDemo({
  tiles,
  streamControls,
  labels: l,
  teams,
  ballsPerOver,
}: {
  tiles: ChaseTile[];
  streamControls: boolean;
  labels: ChaseDemoLabels;
  teams: { batting: string; bowling: string };
  /** The engine's over length, read on the server (cricket-chase-rules.ts). Passed in so the engine stays out of the browser. */
  ballsPerOver: number;
}) {
  const [s, setS] = useState<ChaseState>(openingChase);
  const [style, setStyle] = useState<StreamStyle>("bar");
  const [state, setState] = useState<StreamState>("live");
  const [pulse, setPulse] = useState(0);
  const calm = useRef<boolean | null>(null);

  const act = (next: ChaseState) => {
    if (next === s) return;
    setS(next);
    if (calm.current === null) calm.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm.current) setPulse((n) => n + 1);
  };

  const score = `${s.runs}/${s.wkts}`;
  const overs = oversText(s.balls, ballsPerOver);
  const end = chaseOver(s);
  const winner = end === "won" ? teams.batting : end === "allOut" ? teams.bowling : null;
  const need = { team: teams.batting, runs: needText(s).runs, balls: ballsLeft(s, ballsPerOver) };
  const ballWord = (m: string) => (m === "wd" ? l["pad.wide"] : m === "W" ? l["pad.out"] : m);
  const moment = chaseMoment(s, ballsPerOver);
  const firstInnings = `${CHASE.target - 1}/${FIRST_INNINGS_WICKETS}`;
  // A changing `key` restarts the CSS flash on every accepted tap; the class is absent until the first one and under
  // reduced motion (`pulse` never moves).
  const flash = (name: string) => (pulse ? `mkp-${name} mkp-flash` : `mkp-${name}`);
  const n = (tile: ChaseTile) => tiles.indexOf(tile) + 1;
  const has = (tile: ChaseTile) => tiles.includes(tile);

  const table = [
    ...TABLE_OTHERS.map(([name, w, pts]) => ({ name, w, pts, me: false })),
    { name: teams.batting, w: end === "won" ? 1 : 0, pts: end === "won" ? POINTS_FOR_WIN : 0, me: true },
    { name: teams.bowling, w: end === "allOut" ? 1 : 0, pts: end === "allOut" ? POINTS_FOR_WIN : 0, me: false },
  ].sort((a, b) => b.pts - a.pts);

  return (
    <div className={tiles.length === 2 ? "mkp-stage mkp-s2" : "mkp-stage"} data-testid="chase-demo" data-chase-end={end ?? ""}>
      {has("pad") ? (
        <div className="mkp-tile mkp-t-pad" data-testid="chase-tile-pad">
          <small>
            <b>{n("pad")}</b>
            {l["pad.label"]}
          </small>
          <div className="mkp-pad" data-testid="chase-pad">
            <div className="mkp-bug">
              <div className="mkp-bug-t">{fill(l["pad.format"], { overs })}</div>
              <div className="mkp-bug-m">
                <div>
                  <small>{fill(l["pad.batting"], { team: teams.batting })}</small>
                  <b data-testid="chase-score">{score}</b>
                </div>
                <div>
                  <small>{l["pad.overs"]}</small>
                  <b data-testid="chase-overs">{overs}</b>
                </div>
              </div>
            </div>
            <div className="mkp-keys">
              {KEYS.map(({ key, cls }) => (
                <button key={key} type="button" className={cls} data-testid={`chase-key-${key}`} onClick={() => act(tap(s, key, ballsPerOver))}>
                  {key === "wide" ? l["pad.wide"] : key === "out" ? l["pad.out"] : key}
                </button>
              ))}
            </div>
            <div className="mkp-last">
              <span data-testid="chase-last" aria-live="polite">
                {winner ? fill(l["mc.won"], { team: winner }) : s.last ? fill(l["pad.last"], { ball: ballWord(s.last) }) : l["pad.lastNone"]}
              </span>
              <button type="button" data-testid="chase-undo" onClick={() => act(undo(s))}>
                {l["pad.undo"]}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {has("matchCentre") ? (
        <div className="mkp-tile mkp-t-mc" data-testid="chase-tile-matchCentre">
          <small>
            <b>{n("matchCentre")}</b>
            {l["mc.label"]}
          </small>
          <div key={`mc-${pulse}`} className={flash("mc")}>
            <div className="mkp-mc-l">
              <i />
              {l["mc.live"]} <span>{overs}</span> {l["mc.ov"]}
            </div>
            <div className="mkp-mc-r">
              <span>
                <i style={{ background: "#2563eb" }}>{initials(teams.bowling)}</i>
                <u>{teams.bowling}</u>
              </span>
              <b>{firstInnings}</b>
            </div>
            <div className="mkp-mc-r">
              <span>
                <i style={{ background: "#9b2c2c" }}>{initials(teams.batting)}</i>
                <u>{teams.batting}</u>
              </span>
              <b data-testid="chase-mc-score">{score}</b>
            </div>
            <div className="mkp-mc-n" data-testid="chase-need">
              {winner ? fill(l["mc.won"], { team: winner }) : fill(l["mc.need"], need)}
            </div>
            <div className="mkp-over">
              <small>{l["mc.thisOver"]}</small>
              {s.over.map((b, i) => (
                <span key={i} className={`mkp-ball mkp-b${b.toLowerCase()}`}>
                  {b === "wd" ? "Wd" : b}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {has("table") ? (
        <div className="mkp-tile mkp-t-tb" data-testid="chase-tile-table">
          <small>
            <b>{n("table")}</b>
            {l["table.label"]}
          </small>
          <div key={`tb-${pulse}`} className={flash("tb")}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{l["table.group"]}</th>
                  <th scope="col">{l["table.p"]}</th>
                  <th scope="col">{l["table.w"]}</th>
                  <th scope="col">{l["table.pts"]}</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.name} className={r.me ? "mkp-me" : undefined} data-testid={r.me ? "chase-table-me" : undefined}>
                    <td>{r.name}</td>
                    <td>1</td>
                    <td>{r.w}</td>
                    <td>{r.pts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {has("stream") ? (
        <div className={tiles.length === 2 ? "mkp-tile mkp-t-vid" : "mkp-tile mkp-t-vid mkp-t-wide"} data-testid="chase-tile-stream">
          <small>
            <b>{n("stream")}</b>
            {streamControls ? l["stream.labelStreaming"] : l["stream.labelSport"]}
          </small>
          <div className="mkp-vidwrap">
            <div key={`vid-${pulse}`} className={`mkp-vid${state === "recon" ? " mkp-recon" : ""}${pulse ? " mkp-flash" : ""}`} data-testid="chase-stream" data-stream-style={style} data-stream-state={state}>
              <span className="mkp-yt">{l["stream.channel"]}</span>
              {state === "live" && (moment.ball || moment.endOfOver) ? (
                <div className={`mkp-mom${moment.ball === "out" ? " mkp-mom-out" : ""}`} data-testid="chase-moment" data-moment={moment.ball ?? "over"} aria-live="polite">
                  {moment.ball ? <b>{l[`moment.${moment.ball}`]}</b> : null}
                  {moment.endOfOver ? (
                    <span data-testid="chase-moment-over">
                      <u>{fill(l["moment.endOfOver"], { over: moment.endOfOver.over })}</u>
                      {fill(l["moment.runsScore"], { runs: moment.endOfOver.runs, score })}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className={`mkp-ov${style === "bug" ? " mkp-bug2" : ""}${state === "soon" ? " mkp-soon" : ""}`}>
                <div className="mkp-ov-a">
                  <span className="mkp-lv">
                    <i />
                    <span data-testid="chase-stream-state">{l[`stream.${state}`]}</span>
                  </span>
                  <span className="mkp-tg">
                    {initials(teams.bowling, 3)} {firstInnings} · {fill(l["stream.target"], { n: CHASE.target })}
                  </span>
                  <span className="mkp-nm">{teams.batting}</span>
                  <span className="mkp-sc" data-testid="chase-stream-score">{score}</span>
                  <span className="mkp-ovs">
                    (<span>{overs}</span>)
                  </span>
                </div>
                <div className="mkp-ov-b">
                  <b>{winner ? fill(l["mc.won"], { team: winner }) : fill(l["stream.need"], need)}</b>
                </div>
              </div>
            </div>
          </div>
          {streamControls ? (
            <>
              <div className="mkp-segs" role="group" aria-label={l["stream.style"]}>
                <span>{l["stream.style"]}</span>
                {(["bar", "bug"] as const).map((v) => (
                  <button key={v} type="button" className="mkp-seg" aria-pressed={style === v} data-testid={`chase-seg-style-${v}`} onClick={() => setStyle(v)}>
                    {l[`stream.${v}`]}
                  </button>
                ))}
              </div>
              <div className="mkp-segs" role="group" aria-label={l["stream.state"]}>
                <span>{l["stream.state"]}</span>
                {(["soon", "live", "recon", "final"] as const).map((v) => (
                  <button key={v} type="button" className="mkp-seg" aria-pressed={state === v} data-testid={`chase-seg-state-${v}`} onClick={() => setState(v)}>
                    {l[`stream.${v}`]}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string, max = 2): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (max === 3 ? name.replace(/\s+/g, "").slice(0, 3) : words.map((w) => w[0]).slice(0, max).join("")).toUpperCase();
}
