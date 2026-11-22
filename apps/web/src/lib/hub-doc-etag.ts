// W5 follow-ups B4: the hub document's build, as a weak ETag. A document is rebuilt on every write and stamped with the time
// it was built (`generatedAt`; Redis single-flight in front, so every machine serves the same build), so the competition and
// that stamp name one build: a poll holding it is answered 304 (hub route), and its fetch layer keeps the document it holds.
export function hubDocEtag(doc: { competitionId: string; generatedAt: string }): string {
  return `W/"hub-${doc.competitionId}-${doc.generatedAt}"`;
}
