// W5 follow-ups B4 (perf-measure-report P4): the hub page hands its document to `CompetitionLanding`, a client root, so the
// whole document is serialised into the page's RSC flight - at a cap-sized competition about 5 MB, all but 0.1 MB of it
// `matches` (one object per fixture of every division, 19 keys each). The page now sends `matches` as columns
// (`lib/packed-rows.ts`, lossless) and the landing unpacks them once, before anything reads the document. What it renders is
// the same document. The live poll (`fetchCompetitionHub`) still answers with the plain document: the API's shape is not
// touched, and `unpackHubDoc` takes either.
import { packRows, unpackRows, type PackedRows } from "@/lib/packed-rows";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

type HubMatch = CompetitionHubDocT["matches"][number];

/** The hub document with its matches packed: what the page hands the landing. */
export type PackedHubDoc = Omit<CompetitionHubDocT, "matches"> & { matches: PackedRows<HubMatch> };

export function packHubDoc(doc: CompetitionHubDocT): PackedHubDoc {
  return { ...doc, matches: packRows(doc.matches) };
}

/** The plain document, from either form. */
export function unpackHubDoc(doc: CompetitionHubDocT | PackedHubDoc): CompetitionHubDocT {
  return Array.isArray(doc.matches) ? (doc as CompetitionHubDocT) : { ...doc, matches: unpackRows(doc.matches as PackedRows<HubMatch>) };
}
