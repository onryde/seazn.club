// The tail countdown's arithmetic (O16), pure so it is tested without a browser. The desk counts down to the server's
// `tail_ends_at` on the READER's clock, but never compares the two clocks: the count is anchored to the view's server `now`
// (`viewNow`) at the moment the page received it (`anchoredAtMs`, the reader's clock then), and only the time ELAPSED on the
// reader's own clock since is added. A laptop whose clock is an hour off therefore counts true; a new view re-anchors.

/** Whole seconds left until `tailEndsAt`, rounded UP (0.4 s left reads 1) and never below 0 (0 is the line gone). */
export function tailSecondsLeft(i: { tailEndsAt: string; viewNow: string; anchoredAtMs: number; nowMs: number }): number {
  const elapsed = Math.max(0, i.nowMs - i.anchoredAtMs);
  const left = Date.parse(i.tailEndsAt) - (Date.parse(i.viewNow) + elapsed);
  return Number.isNaN(left) ? 0 : Math.max(0, Math.ceil(left / 1000));
}
