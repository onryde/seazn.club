import "server-only";
// Stage-1 of the AI schedule pipeline (#398): the organiser's free text becomes
// typed constraints the referee can actually check.
//
// Two rules govern this file.
//
// 1. THE MODEL NEVER RESOLVES A DATE. It emits symbolic references —
//    {kind:'tomorrow'}, {kind:'weekday',weekday:'FRI'} — and `resolveParsed`
//    below turns them into real days against W2's Clock. Quiet off-by-one
//    calendar arithmetic is exactly the class of error that survives review, and
//    a date word that reaches the architect prompt uncompiled means this whole
//    wave failed regardless of what the tests say.
//
// 2. WORDING NOBODY CAN COMPILE IS NEVER INVENTED INTO A RULE. It goes verbatim
//    into `unparsed` and is shown to a human. Presenting a rule as enforced
//    while nothing enforces it is worse than having no rule.
//
// Credits: this round runs OUTSIDE `spendCredit`, as free pre-flight, on its own
// small meter (design §5.1). A credit buys a token BUDGET, not a number of
// rounds, so extra LLM rounds must never mint credits — and the confirm step W5
// adds is only genuinely free to walk away from if this round is unpriced.
import { z } from "zod";
import { ymdAddDays, zonedTimeToUtc, type Clock, type HardConstraint } from "@seazn/engine/scheduling";
import { createTokenMeter } from "@/lib/ai-rung";
import { resolveProvider } from "@/server/ai/select-provider";
import type { AiProvider, AiTurn } from "@/server/ai/provider";

// ---------------------------------------------------------------------------
// The symbolic schema the model answers in
// ---------------------------------------------------------------------------

const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

/** The model's ONLY way to talk about a date. It has no calendar and the prompt
 *  says so; `resolveParsed` is what owns the arithmetic. */
const DateRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("today") }),
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("weekday"), weekday: Weekday }),
  z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

/** A run LENGTH, usable only as a window's end. "run for 4 days" had no
 *  representation before 2026-08-16, and the parse bench caught the model
 *  filling the gap twice over: first with a fabricated `2024-01-03`, then —
 *  after the date rule was tightened — with an invented THU weekday. Both are
 *  the model doing calendar arithmetic, which rule 1 exists to forbid.
 *
 *  So `days` is the run's length as the organiser SAID it, inclusive of the
 *  start day, and `resolveParsed` does the counting. The model copies a number
 *  out of the text; it never adds anything to a date.
 *
 *  Deliberately NOT a `DateRef` member: "how long does the run last" is
 *  meaningless for `fixture_on_date`, and keeping it out of that union makes
 *  the nonsense unexpressible rather than merely discouraged. */
const SpanEnd = z.object({
  kind: z.literal("span"),
  days: z.number().int().positive().max(366),
});

/** Deliberately NARROWER than the engine's `ConstraintScope`, which also carries
 *  `entrant`, `person` and `pool`. Those bind fine when a durable config states
 *  them by id (the API path), but this parser is only ever handed division ids —
 *  so a model asked for an entrant scope has no choice but to invent an id, and
 *  an invented id matches no fixture. That is a rule the organiser is told was
 *  compiled while nothing enforces it, which rule 2 of this file forbids. A
 *  narrower instruction goes to `unparsed` and is shown to a human instead. */
const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("division"), divisionId: z.string().min(1) }),
]);

/** No `round`, no `id`, and — since 2026-08-16 — no `ext_key` either. Round
 *  numbers are display labels, and the ext_key variant was unreachable by
 *  construction: `ParserContext` carries divisions and nothing else, so the
 *  model is never shown a single fixture key. The only way it could populate
 *  that field was to invent one, and the parse bench caught it doing exactly
 *  that — "put the semifinals on Friday" compiled to
 *  `{kind:"ext_key", extKey:"semifinals"}`, which binds to no fixture and left
 *  the organiser told a rule was enforced when nothing enforced it.
 *
 *  An option a model cannot satisfy honestly is an invitation, not a
 *  capability. Stage addressing beyond the terminal fixture belongs in
 *  `unparsed` until the vocabulary and the context both exist for it.
 *
 *  Kept as a discriminated union of one so adding a real stage selector later
 *  is an additive change rather than a reshape. The engine's own selector
 *  still supports ext_key for the durable-config API path, which DOES know
 *  fixture keys — this narrowing is the parser's alone. */
