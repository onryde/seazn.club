"use client";

import { useState } from "react";
import type { SponsorDemoLabels } from "./sponsor-demo-labels";
import type { DealTable, DemoNode, DemoStep } from "@/lib/marketing/sponsor-deal-table";

/**
 * The working demo on the Sponsoring page: choose a tier, how the sponsor pays and when they go live, then take the
 * deal through its steps and watch the public page and the stream follow. The island only WALKS `table`: every state
 * and every step offered there was worked out on the server from the product's own deal rules
 * (lib/marketing/sponsor-deal-table.ts), so the rules do not ship to the browser and the demo cannot drift from them.
 *
 * Rendered on the server at the opening state (an online invoice, live when paid, not yet sent).
 */

type Tier = { key: string; turns: number };
const SPONSOR = "Harbour Bakery";
const STEPS: DemoStep[] = ["send_invoice", "pay", "approve", "end"];
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const lab = (l: SponsorDemoLabels, key: string) => l[key as keyof SponsorDemoLabels];

export function SponsorDemo({ labels: l, table, tiers }: { labels: SponsorDemoLabels; table: DealTable; tiers: readonly Tier[] }) {
  const [tier, setTier] = useState(tiers[1]!.key);
  const [method, setMethod] = useState(table.methods[0]!);
  const [rule, setRule] = useState(table.rules[table.methods[0]!][0]!);
  const flow = table.flows[`${method}|${rule}`]!;
  const [node, setNode] = useState<DemoNode>(flow.start);
  const [log, setLog] = useState<DemoStep[]>([]);

  const restart = (m = method, r = rule) => {
    setNode(table.flows[`${m}|${r}`]!.start);
    setLog([]);
  };
  const pickMethod = (m: typeof method) => {
    const r = table.rules[m].includes(rule) ? rule : table.rules[m][0]!;
    setMethod(m);
    setRule(r);
    restart(m, r);
  };
  const pickRule = (r: typeof rule) => {
    setRule(r);
    restart(method, r);
  };

  const [status, money] = node.split("|") as [string, string];
  const offered = flow.edges[node] ?? {};
  const live = status === "live";
  const turns = tiers.find((x) => x.key === tier)!.turns;
  const stepLabel = (s: DemoStep) => (s === "pay" ? lab(l, `step.pay.${method === "online" ? "online" : "offline"}`) : lab(l, `step.${s}`));

  return (
    <div className="mkp-stage" data-testid="sponsor-demo" data-deal-status={status} data-deal-money={money}>
      <div className="mkp-tile mkp-t-pad" data-testid="sponsor-tile-setup">
        <small>
          <b>1</b>
          {l["setup.label"]}
        </small>
        <div className="mkp-pad mkp-dealpad">
          <div className="mkp-segs mkp-segs-l" role="group" aria-label={l["setup.tier"]}>
            <span>{l["setup.tier"]}</span>
            {tiers.map((x) => (
              <button key={x.key} type="button" className="mkp-seg" aria-pressed={tier === x.key} data-testid={`sponsor-tier-${x.key}`} onClick={() => setTier(x.key)}>
                {lab(l, `tier.${x.key}`)}
              </button>
            ))}
          </div>
          <div className="mkp-segs mkp-segs-l" role="group" aria-label={l["setup.method"]}>
            <span>{l["setup.method"]}</span>
            {table.methods.map((m) => (
              <button key={m} type="button" className="mkp-seg" aria-pressed={method === m} data-testid={`sponsor-method-${m}`} onClick={() => pickMethod(m)}>
                {lab(l, `method.${m}`)}
              </button>
            ))}
          </div>
          <div className="mkp-segs mkp-segs-l" role="group" aria-label={l["setup.rule"]}>
            <span>{l["setup.rule"]}</span>
            {table.rules[method].map((r) => (
              <button key={r} type="button" className="mkp-seg" aria-pressed={rule === r} data-testid={`sponsor-rule-${r}`} onClick={() => pickRule(r)}>
                {lab(l, `rule.${r}`)}
              </button>
            ))}
          </div>
          <div className="mkp-keys mkp-keys2 mkp-dealkeys">
            {STEPS.filter((s) => offered[s]).map((s) => (
              <button
                key={s}
                type="button"
                className={s === "end" ? "mkp-key" : "mkp-key mkp-p"}
                data-testid={`sponsor-step-${s}`}
                onClick={() => {
                  setNode(offered[s]!);
                  setLog([...log, s]);
                }}
              >
                {stepLabel(s)}
              </button>
            ))}
          </div>
          <div className="mkp-last">
            <span data-testid="sponsor-status" aria-live="polite">
              {lab(l, `status.${status}`)}
            </span>
            <button type="button" data-testid="sponsor-reset" onClick={() => restart()}>
              {l["setup.reset"]}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile mkp-t-mc" data-testid="sponsor-tile-deal">
        <small>
          <b>2</b>
          {l["deal.label"]}
        </small>
        <div className="mkp-mc">
          <div className="mkp-mc-l">
            <i />
            {fill(l["deal.heading"], { sponsor: SPONSOR, tier: lab(l, `tier.${tier}`) })}
          </div>
          <div className="mkp-mc-r">
            <span>
              <u>{lab(l, `status.${status}`)}</u>
            </span>
            <b className="mkp-money" data-testid="sponsor-money">
              {lab(l, `money.${money}`)}
            </b>
          </div>
          <ol className="mkp-dealsteps">
            <li>{l["done.created"]}</li>
            {log.map((s, i) => (
              <li key={i} data-testid="sponsor-log">
                {lab(l, `done.${s}`)}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mkp-tile mkp-t-tb" data-testid="sponsor-tile-page">
        <small>
          <b>3</b>
          {l["page.label"]}
        </small>
        <div className="mkp-tb mkp-board" data-testid="sponsor-board" data-board-tier={live ? tier : ""}>
          <div className="mkp-board-h">
            <b>{l["page.comp"]}</b>
            {live && tier === "title" ? <span data-testid="sponsor-on-page">{fill(l["page.presented"], { sponsor: SPONSOR })}</span> : null}
          </div>
          {live && (tier === "gold" || tier === "silver") ? (
            <div className={`mkp-board-logo mkp-board-${tier}`} data-testid="sponsor-on-page">
              <small>{l["page.board"]}</small>
              {SPONSOR}
            </div>
          ) : null}
          {live && tier === "partner" ? (
            <div className="mkp-board-partners" data-testid="sponsor-on-page">
              {l["page.partners"]} {SPONSOR}
            </div>
          ) : null}
          {live ? null : <div className="mkp-board-none">{l["page.none"]}</div>}
        </div>
      </div>

      <div className="mkp-tile mkp-t-vid mkp-t-wide" data-testid="sponsor-tile-stream">
        <small>
          <b>4</b>
          {l["stream.label"]}
        </small>
        <div className="mkp-vidwrap">
          <div className="mkp-vid mkp-court" data-testid="sponsor-stream" data-on-stream={live ? "true" : "false"}>
            <span className="mkp-yt">{l["stream.channel"]}</span>
            <div className="mkp-ov">
              <div className="mkp-ov-a">
                <span className="mkp-nm mkp-nm2">{live ? SPONSOR : l["stream.none"]}</span>
              </div>
              {live ? (
                <div className="mkp-ov-b">
                  <b data-testid="sponsor-turns">{fill(l["stream.turns"], { tier: lab(l, `tier.${tier}`), n: turns })}</b>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
