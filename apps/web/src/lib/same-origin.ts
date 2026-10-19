/**
 * Can this request show it came from one of OUR OWN pages? Asked of the one mutating route that may mint a
 * session for a caller who has none (POST /api/claims/{token}/accept, signed out).
 *
 * `proxy.ts` already refuses a mutating /api call whose Origin names another host, but it lets a request with
 * NO Origin through (curl, API clients, and a few browser shapes), because most routes are protected by the
 * SameSite=Lax session cookie, which is not in play when the caller has no session yet. So this route asks
 * for the proof itself:
 *   - `Sec-Fetch-Site`, when the browser sent it, must be exactly `same-origin` (`same-site` is a sibling
 *     subdomain, `none` is an address-bar navigation, neither is our page). Page scripts cannot set or forge
 *     it — it is a forbidden request header name.
 *   - when it is absent (older browsers), an `Origin` header must be present; its host was matched against
 *     ours by proxy.ts before the route ran. An empty `Origin: ""` is not a header worth the name: it
 *     counts as missing.
 * Neither header present (or only an empty one) means no proof, so refuse.
 */
export function isSameOriginRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  // An empty value is a header that says nothing, so it counts as missing.
  const origin = headers.get("origin");
  return origin !== null && origin !== "";
}
