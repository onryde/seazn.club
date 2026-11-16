"use client";

import { useState } from "react";
import type { SignalDemoLabels } from "./signal-demo-labels";
import { CHASE, ballsLeft, chaseOver, needText, oversText, type ChaseKey, type ChaseState } from "@/lib/marketing/cricket-chase";
import { openingSignal, setSignal, signalTap, signalUndo, type SignalState } from "@/lib/marketing/signal-queue";

/**
 * The Remote scoring page's working demo: a phone's scoring pad with a signal switch, beside what everyone else sees.
 * Switch the signal off and the pad keeps scoring while the other screen stands still; switch it on and it catches up.
 * One `SignalState` (lib/marketing/signal-queue.ts) drives both tiles. Rendered on the server at the opening state, so
 * the page reads complete before, or without, script.
 *
 * A model of what the Seazn app does, not the app: there is no match and no network behind this page.
 */

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const initials = (name: string) => name.split(" ").map((w) => w[0]).slice(0, 2).join("");

const KEYS: { key: ChaseKey; cls: string }[] = [
  { key: "0", cls: "mkp-key mkp-p" }, { key: "1", cls: "mkp-key mkp-p" }, { key: "2", cls: "mkp-key" },
  { key: "3", cls: "mkp-key" }, { key: "4", cls: "mkp-key" }, { key: "6", cls: "mkp-key" },
  { key: "wide", cls: "mkp-key mkp-w" }, { key: "out", cls: "mkp-key mkp-out" },
];
const FIRST_INNINGS_WICKETS = 3;

export function SignalDemo({
  labels: l,
  teams,
  ballsPerOver,
}: {
  labels: SignalDemoLabels;
  teams: { batting: string; bowling: string };
  /** The engine's over length, read on the server (cricket-chase-rules.ts). */
  ballsPerOver: number;
}) {
  const [s, setS] = useState<SignalState>(openingSignal);
  const score = (c: ChaseState) => `${c.runs}/${c.wkts}`;
  const end = chaseOver(s.phone);
  const winner = end === "won" ? teams.batting : end === "allOut" ? teams.bowling : null;
  const ballWord = (m: string) => (m === "wd" ? l["pad.wide"] : m === "W" ? l["pad.out"] : m);
  const waiting = s.pending.length;
  const serverEnd = chaseOver(s.server);
  const serverWinner = serverEnd === "won" ? teams.batting : serverEnd === "allOut" ? teams.bowling : null;

  return (
    <div className="mkp-stage mkp-s2" data-testid="signal-demo" data-signal={s.signal ? "on" : "off"} data-waiting={waiting}>
      <div className="mkp-tile mkp-t-pad" data-testid="signal-tile-phone">
        <small>
          <b>1</b>
          {l["label.phone"]}
        </small>
        <div className="mkp-pad">
          <div className="mkp-sig">
            <span id="mkp-sig-label">{l["switch"]}</span>
            <button
              type="button"
              role="switch"
              aria-checked={s.signal}
              aria-labelledby="mkp-sig-label"
              className="mkp-switch"
              data-testid="signal-switch"
              onClick={() => setS(setSignal(s, !s.signal))}
            >
              <i aria-hidden />
              <span>{s.signal ? l["on"] : l["off"]}</span>
            </button>
          </div>
          <div className="mkp-bug">
            <div className="mkp-bug-t">{fill(l["pad.format"], { overs: oversText(s.phone.balls, ballsPerOver) })}</div>
            <div className="mkp-bug-m">
              <div>
                <small>{fill(l["pad.batting"], { team: teams.batting })}</small>
                <b data-testid="signal-phone-score">{score(s.phone)}</b>
              </div>
              <div>
                <small>{l["pad.overs"]}</small>
                <b>{oversText(s.phone.balls, ballsPerOver)}</b>
              </div>
            </div>
          </div>
          <div className={s.signal ? "mkp-badge" : "mkp-badge mkp-off"} data-testid="signal-badge" aria-live="polite">
            {!s.signal ? fill(l["queued"], { n: waiting }) : s.sent ? fill(l["sent"], { n: s.sent }) : l["online"]}
          </div>
          <div className="mkp-keys">
            {KEYS.map(({ key, cls }) => (
              <button key={key} type="button" className={cls} data-testid={`signal-key-${key}`} onClick={() => setS(signalTap(s, key, ballsPerOver))}>
                {key === "wide" ? l["pad.wide"] : key === "out" ? l["pad.out"] : key}
              </button>
            ))}
          </div>
          <div className="mkp-last">
            <span>{winner ? fill(l["mc.won"], { team: winner }) : s.phone.last ? fill(l["pad.last"], { ball: ballWord(s.phone.last) }) : l["pad.lastNone"]}</span>
            <button type="button" data-testid="signal-undo" onClick={() => setS(signalUndo(s))}>
              {l["pad.undo"]}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile" data-testid="signal-tile-others">
        <small>
          <b>2</b>
          {l["label.others"]}
        </small>
        <div className={waiting ? "mkp-mc mkp-stale" : "mkp-mc"}>
          <div className="mkp-mc-l">
            <i />
            {l["mc.live"]} <span>{oversText(s.server.balls, ballsPerOver)}</span> {l["mc.ov"]}
          </div>
          <div className="mkp-mc-r">
            <span>
              <i style={{ background: "#2563eb" }}>{initials(teams.bowling)}</i>
              <u>{teams.bowling}</u>
            </span>
            <b>{`${CHASE.target - 1}/${FIRST_INNINGS_WICKETS}`}</b>
          </div>
          <div className="mkp-mc-r">
            <span>
              <i style={{ background: "#9b2c2c" }}>{initials(teams.batting)}</i>
              <u>{teams.batting}</u>
            </span>
            <b data-testid="signal-server-score">{score(s.server)}</b>
          </div>
          <div className="mkp-mc-n">
            {serverWinner
              ? fill(l["mc.won"], { team: serverWinner })
              : fill(l["mc.need"], { team: teams.batting, runs: needText(s.server).runs, balls: ballsLeft(s.server, ballsPerOver) })}
          </div>
          <div className="mkp-mc-s" data-testid="signal-server-note">
            {waiting ? l["behind"] : l["upToDate"]}
          </div>
        </div>
      </div>
    </div>
  );
}
