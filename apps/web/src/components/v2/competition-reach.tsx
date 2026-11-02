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
import { Check, Clock, Minus } from "lucide-react";
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

export function CompetitionReach({
  visibility,
  discoverable,
}: {
  visibility: string;
  discoverable: boolean;
}) {
  const msg = useMsg();
  const reach = competitionReach({ visibility, status: NEW_COMPETITION_STATUS, discoverable });
  return (
    <section aria-labelledby="comp-reach-title" data-testid="competition-reach">
      <h3 id="comp-reach-title" className="label">
        {msg("comp.wizard.reach.title")}
      </h3>
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
                  ? msg("comp.wizard.reach.afterPublish", { audience: label })
                  : label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