const Selector = z.discriminatedUnion("kind", [z.object({ kind: z.literal("terminal") })]);

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const RawHard = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("min_rest_minutes"),
    minutes: z.number().int().positive(),
    rest_scope: z.enum(["per_person", "feeder_to_dependent", "both"]),
    scope: Scope,
  }),
  z.object({ type: z.literal("max_fixtures_per_day"), count: z.number().int().positive(), scope: Scope }),
  z.object({ type: z.literal("fixture_on_weekday"), selector: Selector, weekday: Weekday, scope: Scope }),
  z.object({ type: z.literal("fixture_on_date"), selector: Selector, date: DateRef, scope: Scope }),
  z.object({ type: z.literal("not_before"), time: HHMM, scope: Scope }),
  z.object({ type: z.literal("not_after"), time: HHMM, scope: Scope }),
  /** A break in the middle of a day — lunch, a ceremony, a court closure.
   *
   *  Like `window`, this never becomes a HardConstraint. The engine has modelled
   *  it as `Blackout {court?, from, to}` on the schedule config since long before
   *  the parser could say it: `build-grid.ts` removes those slots from the
   *  lattice and the verifier reports violations. `resolveParsed` therefore
   *  hands it out symbolically and `buildSchedulePack` expands it to one
   *  Blackout per day of the run.
   *
   *  `court` is optional; omitted means every court. It is the one field the
   *  model may name from `ParserContext.courts`, and an unrecognised label
   *  defers the whole break — see `resolveDailyBreaks`. */
  z.object({
    type: z.literal("no_play_between"),
    from: HHMM,
    to: HHMM,
    court: z.string().min(1).optional(),
    scope: Scope,
  }),
  /** Symbolic only, and the ONE member that never becomes a HardConstraint:
   *  `resolveParsed` turns it into the pack's calendar window, which the
   *  verifier already checks. */
  z.object({
    type: z.literal("window"),
    start: DateRef,
    end: z.union([DateRef, SpanEnd]),
    scope: Scope,
  }),
]);

