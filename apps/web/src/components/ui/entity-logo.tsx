// EntityLogo (v3/03 §5): THE badge renderer. One fallback chain everywhere —
// badge image → the entity's own colour → org monogram → initials — so a
// surface never decides badge logic itself. Server-safe (no hooks).
// team_display_v already coalesces team→club, so most callers pass one
// resolved `src`.
//
// Placement rule (the §5 matrix): one logo per level per surface. This
// component renders the ENTITY level; org chrome (nav, mastheads) keeps its
// own org logo and never passes it here as `src`.
//
// ── THE COLOUR ARM ─────────────────────────────────────────────────────────
// `colour` and `size={32}` are BOTH additive: a caller that passes neither
// gets, token for token, the markup this file emitted before they landed.
// That is the property the change had to buy, so `__tests__/entity-logo.test.tsx`
// pins it as the LITERAL expected string for every arm at every pre-existing
// size, rather than as a class-token scan that cannot see class ORDER or the
// double space an empty `className` leaves.
//
// The painted arm and its WCAG ink derivation are lifted whole from
// `public-site/matches-hub/teams-tab.tsx`, where they shipped as a private
// `Crest` with a bespoke 32px class of its own — the size this component did
// not have. That file argued the arm did not belong here because adding one
// "would change every surface that renders a badge"; it changes none of them,
// since the arm only exists for a caller that passes a colour, and that
// sentence has been deleted rather than carried across.
//
// What was real was the cost of the split. `Side.colour`
// (`public-site/match-centre-schema.ts:11`) is built for every hub fixture and
// was read by NOTHING — so one badge-less club rendered as a coloured tile on
// the Teams tab and a grey one on every match card of the same page.
//
// STILL GREY, KNOWINGLY: `TableRow` and `LeaderRow`
// (`public-site/competition-hub-schema.ts`) carry no colour at all, so the
// standings tables and the stats leaders keep the neutral tile. Closing those
// is a schema + builder + cache change and is booked to the entrants/table
// wave; it is not something this component can decide.
import { contrastRatio } from "@/lib/contrast";

const SIZE_CLASS: Record<20 | 24 | 32 | 40, string> = {
  20: "h-5 w-5 text-[9px]",
  24: "h-6 w-6 text-[10px]",
  // 32 shares 24's text size and differs only in the box. It exists for the
  // one place a crest is a hero rather than a row — the competition hub's
  // live-now rail, and the Teams tab's cards, where the badge is most of what
  // distinguishes one card from the next. In a table or a leader list the NAME
  // is the identifier and a bigger badge costs name width, so those stay at 20.
  32: "h-8 w-8 text-[10px]",
  40: "h-10 w-10 text-sm",
};

/** The two inks a monogram may be set in. Fixed values rather than theme
 *  tokens, because the ratio below is computed against them: a token that
 *  resolves at paint time cannot be measured here. `#0f172a` is `slate-900`,
 *  the ink the neutral tile below sits near. */
const LIGHT_INK = "#ffffff";
const DARK_INK = "#0f172a";

/**
 * Every value CSS will actually paint as a colour here, and nothing else.
 *
 * NOT the same rule as `lib/contrast.ts`'s: `expandHex` (`contrast.ts:18`) is
 * `hex.trim().replace(/^#/, "")` — it strips an OPTIONAL leading hash BEFORE
 * validating the character set — so `"123456"` measures perfectly well there.
 * It is not a CSS colour. `style="background:123456"` is a declaration the
 * browser DROPS, which leaves the tile transparent and paints white initials on
 * a white card: invisible, and invisible only for the entities whose colour
 * came in without a hash. Task 10 review F1.
 *
 * That value is reachable rather than theoretical — `colour` reaches the
 * public-site documents as `team_display_v.colors.home_primary`
 * (`server/public-site/competition-hub.ts:335-340`, `primaryColour`) and the v1
 * API takes club `colors` as an unvalidated `z.record(z.string(), z.string())`
 * on both write paths (`server/api-v1/schemas.ts:3257` `CreateClub`, `:3268`
 * `PatchClub`). The club-hub picker is an `<input type="color">`; the API is
 * not.
 *
 * So the gate is on what goes into the STYLE, not on what `expandHex` will
 * tolerate, and the hash is ADDED rather than demanded: a bare `"123456"` is
 * unambiguously six hex digits, and rendering the club's actual navy beats
 * degrading it to grey over a punctuation mark. `components/v2/club-hub/
 * kit-style.ts:7` takes the stricter line (`/^#[0-9a-f]{6}$/i`, refuse) for a
 * value it round-trips through a form; this one only has to paint.
 */
