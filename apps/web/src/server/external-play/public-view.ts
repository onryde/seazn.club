/** Public-safe external-play bridge snapshot (no tokens). */
export type PublicExternalPlay = {
  status: "pending" | "ready" | "live" | "finished" | "needs_organiser";
  playUrl: string | null;
  whitePlayUrl: string | null;
  blackPlayUrl: string | null;
  lastError: string | null;
};

export function playUrlForStatus(ep: PublicExternalPlay): string | null {
  if (ep.status !== "ready" && ep.status !== "live") return null;
  return ep.playUrl ?? ep.whitePlayUrl ?? ep.blackPlayUrl;
}
