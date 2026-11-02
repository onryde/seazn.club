"use client";

// The screen after Create (Match Day C8, design B4): the competition exists and
// has no division, so the one useful next step is the division builder. "Later"
// goes to the competition page. This replaces the straight redirect to a
// competition page whose empty state asked the same question less clearly.
//
// Rendered by the wizard in place of its form (client state, not a route), for
// the reason the degrade card already is: an armed Create button under a
// competition that exists is how the same night gets created twice.
import { useEffect, useRef } from "react";
import { CircleCheck, Globe, Link2, Lock, type LucideIcon } from "lucide-react";
import Link from "@/components/ui/console-link";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { VISIBILITY_OPTIONS, type VisibilityKey } from "@/components/ui/visibility-picker";
import { fmtPublicDate } from "@/lib/format";
import { routes } from "@/lib/routes";

/** What the server made — read off its 201, not off the request. */
export interface CreatedCompetition {
  name: string;
  slug: string;
  visibility: string;
  discoverable: boolean;
  startsOn: string;
  endsOn: string;
}

const ICON: Record<VisibilityKey, LucideIcon> = { private: Lock, unlisted: Link2, public: Globe };

/** A calendar day (no time, no zone) written in the viewer's locale. */
const day = (locale: string, iso: string) =>
  fmtPublicDate(locale, "UTC", `${iso}T12:00:00Z`, { day: "numeric", month: "short", year: "numeric" });

export function FirstDivisionPrompt({
  orgSlug,
  created,
}: {
  orgSlug: string;
  created: CreatedCompetition;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const heading = useRef<HTMLHeadingElement>(null);
  // A new screen in the same page: put a screen reader's cursor on it.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const option = VISIBILITY_OPTIONS.find((o) => o.value === created.visibility);
  const Icon = option ? ICON[option.value] : Globe;
  const dates =
    created.startsOn && created.startsOn !== created.endsOn
      ? `${day(locale, created.startsOn)} – ${day(locale, created.endsOn)}`
      : day(locale, created.endsOn);

  return (
    <div className="space-y-5" data-testid="first-division-prompt">
      <p
        role="status"
        className="inline-flex items-center gap-2 rounded-full border border-purple-100 bg-white px-3.5 py-2 text-sm text-slate-800 shadow-sm"
      >
        <CircleCheck aria-hidden className="h-4 w-4 text-green-600" strokeWidth={2} />
        {msg("comp.wizard.created.status")}
      </p>

      <div className="min-w-0">
        <p className="break-words text-lg font-semibold tracking-tight text-slate-900">{created.name}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-slate-600">
          {option && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-100 bg-purple-50 px-2.5 py-0.5 text-purple-700">
              <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
              {msg(option.label)}
            </span>
          )}
          {created.discoverable && (
            <span className="rounded-full border border-purple-100 bg-purple-50 px-2.5 py-0.5 text-purple-700">
              {msg("comp.wizard.created.showcased")}
            </span>
          )}
          <span>{dates}</span>
        </p>
      </div>

      <section
        aria-labelledby="first-division-title"
        className="card max-w-xl space-y-4 border-dashed border-purple-300 p-6 sm:p-7"
      >
        <h2
          id="first-division-title"
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-slate-800 outline-none"
        >
          {msg("comp.wizard.created.title")}
        </h2>
        <p className="max-w-[52ch] text-sm leading-relaxed text-slate-600">{msg("comp.wizard.created.body")}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href={routes.divisionNew(orgSlug, created.slug)}
            data-testid="first-division-add"
            className="btn btn-primary min-h-11"
          >
            {msg("comp.wizard.created.add")}
          </Link>
          <Link
            href={routes.competition(orgSlug, created.slug)}
            data-testid="first-division-later"
            className="btn btn-ghost min-h-11"
          >
            {msg("comp.wizard.created.later")}
          </Link>
        </div>
      </section>
    </div>
  );
}
