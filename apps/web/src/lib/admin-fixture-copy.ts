// /admin fixtures page copy that a spec also has to read. English only, like the rest of /admin (not in the dictionaries).
// One builder, so the page and `e2e/fixture-config-snapshot.spec.ts` cannot drift apart.

/** Why the re-snapshot hatch is closed on a locked fixture. No reopen exists: a finalized result takes no change. */
export const resnapshotBlockedText = (status: string): string =>
  `Not available — this fixture is ${status}, and a ${status} fixture takes no change.`;