const CSS_HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * How to paint an entity's monogram tile, or null to leave it neutral.
 *
 * TWO reasons this is a function and not `style={{ background: colour }}`:
 *
 * 1. The colour is free text (`TeamCard.colour` and `Side.colour` are both
 *    `z.string().nullable()`), and a bad value has two distinct ways to hurt:
 *    `lib/contrast.ts`'s `expandHex` THROWS on anything outside its charset —
 *    measured: `relativeLuminance("puce")` raises `not a hex colour: puce`,
 *    which would take the whole spectator page down — and anything CSS cannot
 *    parse paints nothing at all, which is the quieter, worse one (see
 *    `CSS_HEX` above). One gate closes both: nothing that fails it reaches
 *    either `contrastRatio` or `style`.
 * 2. A fixed ink is wrong for half the colour wheel. White on `#123456` is
 *    12.7:1; white on a club's yellow `#ffdd00` is 1.3:1, which is not text.
 *    The ink is picked by the WCAG ratio itself rather than by a luminance
 *    threshold typed in here, using the repo's own formula — the same
 *    derivation `_THEMES.md §5` makes for the moments slab, so a red-branded
 *    org and a yellow-branded one both get a readable monogram.
 *
 * Returned as a pair rather than as two calls, so the background a ratio was
 * computed against and the ink it chose cannot come apart.
 *
 * ONE GATE, NOT TWO. The first round of this rule wrapped the ratio in a
 * `try`/`catch` as well, and the fix round's sweep showed the pair covering for
 * each other exactly as AGENTS.md 3 describes: with the `catch` present,
 * dropping `CSS_HEX`'s charset clause survived (everything it then let through
 * threw and was swallowed), and with the charset present, dropping the `catch`
 * survived (nothing could throw). Two guards, neither killable. So the `catch`
 * is gone and `CSS_HEX` is the single rule — it is the one that belongs here,
 * because what this function owes is a string CSS will paint, not a string
 * `contrast.ts` will measure.
 *
 * What the `catch` was insurance against — `lib/contrast.ts` NARROWING its
 * accepted set under us, which would put a throw in a public page render — is
 * an assertion instead of dead code: the suite calls `contrastRatio` itself on
 * every colour this gate accepts and requires it not to throw. That reds if the
 * two rules ever diverge, which the `catch` never would have. The trade is on
 * the record: the failure mode if they diverge is fail-LOUD rather than
 * fail-safe, insured by a test that runs pre-merge.
 *
 * Exported because its arms are not all reachable from a document any builder
 * can produce, and a guard nothing can drive is a guard nothing can kill.
 */
export function monogramInk(colour: string | null | undefined): { bg: string; ink: string } | null {
  if (!colour) return null;
  const raw = colour.trim();
  if (!CSS_HEX.test(raw)) return null;
  // The ratio is measured against the NORMALISED value, not the raw input. The
  // two agree today (`expandHex` strips the hash it needs, so a mutant reading
  // `raw` here is equivalent — recorded rather than papered over with a
  // contrived test), and measuring what is actually painted is the invariant
  // worth stating.
  const bg = raw.startsWith("#") ? raw : `#${raw}`;
  return {
    bg,
    ink: contrastRatio(bg, LIGHT_INK) >= contrastRatio(bg, DARK_INK) ? LIGHT_INK : DARK_INK,
  };
}

