// The data policy attached to every OpenRouter request.
//
// help/scheduling/ai-scheduling.md tells organisers their brief "is not used to
// train AI models", and ai-officials.md repeats the guarantee. Routing through
// third parties only keeps that true if the policy travels with the request, so
// it lives here as a constant rather than an env var: there is no deployment in
// which loosening it is correct.
//
// Reviewed: 2026-07-21. Re-review whenever a provider is added.

/** Upstream providers permitted to serve our traffic — FIRST-PARTY VENDORS ONLY.
 *
 *  A model id says who BUILT the model, never who SERVES it. Verified
 *  2026-07-21 against /api/v1/models/{id}/endpoints: `anthropic/claude-sonnet-5`
 *  has 7 endpoints across Azure, Anthropic, Amazon Bedrock and Google Vertex;
 *  `z-ai/glm-5.2` has 31 across ~30 companies; `moonshotai/kimi-k2.6` has 20.
 *  `data_collection: "deny"` filters on training policy — it does NOT pin who
 *  processes the data. Without this list a single request could be served by
 *  any of them, which is not what the help pages promise organisers.
 *
 *  These are provider ROUTING SLUGS, not model-id prefixes — they differ
 *  (`x-ai/grok-4.5` is served by slug `xai`, display name "xAI"). Take slugs
 *  from the `tag` field, up to the first `/`.
 *
 *  Each slug below was verified with a live request carrying the full policy;
 *  it returned 200 and was served by the named vendor.
 *
 *  Narrowed 2026-07-21 to two vendors — `anthropic`, `z-ai`, `moonshotai`
 *  and `openai` were removed. By user decision only two models are pursued
 *  through this transport: `x-ai/grok-4.5` and `google/gemini-3.6-flash`.
 *  The `anthropic` slug was only ever needed to route Sonnet-via-OpenRouter,
 *  which the user ruled out; Anthropic-direct traffic goes through
 *  anthropic-provider.ts (select-provider.ts's default path) and never
 *  consults this list. help/scheduling/ai-scheduling.md and
 *  ai-officials.md (Task 12) must name exactly these two vendors plus
 *  Anthropic-direct — three names total, not six. */
export const ALLOWED_PROVIDERS = ["xai", "google-vertex"] as const;

/** The PARSE pre-flight's own allowlist (schedule-ai-parse.ts). Deliberately a
 *  SECOND list rather than a widening of the one above: the pre-flight is an
 *  unpriced extraction whose whole output is a small typed JSON object, so it
 *  can shop for cheap models, while architect and officials traffic stays on
 *  the three vendors help/scheduling/ai-scheduling.md actually names.
 *
 *  Verified live 2026-08-15 against /models/{id}/endpoints. The trap this list
 *  exists to survive: a model id says who BUILT a model, never who SERVES it.
 *  Neither vendor serves its own model on the cheap tier —
 *  `z-ai/glm-4.7-flash` is served by deepinfra / venice / cloudflare / novita
 *  and NOT by the `z-ai` slug; `nvidia/nemotron-3.5-lightning` by deepinfra /
 *  coreweave / venice and NOT by `nvidia`. The only `z-ai`-served GLM endpoint
 *  is glm-5.2 at $4.40/Mtok with `structured_outputs: no`, which this adapter
 *  cannot use at all.
 *
 *  Every slug here supports `structured_outputs`. That is a hard requirement,
 *  not a preference: buildOpenRouterBody always sends
 *  `response_format: json_schema, strict: true`, and an endpoint that ignores
 *  it produces a schema miss that parseInstruction swallows into
 *  `failed: true` — indistinguishable, from the outside, from a model that is
 *  simply bad at the task.
 *
 *  Slugs come from the endpoint `tag` field up to the first "/", same standard
 *  as ALLOWED_PROVIDERS. Re-verify whenever an arm is added.
 *
 *  NOTE: nothing organiser-facing routes here yet. parserAiModel() still
 *  defaults to claude-haiku-4-5 on the Anthropic direct transport; these slugs
 *  are reachable only by setting SCHEDULING_PARSE_MODEL. Promoting one to the
 *  default is a separate change that MUST also update
 *  help/scheduling/ai-scheduling.md and /legal/sub-processors, which today name
 *  Anthropic, Google and xAI only. */
export const PARSE_ALLOWED_PROVIDERS = ["google-vertex", "xai", "deepinfra", "akashml"] as const;

type Policy = {
  provider: {
    data_collection: "deny";
    only: readonly string[];
    allow_fallbacks: false;
  };
  zdr: true;
};

/** Stamp the policy onto a request body, last, so nothing can override it.
 *
 *  `providers` widens only WHO may serve the request. What they may do with it
 *  — deny training, zero retention, no fallback off the list — is fixed here
 *  and is identical on every route. */
export function applyPolicy<T extends object>(
  body: T,
  providers: readonly string[] = ALLOWED_PROVIDERS,
): T & Policy {
  return {
    ...body,
    provider: {
      data_collection: "deny",
      only: providers,
      // Upstream default is true. Left on, routing can fall through to a
      // provider outside `only` and the promise quietly stops holding.
      allow_fallbacks: false,
    },
    zdr: true,
  };
}