export const RawParsed = z.object({
  hard: z.array(RawHard).default([]),
  soft: z
    .array(
      z.object({
        note: z.string(),
        weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    )
    .default([]),
  unparsed: z.array(z.string()).default([]),
});
export type RawParsed = z.infer<typeof RawParsed>;
export type RawHardConstraint = z.infer<typeof RawHard>;
export type DateRef = z.infer<typeof DateRef>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const PARSER_PROMPT = `You compile a tournament organiser's free-text scheduling instruction into typed
constraints. You receive the instruction plus a small context: the id and name of
every division in this run, and nothing else. Answer with a JSON object matching
the schema below.

Schema:
{
  "hard": [
    { "type": "min_rest_minutes", "minutes": int, "rest_scope": "per_person"|"feeder_to_dependent"|"both", "scope": Scope },
    { "type": "max_fixtures_per_day", "count": int, "scope": Scope },
    { "type": "fixture_on_weekday", "selector": Selector, "weekday": "MON".."SUN", "scope": Scope },
    { "type": "fixture_on_date", "selector": Selector, "date": DateRef, "scope": Scope },
    { "type": "not_before" | "not_after", "time": "HH:mm", "scope": Scope },
    { "type": "no_play_between", "from": "HH:mm", "to": "HH:mm", "court": string?, "scope": Scope },
    { "type": "window", "start": DateRef, "end": DateRef | {"kind":"span","days":int}, "scope": Scope }
  ],
  "soft": [ { "note": string, "weight": 1|2|3 } ],
  "unparsed": [ string ]
}
Scope: {"kind":"competition"} | {"kind":"division","divisionId":id}
Selector: {"kind":"terminal"}
DateRef: {"kind":"today"} | {"kind":"tomorrow"} |
         {"kind":"weekday","weekday":"MON".."SUN"} | {"kind":"date","date":"YYYY-MM-DD"}

Rules:
1. NEVER resolve dates yourself. "tomorrow" stays {"kind":"tomorrow"}; "friday"
   stays {"kind":"weekday","weekday":"FRI"}. You have no calendar. Use
   {"kind":"date"} only if the instruction itself contains an explicit calendar
   date; you cannot compute one. Writing a date that does not appear in the
   instruction is the worst error you can make.
   A stated RUN LENGTH is the one exception, and it is still not arithmetic:
   "run for 4 days from Monday" is
   {"start":{"kind":"weekday","weekday":"MON"},"end":{"kind":"span","days":4}}.
   Copy the number you read; "days" counts the start day itself, and we do the
   counting. Never turn a length into a weekday or a date yourself.
2. "at least N minutes" is a LOWER BOUND -> min_rest_minutes N. Only explicit
   "exactly" / "no more than" language means anything else.
3. When rest wording is ambiguous about whether it means between a player's own
   matches or between a match and the round it feeds (e.g. "gap for each player
   in the next round"), use rest_scope "both".
4. "the final" / "the grand final" -> selector {"kind":"terminal"}. If a division
   is named, scope to it; otherwise scope {"kind":"competition"} (= every
   division's terminal fixture). Never address a fixture by round number.
5. not_before / not_after take a wall-clock "HH:mm" only, never a date or an
   instant, and they bound the WHOLE day. A date range is a "window".
   A pause INSIDE a day — lunch, a ceremony, a closure — is "no_play_between",
   never a not_before/not_after pair: "lunch 12PM to 1PM" is
   {"type":"no_play_between","from":"12:00","to":"13:00"}. It repeats on every
   day of the run, so state it once. "from" must be earlier in the day than
   "to"; a pause running past midnight cannot be stated, so it goes to unparsed.
   Add "court" ONLY with a label copied exactly from the context you were given;
   omit it for a pause on every court, and never invent a court name.
6. Preferences that are not checkable placement rules ("keep mornings relaxed")
   go to soft with a weight. Wording you cannot map at all goes VERBATIM into
   unparsed. Never invent a constraint that is not clearly stated. When wording
   could read either way, prefer soft: it is a wish the organiser sees and
   nothing pretends to enforce. Reserve unparsed for wording that states a real
   requirement this schema has no vocabulary for.
9. Some instructions are PARTLY expressible. Compile the part you can and put
   the rest in unparsed. Never stretch a nearby rule type to cover wording it
   does not mean — there is no way to say a cap on one PART of a day, a cap on
   a named date, or a per-player limit.

Example C
instruction: "run for 4 days from Monday and keep 2 matches in the morning and
3 in the afternoon, lunch break 12PM to 1PM."
output:
{"hard":[
  {"type":"window","start":{"kind":"weekday","weekday":"MON"},"end":{"kind":"span","days":4},"scope":{"kind":"competition"}},
  {"type":"no_play_between","from":"12:00","to":"13:00","scope":{"kind":"competition"}}],
 "soft":[],
 "unparsed":["keep 2 matches in the morning and 3 in the afternoon"]}
The run length and the lunch break both have a form. The morning/afternoon split
does not: max_fixtures_per_day counts a WHOLE day, so compiling it as 5 would
state a rule the organiser never gave.
7. Tolerate typos and broken grammar; compile the evident intent.
8. A scope is ONLY the whole competition or a division id you were given. There
   is no scope for one team, one player or one pool. In particular a PER-PLAYER
   cap ("no player plays more than 2 matches a day", "each team twice a day")
   is NOT max_fixtures_per_day, which counts the whole scope's fixtures on a
   day. Put per-player and per-team caps in unparsed VERBATIM. Only a cap on
   how many fixtures RUN in a day is max_fixtures_per_day.

Example A
instruction: "schedule two matches per day and hav a gap 45 mins at at least and
run a whole matches from tomorrow till Friday."
output:
{"hard":[
  {"type":"max_fixtures_per_day","count":2,"scope":{"kind":"competition"}},
  {"type":"min_rest_minutes","minutes":45,"rest_scope":"both","scope":{"kind":"competition"}},
  {"type":"window","start":{"kind":"tomorrow"},"end":{"kind":"weekday","weekday":"FRI"},"scope":{"kind":"competition"}}],
 "soft":[],"unparsed":[]}

Example B
instruction: "at least have 40 mins gap for each player in the next round and
schedule final on friday."
output:
{"hard":[
  {"type":"min_rest_minutes","minutes":40,"rest_scope":"both","scope":{"kind":"competition"}},
  {"type":"fixture_on_weekday","selector":{"kind":"terminal"},"weekday":"FRI","scope":{"kind":"competition"}}],
 "soft":[],"unparsed":[]}`;

const RETRY_SUFFIX =
  "Your previous answer did not match the schema. Return a corrected JSON object only.";

/** The pre-flight's own ceiling. A compiled instruction is a small JSON object —
 *  a few hundred output tokens — and this round is unpriced, so it gets a hard
 *  bound of its own rather than a share of the run's budget. */
export const PARSE_TOKEN_CEILING = 10_000;

/** Per-attempt cap. Two full attempts must fit inside the ceiling, or the
 *  corrective retry is unreachable exactly when it is needed: `clampRound` is
 *  `max(0, min(cap, budget - spent))`, so a first attempt that missed the
 *  schema by truncating must still leave a whole attempt behind it. The
 *  hardening suite asserts `2 * PARSE_TOKENS_PER_ATTEMPT <= PARSE_TOKEN_CEILING`
 *  rather than trusting this comment.
 *
 *  Raised 2026-08-16 (1k -> 2.5k, ceiling 2k -> 10k). The parse bench's two
 *  longest multi-clause rows kept landing as schema misses on an arm that
 *  averaged ~474 output tokens per case — the signature of an answer running
 *  out of room rather than one that was wrong, which `parseInstruction` cannot
 *  tell apart from the outside because both surface as `parsed: null`. The
 *  round is still unpriced and still small: a compiled instruction is a few
 *  hundred tokens, and this only widens the room the hardest ones get.
 *
 *  Note what the ceiling now does: the loop runs at most TWO attempts, so real
 *  spend cannot exceed 2 x 2.5k = 5k and the 10k ceiling never binds. It is
 *  deliberate headroom — the per-attempt cap is the live limit — so do not read
 *  10k as the pre-flight's expected cost. */
export const PARSE_TOKENS_PER_ATTEMPT = 2_500;

const PARSE_TIMEOUT_MS = 60_000;

/** The default since 2026-08-16, on the evidence of the instruction-parse bench
 *  (35 hand-labelled cases, 5 arms). Against the previous default
 *  claude-haiku-4-5 it invented ZERO constraints where haiku invented five,
 *  scored 32/35 against 30/35, and costs $1.88/Mtok against $5.00.
 *
 *  Inventions are the metric that decided it. A rule the organiser is shown as
 *  enforced while nothing enforces it is worse than no rule (see rule 2 at the
 *  top of this file), and haiku produced ten of them before the schema and
 *  prompt were hardened — including reading "lunch break 12PM to 1PM" as
 *  not_before 12:00 + not_after 13:00, which confines an entire tournament to
 *  the lunch hour.
 *
 *  Served by `google-vertex`, which was already on the paid-path allowlist and
 *  is already named to organisers in help/scheduling/ai-scheduling.md
 *  ("Google (Gemini) ... reached through the OpenRouter gateway"). This
 *  promotion therefore adds no sub-processor and owes no copy change. */
export const PARSE_MODEL = "google/gemini-3.7-flash";

/** Where OpenRouter is not configured. NOT cosmetic: `parseInstruction` refuses
 *  before calling when the provider has no key, and returns
 *  `{raw:null, failed:true}` — which the run treats as "no compiled rules" and
 *  never surfaces as an error. Defaulting a deployment that holds only
 *  ANTHROPIC_API_KEY to an OpenRouter slug would therefore discard every
 *  organiser's brief in silence. It degrades to the previous default instead,
 *  which is worse at refusing but is at least reachable. */
export const PARSE_MODEL_FALLBACK = "claude-haiku-4-5-20251001";

/** Cheap and fast: the compile is a small extraction, and the referee checks
 *  every rule it produces regardless of which model produced it.
 *
 *  Read at call time, like the ladder in schedule-ai.ts: OPENROUTER_API_KEY is
 *  the same deliberate production flip that activates the architect's gemini
 *  rung, so the two move together rather than needing separate configuration. */
export function parserAiModel(): string {
  const pinned = process.env.SCHEDULING_PARSE_MODEL;
  if (pinned) return pinned;
  return process.env.OPENROUTER_API_KEY ? PARSE_MODEL : PARSE_MODEL_FALLBACK;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Everything the model is shown. Divisions ONLY, matching `Scope` — a context
 *  field the scope vocabulary cannot express is an invitation to invent ids. */
export interface ParserContext {
  divisions: { id: string; name: string }[];
  /** Court labels, so a break can be scoped to one of them.
   *
   *  This deliberately reverses the rule that removed `ext_key` — never offer a
   *  field the model cannot fill honestly — and is safe only because it is
   *  VERIFIABLE where a fixture key was not: the court set is small, known, and
   *  cheap to show, so `resolveParsed` can reject a label that was not on it.
   *
   *  Optional so a caller with no court list still compiles. When it is absent
   *  the model has nothing to name, and a break that names a court anyway is
   *  deferred rather than quietly widened to every court. */
  courts?: string[];
}

export interface ParseOutcome {
  raw: RawParsed | null;
  /** True when nothing could be compiled. NOT an error: the run continues with
   *  no compiled rules, and the preview (W5, #400) offers "run it as a
   *  preference instead?". Silent fallback to a soft reading is refused. */
  failed: boolean;
  /** Output tokens this pre-flight spent, charged to its OWN meter and sitting
   *  outside `quote.budget`. It needs its own ledger line or the spend is
   *  invisible — the exact reconciliation complaint #387 makes. */
  tokens: number;
  servedModel: string | null;
}

/**
 * Compile `instruction` into symbolic constraints. One retry on a schema miss,
 * then a soft failure — never a throw. A parse problem must not take down a run
 * the organiser is paying for.
 */
export async function parseInstruction(
  instruction: string,
  ctx: ParserContext,
  opts: { provider?: AiProvider; model?: string } = {},
): Promise<ParseOutcome> {
  const model = opts.model ?? parserAiModel();
  // Resolve from the MODEL, not from the global AI_PROVIDER. `parserAiModel()`
  // returns a bare Anthropic id, and under AI_PROVIDER=openrouter a bare id is a
  // 404 that this function's own catch swallows — every run would silently
  // compile to no rules. Same slug test the model ladder uses (schedule-ai.ts).
  const provider = opts.provider ?? resolveProvider(model.includes("/") ? "openrouter" : "anthropic");
  const meter = createTokenMeter(PARSE_TOKEN_CEILING);

  // Refuse before the call, not inside it: an unconfigured provider is a 503 on
  // the paid path, but here it is simply "no compiled rules".
  if (!provider.isConfigured()) return { raw: null, failed: true, tokens: 0, servedModel: null };

  const messages: AiTurn[] = [{ role: "user", content: JSON.stringify({ instruction, context: ctx }) }];
  let servedModel: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const maxTokens = meter.clampRound(PARSE_TOKENS_PER_ATTEMPT);
    if (maxTokens <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
    try {
      const res = await provider.chat({
        model,
        system: PARSER_PROMPT,
        messages,
        maxTokens,
        // No thinking: this is an extraction, and the ceiling is 1K.
        reasoning: { kind: "none" },
        schema: { name: "instruction_constraints", zod: RawParsed },
        signal: controller.signal,
        timeoutMs: PARSE_TIMEOUT_MS,
        // This round travels on the pre-flight's own, wider allowlist
        // (PARSE_ALLOWED_PROVIDERS) — inert unless the model is an OpenRouter
        // slug, which only SCHEDULING_PARSE_MODEL can make it.
        routing: "parse",
      });
      if (res === null) continue;
      // Meter on EVERY path, hit or miss — an un-metered round is a budget leak,
      // and this meter is the only ceiling the pre-flight has.
      meter.add(res.usage.outputTokens);
      servedModel = res.servedModel;
      // A refusal is not a schema miss: it fails fast and spends no retry.
      if (res.refused) break;
      if (res.parsed !== null) return { raw: res.parsed, failed: false, tokens: meter.spent, servedModel };
      // Schema miss. Hand the retry the answer it got wrong, as a real turn:
      // RETRY_SUFFIX says "your previous answer", and with the correction only
      // in the system prompt there is no previous answer to refer to.
      messages.push(res.assistantTurn, { role: "user", content: RETRY_SUFFIX });
    } catch {
      // Transport, timeout, provider outage. Best-effort pre-flight: give up
      // quietly and let the architect run proceed without compiled rules.
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { raw: null, failed: true, tokens: meter.spent, servedModel };
}

// ---------------------------------------------------------------------------
// Deterministic resolution — everything the model is bad at
// ---------------------------------------------------------------------------

/**
 * One symbolic daily break becomes one concrete `Blackout` per day of the run.
 *
 * Called at the pack edge (buildSchedulePack), not in `resolveParsed`, because
 * only the pack knows which days the run actually covers — an instruction
 * stating no date range still gets its lunch break honoured.
 *
 * Every instant is built from wall-clock day boundaries in ONE zone. Stepping
 * by 86_400_000 instead would drift by an hour across a DST boundary: on a
 * 23-hour day, yesterday's noon plus a day is 13:00 local, which deletes an
 * hour of play and keeps an hour of lunch — silently, on exactly one day of the
 * run. Same reasoning as `setWindow` below.
 */
export function expandDailyBreaks(
  breaks: readonly { from: string; to: string; court?: string }[],
  startYmd: string,
  endYmd: string,
  tz: string,
): { court?: string; from: number; to: number }[] {
  if (breaks.length === 0) return [];
  const out: { court?: string; from: number; to: number }[] = [];
  // Bounded: a pathological range must not spin. A year of daily breaks is
  // already far past anything a tournament states.
  for (let ymd = startYmd, guard = 0; ymd <= endYmd && guard < 400; ymd = ymdAddDays(ymd, 1), guard++) {
    for (const b of breaks) {
      out.push({
        ...(b.court !== undefined ? { court: b.court } : {}),
        from: zonedTimeToUtc(ymd, b.from, tz),
        to: zonedTimeToUtc(ymd, b.to, tz),
      });
    }
  }
  return out;
}

export interface ResolvedParse {
  hard: HardConstraint[];
  soft: RawParsed["soft"];
  unparsed: string[];
  /** Every interpretive choice made here, in the organiser's language. The
   *  organiser should SEE the reading we picked rather than suffer it. */
  assumptions: string[];
  /** The window the instruction stated, as epoch ms, or null when it stated
   *  none. Epoch ms rather than ISO on purpose: the pack builder owns window
   *  RENDERING (it writes zoned offsets, not "Z"), and two renderers would
   *  drift. `to` is the last whole second of the final day, matching what
   *  `windowBounds` expects. */
  windowMs: { from: number; to: number } | null;
  /** Mid-day breaks, still SYMBOLIC — wall-clock strings, not instants.
   *
   *  Deliberately not expanded here. A break repeats every day of the run, and
   *  when the organiser states no date range `resolveParsed` has no idea which
   *  days those are: only the pack does. Expanding here would mean either
   *  dropping the break or guessing at days, and guessing is the failure this
   *  whole file exists to prevent. `buildSchedulePack` owns the expansion, next
   *  to where it already renders `config.blackouts`. */
  dailyBreaks: { from: string; to: string; court?: string }[];
}

const resolveDateRef = (ref: DateRef, clock: Clock): string =>
  ref.kind === "today"
    ? clock.today
    : ref.kind === "tomorrow"
      ? clock.tomorrow
      : ref.kind === "weekday"
        ? clock.nextWeekday[ref.weekday]
        : ref.date;

const MS_PER_DAY = 86_400_000;

const scopeKey = (scope: { kind: string; divisionId?: string }): string =>
  scope.kind === "division" ? `division:${scope.divisionId}` : "competition";

/** The identity a rule competes for. Two rules sharing one cannot both hold.
 *  `null` means the type permits many at once and is never in conflict:
 *  fixture_on_* is per-selector, and `window` has its own first-wins handling
 *  further down. */
function conflictKeyOf(rule: RawHardConstraint): string | null {
  switch (rule.type) {
    case "max_fixtures_per_day":
    case "not_before":
    case "not_after":
      return `${rule.type}|${scopeKey(rule.scope)}`;
    // Rest bounds are only rivals when they bound the SAME relationship.
    // "45 minutes between a player's own matches and 30 before the round they
    // feed into" is two distinct bounds, not a disagreement.
    case "min_rest_minutes":
      return `${rule.type}|${scopeKey(rule.scope)}|${rule.rest_scope}`;
    default:
      return null;
  }
}

/**
 * Refuse rules that contradict each other rather than letting one win silently.
 *
 * Found by the 2026-08-16 parse bench: "6 matches on Saturday and 4 on Sunday"
 * compiled to `max_fixtures_per_day` 6 AND 4, both competition-scoped, because
 * a per-DATE cap has no vocabulary here. Nothing downstream noticed. Whichever
 * the solver happened to read, the organiser had been shown a rule that was not
 * the one being enforced — the same class of harm rule 2 of this file forbids,
 * arrived at by a different route.
 *
 * An exact duplicate is NOT a contradiction: it says the same thing twice, so
 * it collapses quietly. Only genuinely different values for one identity are
 * refused, and then BOTH go, because there is no principled way to pick.
 */
function refuseContradictions(rules: readonly RawHardConstraint[]): {
  kept: RawHardConstraint[];
  refused: string[];
} {
  const groups = new Map<string, RawHardConstraint[]>();
  const kept: RawHardConstraint[] = [];
  for (const rule of rules) {
    const key = conflictKeyOf(rule);
    if (key === null) {
      kept.push(rule);
      continue;
    }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(rule);
  }

  const refused: string[] = [];
  for (const [key, group] of groups) {
    const distinct = new Map(group.map((r) => [JSON.stringify(r), r]));
    if (distinct.size === 1) {
      kept.push(distinct.values().next().value!);
      continue;
    }
    const type = key.split("|")[0];
    refused.push(
      `${type} was stated more than once with different values for the same scope — none was applied`,
    );
  }
  return { kept, refused };
}

/**
 * Refuse wall-clock bounds that every fixture already satisfies.
 *
 * The parse bench caught the model answering "everything after 2pm except the
 * final" with `not_after "23:59"`, and earlier with `not_before "00:00"`. Both
 * are no-ops. They are not harmless: the organiser is shown a compiled rule,
 * believes the exception was understood, and nothing was.
 *
 * Only the two true no-ops are refused. `not_after "00:00"` forbids everything,
 * which is absurd rather than vacuous — the verifier will say so, and an
 * organiser can see and correct a rule that visibly bites. A rule that does
 * nothing is the one that hides.
 */
function refuseVacuousBounds(rules: readonly RawHardConstraint[]): {
  kept: RawHardConstraint[];
  refused: string[];
} {
  const kept: RawHardConstraint[] = [];
  const refused: string[] = [];
  for (const rule of rules) {
    const isNoOp =
      (rule.type === "not_before" && rule.time === "00:00") ||
      (rule.type === "not_after" && rule.time === "23:59");
    if (isNoOp) {
      refused.push(
        `${rule.type} ${rule.time} would not rule anything out, so it was not applied`,
      );
      continue;
    }
    kept.push(rule);
  }
  return { kept, refused };
}

/**
 * Symbolic parse → concrete constraints plus the pack's calendar window.
 *
 * `raw === null` is a first-class input, not an error path: there was no
 * instruction, or the compile failed. The default window stands, no rules are
 * compiled, and nothing is assumed on the organiser's behalf.
 *
 * Those two causes are OPPOSITE situations, though, and `hints.parseFailed`
 * tells them apart. Silence is right when nobody wrote a brief. It is wrong
 * when somebody did and it could not be compiled: `parseInstruction` never
 * throws — a transport failure, a refusal, or a twice-missed schema all return
 * `{raw: null, failed: true}` — so without this the organiser writes a careful
 * brief, receives a schedule that ignores every word of it, and is told
 * nothing. Reporting it is deliberately all this does. Guessing at rules to
 * fill the gap would be the very harm rule 2 of this file forbids.
 */
export function resolveParsed(
  raw: RawParsed | null,
  clock: Clock,
  tz: string,
  hints: { fixtureCount?: number; courts?: string[]; parseFailed?: boolean } = {},
): ResolvedParse {
  const assumptions: string[] = [];
  const hard: HardConstraint[] = [];
  const dailyBreaks: ResolvedParse["dailyBreaks"] = [];
  if (raw === null) {
    if (hints.parseFailed === true) {
      assumptions.push(
        `your scheduling instruction could not be read, so none of it was applied — this schedule was built from your saved settings alone`,
      );
    }
    return { hard, soft: [], unparsed: [], assumptions, windowMs: null, dailyBreaks };
  }

  let windowMs: { from: number; to: number } | null = null;
  let ymd: { start: string; end: string } | null = null;

  // The end is the last whole SECOND of the final day — the shape W2's pack
  // builder emits and the form `windowBounds` expects. Built from wall-clock day
  // boundaries in ONE zone, never by adding 86_400_000, because a DST day is 23
  // or 25 hours long.
  const setWindow = (start: string, end: string): void => {
    ymd = { start, end };
    windowMs = {
      from: zonedTimeToUtc(start, "00:00", tz),
      to: zonedTimeToUtc(ymdAddDays(end, 1), "00:00", tz) - 1_000,
    };
  };

  // Refuse contradictions BEFORE anything is resolved, so a refused cap cannot
  // also drive the feasibility reading further down.
  const { kept: nonConflicting, refused } = refuseContradictions(raw.hard);
  const { kept, refused: vacuous } = refuseVacuousBounds(nonConflicting);
  const unparsed = [...raw.unparsed, ...refused, ...vacuous];

  for (const h of kept) {
    if (h.type === "window") {
      // A window is the run's calendar, and the pack has exactly one. A
      // division-scoped window would silently clamp every other division, so it
      // is refused rather than applied to the wrong thing.
      if (h.scope.kind !== "competition") {
        unparsed.push(`a date range for one division only is not supported — state it for the whole run`);
        continue;
      }
      // Second and later windows are refused, not merged: "last wins" would
      // discard a range whose assumption line the organiser has already read.
      if (ymd !== null) {
        unparsed.push(`more than one date range was stated — only the first was used`);
        continue;
      }
      const start = resolveDateRef(h.start, clock);
      // A span states a LENGTH, so it is counted from the start and can never
      // land before it — the roll-forward branch below is unreachable for it.
      let end =
        h.end.kind === "span"
          ? ymdAddDays(start, h.end.days - 1)
          : resolveDateRef(h.end, clock);
      if (h.end.kind === "span") {
        assumptions.push(
          `a run of ${h.end.days} days from ${start} read as ${start}..${end} (${tz})`,
        );
      }
      if (end < start) {
        // Roll whole weeks until the range is non-empty. A single +7 still lands
        // before the start whenever the start is an explicit far-future date.
        // Bounded so a nonsense pair becomes `unparsed` instead of looping.
        let rolls = 0;
        while (end < start && rolls < 53) {
          end = ymdAddDays(end, 7);
          rolls++;
        }
        if (end < start) {
          unparsed.push(`a date range ending before it starts could not be read`);
          continue;
        }
        assumptions.push(`window end resolved before its start — read as the following week (${end})`);
      }
      setWindow(start, end);
      assumptions.push(`instruction window resolved to ${start}..${end} (${tz})`);
    } else if (h.type === "no_play_between") {
      // Engine `Blackout` has no division concept, so a division-scoped break
      // would quietly apply to everybody — refused, exactly as a
      // division-scoped window is.
      if (h.scope.kind !== "competition") {
        unparsed.push(`a break for one division only is not supported — state it for the whole run`);
        continue;
      }
      // One same-day window only. `from >= to` covers both the reversed pair
      // and a break spanning midnight (22:00..02:00), which is two blackouts on
      // two days rather than one; reading either as a same-day window would
      // invert what the organiser said.
      if (h.from >= h.to) {
        unparsed.push(
          `a break from ${h.from} to ${h.to} could not be read as a single break within one day`,
        );
        continue;
      }
      if (h.court !== undefined) {
        // Verify against the labels the model was actually shown. Dropping just
        // the court would turn "court 2 is closed at lunch" into "everything
        // stops at lunch" — a larger constraint than was stated. An
        // unverifiable court is not the same as no court.
        if (hints.courts === undefined || !hints.courts.includes(h.court)) {
          unparsed.push(`a break was stated for '${h.court}', which is not one of this run's courts`);
          continue;
        }
      }
      dailyBreaks.push({ from: h.from, to: h.to, ...(h.court !== undefined ? { court: h.court } : {}) });
      assumptions.push(
        `no play between ${h.from} and ${h.to}${h.court !== undefined ? ` on ${h.court}` : ""} on every day of the run (${tz})`,
      );
    } else if (h.type === "fixture_on_date") {
      hard.push({ ...h, date: resolveDateRef(h.date, clock) });
    } else if (h.type === "fixture_on_weekday") {
      // The rule itself stays symbolic: the verifier compares the weekday of the
      // day a fixture landed on, so ANY matching weekday satisfies it. The date
      // is named only so the organiser can sanity-check which week we are in.
      assumptions.push(
        `'${h.weekday}' read as any ${h.weekday} in the run — the next one is ${clock.nextWeekday[h.weekday]}`,
      );
      hard.push(h);
    } else {
      hard.push(h);
    }
  }

  // Feasibility-aware reading. "from tomorrow till Friday" when tomorrow IS
  // Friday literally means one day; if a per-day cap cannot hold the fixture
  // count in that many days, take the next weekly reading — and SAY SO, so the
  // organiser sees the judgement instead of an unexplained extra week.
  if (ymd !== null) {
    const w = ymd as { start: string; end: string };
    // COMPETITION-scoped caps only. A division-scoped 1/day bounds that
    // division, not the run, and using it here would extend everybody's window
    // by a week on the strength of a rule most fixtures are not subject to.
    const cap = kept.reduce<number | null>(
      (m, h) =>
        h.type === "max_fixtures_per_day" && h.scope.kind === "competition"
          ? Math.min(m ?? Infinity, h.count)
          : m,
      null,
    );
    const count = hints.fixtureCount ?? 0;
    if (count > 0 && cap !== null) {
      const days =
        Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / MS_PER_DAY) + 1;
      if (days * cap < count) {
        const extended = ymdAddDays(w.end, 7);
        assumptions.push(
          `window ${w.start}..${w.end} holds only ${days * cap} of ${count} fixtures under the ${cap}/day cap — read the end as the following week (${extended})`,
        );
        setWindow(w.start, extended);
      }
    }
  }

  return { hard, soft: raw.soft, unparsed, assumptions, windowMs, dailyBreaks };
}