/**
 * The tile's colour for an entity that declares none — DERIVED FROM ITS NAME,
 * never stored.
 *
 * The problem this solves: most entities have no colour and never will. A club
 * has to have been created with one, and an INDIVIDUAL has no club at all — in
 * this database, 18,126 of 19,500 entrants are individuals, of which twelve
 * have a team. So the honest default was a grey tile on nearly every row, which
 * identifies nothing and makes two adjacent rows look like one thing.
 *
 * A generated colour was rejected once on the grounds that it invents an
 * identity — "the same player would be a different colour in another
 * competition". Deriving it from the NAME answers that: the same name is the
 * same colour on every page, in every competition, forever, with nothing
 * written down and nothing to migrate. A rename changes it, which is correct —
 * the tile is a visual handle for the name being shown.
 *
 * A FIXED PALETTE rather than a free hue, for two reasons. Every entry is a
 * colour someone chose, so no entity is ever assigned a muddy one; and every
 * entry has a clear winner between the two inks, which is what keeps
 * `monogramInk`'s contrast pick from landing on a marginal pair. Collisions
 * inside one table are possible and accepted — the initials are still there,
 * and the alternative (a hue per entity) is what produces the muddy ones.
 *
 * FNV-1a over the normalised name: trimmed and lower-cased, so "Valley FC" and
 * "valley fc " are one entity rather than two colours. `Math.imul` keeps the
 * multiply in 32-bit, which is what makes this stable across engines.
 */
const AUTO_PALETTE = [
  "#2563eb", "#d6336c", "#0f766e", "#c05621",
  "#6b46c1", "#b7791f", "#9b2c2c", "#2f855a",
  "#1e40af", "#a21caf", "#0e7490", "#b45309",
  "#4c1d95", "#7c2d12", "#166534", "#be123c",
] as const;

export function autoColour(name: string): string {
  const key = name.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // THE FOLD IS LOAD-BEARING, and it was found by mutation testing rather than
  // reasoned about up front. `% AUTO_PALETTE.length` reads the LOW four bits,
  // which is exactly where FNV-1a diffuses worst: without this mix, four of six
  // name pairs differing only in case or surrounding space landed on the SAME
  // palette entry, so the normalisation above could be deleted and every test
  // still passed. Measured again after: zero of the same six collide.
  //
  // A whole-hash distribution check hid it — 400 names spread evenly across the
  // sixteen buckets either way, because those names differ in their tails. Only
  // the near-identical pairs expose a weak avalanche.
  //
  // NO TEST KILLS THIS FOLD ON ITS OWN, and that is stated rather than left to
  // be discovered: with the normalisation above intact both sides of every pair
  // are the SAME STRING, so removing the fold changes nothing observable. Its
  // value is that it makes the normalisation's removal detectable — the two are
  // one guard, and the mutant that matters (`key = name`) is killed.
  h ^= h >>> 16;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 15;
  // `>>> 0` before the modulo: `Math.imul` returns a SIGNED 32-bit int, and a
  // negative remainder would index off the front of the array.
  return AUTO_PALETTE[(h >>> 0) % AUTO_PALETTE.length]!;
}

