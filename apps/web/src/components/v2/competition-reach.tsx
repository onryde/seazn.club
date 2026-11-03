"use client";

// "Who will find it" (Match Day C8): the audiences a competition reaches, for the
// visibility and showcase choice made above it. Every row's state comes from
// `competitionReach` (lib/competition-listing.ts) — the listing rules the org
// home, the sitemap, discovery and the pages' robots already obey — asked of the
// status a NEW competition is born with. Nothing here decides who sees what.
//
// Rows keep a fixed order and flip state in place, so the eye sees a row switch
// on or off rather than appear and vanish. State is never colour alone: a tick,
// a clock or a dash, plus words for a screen reader.
//
// Match Day PB3: when the org has no public slot left (`cap`), a Public or Link
// only create comes back PRIVATE (`public_quota_degraded`), so the list shows the
// reach a private competition has and a note says why and how out. The server
// still decides; this only stops the list promising what the create will not do.
import { Check, Clock, Lock, Minus } from "lucide-react";
import Link from "@/components/ui/console-link";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import {
  competitionReach,
  NEW_COMPETITION_STATUS,
  REACH_AUDIENCES,
  type ReachAudience,
  type ReachState,
} from "@/lib/competition-listing";

const AUDIENCE_KEY: Record<ReachAudience, MessageKey> = {
  team: "comp.wizard.reach.team",
  link: "comp.wizard.reach.link",
  org: "comp.wizard.reach.org",
  search: "comp.wizard.reach.search",
  showcase: "comp.wizard.reach.showcase",
};

const MARK: Record<ReachState, { Icon: typeof Check; disc: string }> = {
  yes: { Icon: Check, disc: "bg-purple-600 text-white" },
  after_publish: { Icon: Clock, disc: "bg-purple-100 text-purple-700" },
  no: { Icon: Minus, disc: "bg-slate-100 text-slate-500" },
};

/** The plan's public limit is used up: what the note needs to say. */
export interface ReachCap {
  /** The plan's limit on public and link-only competitions. */
  limit: number;
  /** A higher plan really would raise it (a Pro org at Pro's own cap has no upgrade to offer). */
  canUpgrade: boolean;
}

export function CompetitionReach({
  visibility,
  discoverable,
  cap = null,
  billingHref,
}: {
  visibility: string;
  discoverable: boolean;
  /** Set when this create will come back private because no public slot is left. */
  cap?: ReachCap | null;
  /** Where "Upgrade your plan" goes; only read when `cap.canUpgrade`. */
  billingHref?: string;
}) {
  const msg = useMsg();
  // What the create will really produce: over the cap that is a private competition, which neither the picked
  // visibility nor the showcase switch can change.
  const reach = competitionReach(
    cap
      ? { visibility: "private", status: NEW_COMPETITION_STATUS, discoverable: false }
      : { visibility, status: NEW_COMPETITION_STATUS, discoverable },
  );
  return (
    <section aria-labelledby="comp-reach-title" data-testid="competition-reach">
      <h3 id="comp-reach-title" className="label">
        {msg("comp.wizard.reach.title")}
      </h3>
      {cap && (
        <div
          role="status"
          data-testid="public-cap-note"
          className="mb-1.5 flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-snug text-slate-800"
        >
          <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" strokeWidth={2} />
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">{msg("comp.wizard.reach.capped.title")}</p>
            <p className="mt-0.5 text-slate-700">
              {msg(cap.canUpgrade ? "comp.wizard.reach.capped.body" : "comp.wizard.reach.capped.bodyNoUpgrade", { limit: cap.limit })}
            </p>
            {cap.canUpgrade && billingHref && (
              <Link
                href={billingHref}
                className="mt-0.5 inline-flex min-h-11 items-center font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900"
              >
                {msg("comp.wizard.reach.capped.upgrade")}
              </Link>
            )}
          </div>
        </div>
      )}
      <ul className="m-0 list-none p-0">
        {REACH_AUDIENCES.map((audience) => {
          const state = reach[audience];
          const { Icon, disc } = MARK[state];
          const label = msg(AUDIENCE_KEY[audience]);
          return (
            <li
              key={audience}
              data-audience={audience}
              data-state={state}
              className={`flex items-start gap-2.5 border-t border-purple-100 py-1.5 text-sm leading-snug first:border-t-0 ${
                state === "no" ? "text-slate-500" : "text-slate-800"
              }`}
            >
              <span aria-hidden className={`mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full ${disc}`}>
                <Icon className="h-3 w-3" strokeWidth={2.5} />
              </span>
              <span className="min-w-0">
                {state === "yes" && <span className="sr-only">{msg("comp.wizard.reach.yes")}: </span>}
                {state === "no" && <span className="sr-only">{msg("comp.wizard.reach.no")}: </span>}
                {state === "after_publish"
                  ? msg(
                      // The showcase view asks for more than a publish (a schedule or a
                      // result), so its "later" says "may appear" and names the floor.
                      audience === "showcase"
                        ? "comp.wizard.reach.showcase.afterPublish"
                        : "comp.wizard.reach.afterPublish",
                      { audience: label },
                    )
                  : label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
