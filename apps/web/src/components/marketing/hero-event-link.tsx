"use client";
// The home hero's organiser door (start wizard plan 2026-11-13 Task 5): the quiet "Set up an event" link under the quick
// match Start, which follows the hero's Sport select so /start opens on the sport the visitor picked there.
//
// The select is the server's (the quick match form works with no script), so the link reads it exactly as the hero's art
// does (hero-sport-select.ts: the select's value is the snapshot, its `change` events the subscription). The server's
// snapshot is "nothing picked", so the server's HTML, the hydration that must match it, and a page without the script
// carry the plain `/<lang>/start`: without the script the link cannot follow a change, and naming the default would then
// send the wrong sport. Once hydrated it is `/<lang>/start?sport=<key>` for a sport /start takes (startHrefForSport, the
// same rule as /play's door), else plain.
import { useSyncExternalStore, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { startHrefForSport } from "@/components/quick-match/register-season-link";
import { readNothingPicked, readSelect, subscribeToSelect } from "./hero-sport-select";

export function HeroEventLink({
  lang,
  className,
  children,
  "data-testid": testId,
}: {
  lang: string;
  className?: string;
  "data-testid"?: string;
  children?: ReactNode;
}) {
  const picked = useSyncExternalStore(subscribeToSelect, readSelect, readNothingPicked);
  return (
    <Link href={startHrefForSport(lang, picked)} data-testid={testId} className={className}>
      {children}
    </Link>
  );
}