export function EntityLogo({
  src,
  name,
  orgName,
  colour,
  size = 20,
  className = "",
}: {
  /** Resolved badge URL (team, or club via team_display_v). */
  src?: string | null;
  /** Entity display name — initials fallback + alt text. */
  name: string;
  /** Org name: enables the monogram step of the chain (violet letter mark). */
  orgName?: string | null;
  /**
   * The ENTITY's own colour — free text, straight off the club's `colors`.
   * Omitted, null, or refused by `monogramInk` and this arm does not exist:
   * the chain is then exactly what it was before the arm was added.
   */
  colour?: string | null;
  size?: 20 | 24 | 32 | 40;
  className?: string;
}) {
  const base = crestBox(size, className);

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" aria-hidden className={`${base} bg-white object-contain`} />
    );
  }
  // AHEAD of the org monogram, and that is a decision rather than an accident:
  // the colour and the initials it is painted behind both name THIS entity,
  // while the org letter mark is a stand-in for an entity that offers nothing
  // of its own. No caller passes both today — not one of the seven `EntityLogo`
  // call sites passes `orgName` at all — so this orders a rule, not a live
  // path, and the suite pins the order so it cannot be reversed silently.
  const paint = monogramInk(colour);
  if (paint) {
    return (
      <span
        aria-hidden
        className={`${base} font-semibold`}
        style={{ background: paint.bg, color: paint.ink }}
      >
        {initials(name)}
      </span>
    );
  }
  if (orgName) {
    return (
      <span
        aria-hidden
        className={`${base} bg-gradient-to-br from-purple-500 to-fuchsia-500 font-bold text-white`}
      >
        {orgName.charAt(0).toUpperCase()}
      </span>
    );
  }
  // The entity declared no colour, so one is derived from its NAME rather than
  // falling through to a grey tile that identifies nothing. Last in the chain,
  // so a real colour and a real badge both still win — this never overrides
  // what an organiser chose, it only fills the case where nothing was chosen.
  const auto = monogramInk(autoColour(name));
  return (
    <span
      aria-hidden
      className={`${base} font-semibold`}
      style={{ background: auto!.bg, color: auto!.ink }}
    >
      {initials(name)}
    </span>
  );
}

/**
 * The crest for a side with NOBODY in it yet: a bracket slot waiting on a
 * result ("Winner of R3·2"), the pair or loser sentence the Knockout tab puts in
 * that slot instead, or a bye's empty side (Knockout fix round 2, D3).
 *
 * Not an `EntityLogo` arm, because there is no entity. Every arm above stands
 * for one, and the last derives a colour AND initials from whatever name it is
 * handed — so a waiting pair "Priya Raman / Freya Nilsen" became a coloured "PN"
 * tile, one confirmed player to anyone reading the card. This is the
 * owner-approved mock's waiting crest (`.crest.tbd`): the same box, a neutral
 * fill, a muted outline and a "?" in muted ink. No `style`, so no hue can reach
 * it; `aria-hidden` like every arm, because the side's own text already says
 * who is waiting. `data-crest="pending"` is the handle tests and captures use.
 */
export function PendingCrest({ size = 20 }: { size?: 20 | 24 | 32 | 40 }) {
  return placeholderCrest(size, "pending", "?");
}

/**
 * The crest for a BYE's side: a slot the draw left with nobody in it, for good
 * (Knockout fix round 2b, controller ruling). A bye is not "to be decided", so
 * it must not say "?" — it keeps `PendingCrest`'s exact box and muted tone and
 * shows NO glyph. `data-crest="empty"` tells it apart from a waiting side;
 * `aria-hidden`, so it has no accessible name of its own.
 *
 * What makes a side a bye is the producer's decision (`HubMatch.byeSides`, from
 * the stored `bracket.slot.bye` slot label), never the side's name.
 */
export function EmptyCrest({ size = 20 }: { size?: 20 | 24 | 32 | 40 }) {
  return placeholderCrest(size, "empty", null);
}

/** The one placeholder box both crests draw, so a bye and a waiting side can
 *  differ only in their marker and their glyph. */
function placeholderCrest(size: 20 | 24 | 32 | 40, marker: "pending" | "empty", glyph: "?" | null) {
  return (
    <span
      aria-hidden
      data-crest={marker}
      className={`${crestBox(size, "")} border border-zinc-300 bg-canvas font-semibold text-ink-muted`}
    >
      {glyph}
    </span>
  );
}

/** The box every crest shares — each `EntityLogo` arm and `PendingCrest` — so a
 *  waiting row and a filled one line up at every size, and the size table is
 *  read in one place. */
function crestBox(size: 20 | 24 | 32 | 40, className: string): string {
  return `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md align-middle ${SIZE_CLASS[size]} ${className}`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
