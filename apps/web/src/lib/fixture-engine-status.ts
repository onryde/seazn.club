// DB fixtures.status → the engine's FixtureStatus (spec 05 §1). ONE mapping for
// the standings fold (server/engine-db/competition.ts), the completed-bracket
// rebuild (server/usecases/stages.ts) and the qualification builder
// (server/public-site/qualification-view.ts): a second copy would let the table
// and its status disagree about whether a match counts as played.
//
// Type-only engine import and no `server-only`: pure, so any layer may read it.
import type { FixtureStatus } from "@seazn/engine/competition";

export function engineFixtureStatus(dbStatus: string): FixtureStatus {
  switch (dbStatus) {
    case "decided":
    case "finalized":
      return "decided";
    case "forfeited":
      return "walkover";
    case "abandoned":
    case "cancelled":
      return "void";
    case "in_play":
      return "in_play";
    default:
      return "scheduled";
  }
}
