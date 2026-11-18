import { t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { Currency } from "@/lib/currency";
import { msgFor } from "@/lib/messages-i18n";
import { sportLabel } from "@/lib/scoring-vocab";
import { FlowProgress } from "./competition-flow-progress";
import { FLOW_ID, FLOW_STEPS, type FlowStepKey } from "@/lib/marketing/flow-steps";

export { FLOW_ID, FLOW_STEPS };

/**
 * The home page's "one competition, start to finish" section (owner-picked 2026-11-16: Option A with stage labels,
 * mock at seazn-artifacts/2026-11-16_home-feature-flow_hff16a01). Eight steps in the order an organiser does them,
 * each beside the thing the product shows at that step, all following ONE example competition so the same pairs
 * enter, pay, get scheduled, play and win.
 *
 * Server-rendered and complete without script: every step is lit and the contents list is plain anchors. The
 * `FlowProgress` island only adds the scroll state (which step you are on, the line filling, the phone bar).
 *
 * The example's people are invented and stay untranslated; everything else is `marketing` dictionary copy. No plan
 * limit or fee rate is quoted here on purpose: the ticket stubs below read those from the plan catalog.
 */

const A = "Okafor / Lindqvist";
const B = "Rahman / Castillo";
const SPORTS = ["badminton", "cricket", "football", "tennis", "chess"] as const;
const ENTRY_FEE = 20;
const ENTRIES = { paid: 58, total: 61 };

function money(amount: number, currency: Currency, lang: string): string {
  return new Intl.NumberFormat(lang, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(amount);
}

type ArtProps = { dict: Dict; lang: Locale; currency: Currency };

function SportArt({ dict, lang }: ArtProps) {
  return (
    <div className="mkf-art">
      <ul className="mkf-chips">
        {SPORTS.map((s, i) => (
          <li key={s} className={i === 0 ? "mkf-on" : undefined}>
            {sportLabel(s, (k) => msgFor(lang, k))}
          </li>
        ))}
        <li className="mkf-more">{t(dict, "home.flow.sport.more")}</li>
      </ul>
      <div className="mkf-bug" role="img" aria-label={t(dict, "home.flow.sport.boardLabel", { a: A, b: B })}>
        <div className="mkf-bug-r">
          <span className="mkf-srv" />
          <span className="mkf-nm">{A}</span>
          <b>21</b>
          <b className="mkf-cur">11</b>
        </div>
        <div className="mkf-bug-r">
          <span className="mkf-srv mkf-off" />
          <span className="mkf-nm">{B}</span>
          <b>18</b>
          <b className="mkf-cur">7</b>
        </div>
      </div>
      <p className="mkf-cap">{t(dict, "home.flow.sport.cap")}</p>
    </div>
  );
}

function DivisionsArt({ dict }: ArtProps) {
  const rows = [
    ["mens", 24],
    ["womens", 16],
    ["mixed", 21],
  ] as const;
  return (
    <div className="mkf-art">
      <ul className="mkf-divs">
        {rows.map(([k, n]) => (
          <li key={k}>
            <span className="mkf-dn">{t(dict, `home.flow.division.${k}`)}</span>
            <span className="mkf-dc">{t(dict, "home.flow.divisions.pairs", { count: n })}</span>
          </li>
        ))}
        <li className="mkf-add">
          <span className="mkf-dn">{t(dict, "home.flow.divisions.add")}</span>
        </li>
      </ul>
      <p className="mkf-cap">{t(dict, "home.flow.divisions.cap")}</p>
    </div>
  );
}

function FormatArt({ dict }: ArtProps) {
  return (
    <div className="mkf-art">
      <ul className="mkf-seg">
        <li>{t(dict, "home.flow.format.league")}</li>
        <li className="mkf-on">{t(dict, "home.flow.format.groupsKnockout")}</li>
        <li>{t(dict, "home.flow.format.knockout")}</li>
        <li>{t(dict, "home.flow.format.more")}</li>
      </ul>
      <div className="mkf-draw" role="img" aria-label={t(dict, "home.flow.format.drawLabel")}>
        <div className="mkf-grp">
          {["A", "B", "C", "D"].map((g) => (
            <span key={g}>{t(dict, "home.flow.format.group", { letter: g })}</span>
          ))}
        </div>
        <div className="mkf-rnd">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="mkf-rnd">
          <i />
          <i />
        </div>
        <div className="mkf-rnd">
          <i className="mkf-fin" />
        </div>
      </div>
      <p className="mkf-cap">{t(dict, "home.flow.format.cap")}</p>
    </div>
  );
}

function EntriesArt({ dict, lang, currency }: ArtProps) {
  const fee = money(ENTRY_FEE, currency, lang);
  const rows = [
    [A, "mens", true],
    ["Novak / Adeyemi", "womens", true],
    [B, "mixed", false],
  ] as const;
  return (
    <div className="mkf-art">
      <div className="mkf-sum">
        <span>
          <b>{t(dict, "home.flow.entries.count", ENTRIES)}</b> {t(dict, "home.flow.entries.paidLabel")}
        </span>
        <span className="mkf-amt">
          {t(dict, "home.flow.entries.collected", { amount: money(ENTRIES.paid * ENTRY_FEE, currency, lang) })}
        </span>
      </div>
      <ul className="mkf-ents">
        {rows.map(([name, div, paid]) => (
          <li key={name}>
            <span className="mkf-en">
              {name}
              <small>{t(dict, `home.flow.division.${div}`)}</small>
            </span>
            <span className={`mkf-pill ${paid ? "mkf-paid" : "mkf-due"}`}>
              {paid ? t(dict, "home.flow.entries.paid", { amount: fee }) : t(dict, "home.flow.entries.due")}
            </span>
          </li>
        ))}
      </ul>
      <p className="mkf-cap">{t(dict, "home.flow.entries.cap")}</p>
    </div>
  );
}

function ScheduleArt({ dict }: ArtProps) {
  const slots = [
    ["9:00", "MD A1 v A6", "MD B1 v B6", "WD A1 v A4"],
    ["9:40", "MD A2 v A5", "XD A1 v A4", "WD A2 v A3"],
    ["10:20", "MD A3 v A4", "MD B2 v B5", null],
  ] as const;
  return (
    <div className="mkf-art">
      <div className="mkf-grid" role="img" aria-label={t(dict, "home.flow.schedule.boardLabel")}>
        <span className="mkf-gh" />
        {[1, 2, 3].map((n) => (
          <span key={n} className="mkf-gh">
            {t(dict, "home.flow.schedule.court", { n })}
          </span>
        ))}
        {slots.map(([time, ...cells], r) => [
          <span key={time} className="mkf-gt">
            {time}
          </span>,
          ...cells.map((c, i) => (
            <span key={`${time}-${i}`} className={`mkf-gc${c === null ? " mkf-empty" : ""}${r === 1 && i === 1 ? " mkf-clash" : ""}`}>
              {c ?? t(dict, "home.flow.schedule.free")}
            </span>
          )),
        ])}
      </div>
      <p className="mkf-warn">{t(dict, "home.flow.schedule.clash", { player: "Castillo", n: 1, time: "9:40" })}</p>
      <p className="mkf-cap">{t(dict, "home.flow.schedule.cap")}</p>
    </div>
  );
}

function LiveArt({ dict }: ArtProps) {
  return (
    <div className="mkf-art mkf-live">
      <div className="mkf-pad" role="img" aria-label={t(dict, "home.flow.live.padLabel")}>
        <div className="mkf-pad-top">{t(dict, "home.flow.live.padTop")}</div>
        <div className="mkf-pad-btns">
          {[
            [A, 19],
            [B, 17],
          ].map(([name, score]) => (
            <div key={name} className="mkf-pb">
              <small>{name}</small>
              <b>{score}</b>
              <span>{t(dict, "home.flow.live.point")}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mkf-pub">
        <div className="mkf-pub-h">
          <span className="mkf-livedot" />
          {t(dict, "home.flow.live.public")}
        </div>
        <div className="mkf-pub-r">
          <span>{A}</span>
          <b>21</b>
          <b>19</b>
        </div>
        <div className="mkf-pub-r">
          <span>{B}</span>
          <b>18</b>
          <b>17</b>
        </div>
        <p className="mkf-cap">{t(dict, "home.flow.live.publicCap")}</p>
      </div>
    </div>
  );
}

/** Streaming is its own step (owner 2026-11-18): with the pad and the public page it made one step so tall that the
 *  progress marker sat on it for most of the scroll. */
function StreamArt({ dict }: ArtProps) {
  return (
    <div className="mkf-art">
      <div className="mkf-strm">
        <div className="mkf-vid" role="img" aria-label={t(dict, "home.flow.stream.videoLabel")}>
          <span className="mkf-court" />
          <span className="mkf-v-live">
            <span className="mkf-livedot" />
            {t(dict, "home.flow.stream.badge")}
          </span>
          <span className="mkf-v-score">
            <span>
              {A} <b>19</b>
            </span>
            <span>
              {B} <b>17</b>
            </span>
          </span>
        </div>
        <p className="mkf-cap">{t(dict, "home.flow.stream.cap")}</p>
        {/* Owner 2026-11-16: the price of streaming is the thing to see here. No figure: the pack prices live in one
            table (lib/stream-credit-packs.ts), and a number typed here would drift from it. */}
        <div className="mkf-offer" data-testid="flow-stream-offer">
          <strong className="mk-cond">{t(dict, "home.flow.stream.offer")}</strong>
          <span>{t(dict, "home.flow.stream.offerDetail")}</span>
        </div>
      </div>
    </div>
  );
}

function WinnerArt({ dict }: ArtProps) {
  const table = [
    [A, 5, 5, 0, 10, true],
    ["Iyer / Brandt", 5, 4, 1, 8, true],
    ["Mensah / Koval", 5, 2, 3, 4, false],
  ] as const;
  return (
    <div className="mkf-art">
      <div className="mkf-champ">
        <span className="mkf-cup" aria-hidden />
        <div>
          <small>{t(dict, "home.flow.winner.final")}</small>
          <b>{A}</b>
          <span>{t(dict, "home.flow.winner.beat", { loser: B, score: "21-18, 21-16" })}</span>
        </div>
      </div>
      <table className="mkf-tbl">
        <thead>
          <tr>
            <th scope="col">{t(dict, "home.flow.format.group", { letter: "A" })}</th>
            {(["played", "won", "lost", "points"] as const).map((c) => (
              <th key={c} scope="col">
                {t(dict, `home.flow.winner.col.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.map(([name, p, w, l, pts, through]) => (
            <tr key={name} className={through ? "mkf-q" : undefined}>
              <td>{name}</td>
              <td>{p}</td>
              <td>{w}</td>
              <td>{l}</td>
              <td>{pts}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mkf-cap">{t(dict, "home.flow.winner.cap")}</p>
    </div>
  );
}

const ART: Record<FlowStepKey, (p: ArtProps) => React.ReactElement> = {
  sport: SportArt,
  divisions: DivisionsArt,
  format: FormatArt,
  entries: EntriesArt,
  schedule: ScheduleArt,
  live: LiveArt,
  stream: StreamArt,
  winner: WinnerArt,
};

export function CompetitionFlow({ dict, lang, currency }: ArtProps) {
  const titles = FLOW_STEPS.map((s) => t(dict, `home.flow.${s.key}.title`));
  return (
    <section id={FLOW_ID} className="mkf" data-testid="competition-flow">
      <FlowProgress rootId={FLOW_ID} titles={titles} ofLabel={t(dict, "home.flow.progress", { n: "{n}", total: FLOW_STEPS.length })} />
      <div className="mkf-in">
        <div className="mkf-rail">
          <h2 className="mk-cond">
            {/* `*word*` in the dictionary marks the words set on lime (owner 2026-11-16): each locale picks its own. */}
            {t(dict, "home.flow.title")
              .split("*")
              .map((part, i) => (i % 2 ? <span key={i} className="mkf-hl">{part}</span> : part))}
          </h2>
          <p className="mkf-lede">{t(dict, "home.flow.lede")}</p>
          <ol className="mkf-idx">
            {titles.map((title, i) => (
              <li key={FLOW_STEPS[i]!.key} data-flow-idx={i}>
                <a href={`#flow-${FLOW_STEPS[i]!.key}`}>
                  <span>{i + 1}</span>
                  {title}
                </a>
              </li>
            ))}
          </ol>
        </div>
        <ol className="mkf-steps">
          {FLOW_STEPS.map((s, i) => {
            const Art = ART[s.key];
            return (
              <li key={s.key} id={`flow-${s.key}`} className="mkf-step" data-flow-step={i}>
                <span className="mkf-peg mk-cond">{i + 1}</span>
                <div className="mkf-body">
                  <div className="mkf-text">
                    <h3 className="mk-cond">{titles[i]}</h3>
                    <span className="mkf-stage">{t(dict, `home.flow.stage.${s.stage}`)}</span>
                    <p>{t(dict, `home.flow.${s.key}.body`)}</p>
                  </div>
                  <Art dict={dict} lang={lang} currency={currency} />
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
