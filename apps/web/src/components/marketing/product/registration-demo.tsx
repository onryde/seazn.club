"use client";

import { useState } from "react";
import type { RegistrationDemoLabels } from "./registration-demo-labels";
import { REG_DEMO, enter, nextPlayer, openingList, payHeld, totals, withdraw, type RegList } from "@/lib/marketing/registration-demo";

/**
 * The working demo on the Registration page (owner 2026-11-18, option A): a player's phone, the organiser's entry
 * list and the money. Enter the next player by card, or leave checkout unpaid, and the list and the totals follow; a
 * full division offers the waitlist, and a withdrawal refunds and promotes the first in line. The rules are
 * lib/marketing/registration-demo.ts; this island only draws them. Rendered on the server at the opening list.
 *
 * `money` is built on the server (the visitor's currency and locale), so no formatter ships to the browser.
 */
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function RegistrationDemo({ labels: l, fee, collected }: { labels: RegistrationDemoLabels; fee: string; collected: readonly string[] }) {
  const [list, setList] = useState<RegList>(openingList);
  const who = nextPlayer(list);
  const sum = totals(list);
  const full = sum.spotsLeft === 0;
  const last = list.last;

  return (
    <div className="mkp-stage mkp-reg" data-testid="reg-demo" data-spots-left={sum.spotsLeft} data-waiting={sum.waiting}>
      <div className="mkp-tile mkp-t-pad">
        <small>
          <b>1</b>
          {l["phone.label"]}
        </small>
        <div className="mkp-regphone" data-testid="reg-phone">
          <strong>{l["phone.event"]}</strong>
          <span className="mkp-regsub">{l["phone.club"]}</span>
          {who ? (
            <>
              <dl>
                <div>
                  <dt>{l["phone.name"]}</dt>
                  <dd data-testid="reg-next">{who.name}</dd>
                </div>
              </dl>
              <p className="mkp-regfee">
                <span>{l["phone.fee"]}</span>
                <b>{fee}</b>
              </p>
              <p className="mkp-regspots" data-testid="reg-spots">
                {full ? fill(l["phone.full"], { n: sum.waiting }) : fill(l["phone.spots"], { n: sum.spotsLeft, total: REG_DEMO.capacity })}
              </p>
              {full ? (
                <button type="button" className="mkp-key mkp-p" data-act="join" onClick={() => setList(enter(list, "card"))}>
                  {l["phone.join"]}
                </button>
              ) : (
                <>
                  <button type="button" className="mkp-key mkp-p" data-act="card" onClick={() => setList(enter(list, "card"))}>
                    {fill(l["phone.pay"], { fee })}
                  </button>
                  <button type="button" className="mkp-key" data-act="leave" onClick={() => setList(enter(list, "leave"))}>
                    {l["phone.leave"]}
                  </button>
                </>
              )}
            </>
          ) : (
            <p className="mkp-regdone" data-testid="reg-done">
              {l["phone.done"]}
            </p>
          )}
          <div className="mkp-dealfoot">
            <span />
            <button type="button" data-testid="reg-reset" onClick={() => setList(openingList())}>
              {l.reset}
            </button>
          </div>
        </div>
      </div>

      <div className="mkp-tile">
        <small>
          <b>2</b>
          {l["list.label"]}
        </small>
        <ul className="mkp-reglist" data-testid="reg-list">
          {list.entries.map((e, i) => (
            <li key={e.name} data-status={e.status} data-new={last?.name === e.name ? "" : undefined}>
              <span className="mkp-regwho">
                <b>{e.name}</b>
              </span>
              <span className={`mkp-regchip mkp-reg-${e.status}`}>{e.status === "paid" ? fill(l["status.paid"], { fee }) : l[`status.${e.status}`]}</span>
              {e.status === "held" ? (
                <button type="button" data-act="pay-held" onClick={() => setList(payHeld(list, i))}>
                  {l["act.pay"]}
                </button>
              ) : e.status === "paid" ? (
                <button type="button" data-act="withdraw" onClick={() => setList(withdraw(list, i))}>
                  {l["act.withdraw"]}
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="mkp-tile">
        <small>
          <b>3</b>
          {l["money.label"]}
        </small>
        <div className="mkp-regmoney" data-testid="reg-money">
          <b data-testid="reg-collected">{collected[sum.paid] ?? collected[collected.length - 1]}</b>
          <span>{l["money.collected"]}</span>
          <dl>
            <div>
              <dt>{l["money.taken"]}</dt>
              <dd data-testid="reg-taken">{`${sum.taken} / ${REG_DEMO.capacity}`}</dd>
            </div>
            <div>
              <dt>{l["money.toPay"]}</dt>
              <dd data-testid="reg-held">{sum.held}</dd>
            </div>
            <div>
              <dt>{l["money.waiting"]}</dt>
              <dd data-testid="reg-waiting">{sum.waiting}</dd>
            </div>
          </dl>
          <p className="mkp-regevent" aria-live="polite" data-testid="reg-event" data-event={last?.type ?? ""}>
            {last ? fill(l[`event.${last.type}`], { name: last.name, hours: REG_DEMO.holdHours }) : l["event.none"]}
          </p>
        </div>
      </div>
    </div>
  );
}
