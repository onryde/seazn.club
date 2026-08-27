// Seazn Games registry — the single source of truth for what games exist.
// Pure data: server code (sitemap, pages) imports this, so no client
// components here. Game React components are wired in player-map.tsx.
// Adding a game = new src/games/<slug>/ folder + one entry here
// (+ a player-map entry once it is playable).

export type GameMeta = {
  slug: string; // URL segment: /games/<slug>
  title: string;
  tagline: string; // one-liner for the listing card
  description: string; // longer copy for SEO/meta
  thumbnail: string; // emoji for the card art
  status: "live" | "coming-soon";
};

export const GAMES: GameMeta[] = [
  {
    slug: "chess-quest",
    title: "Chess Quest",
    tagline: "Learn chess from first move to checkmate — one quest at a time.",
    description:
      "A free chess learning adventure: 48 bite-size lessons across two tracks, from how the pieces move to mate-in-two tactics. Play mini-games, earn stars, and track your streak — right in the browser.",
    thumbnail: "♟️",
    status: "live",
  },
  {
    slug: "daily-word",
    title: "Daily Word",
    tagline: "One 5-letter word, six guesses — a new puzzle every day.",
    description:
      "A free daily word-guessing game: five letters, six tries, one puzzle per day. Type or tap a guess and the keyboard fills in green, yellow, and grey to help you close in on the answer — then share your result without spoiling it.",
    thumbnail: "🔤",
    status: "live",
  },
];

export function getGame(slug: string): GameMeta | undefined {
  return GAMES.find((g) => g.slug === slug);
}

export function liveGames(): GameMeta[] {
  return GAMES.filter((g) => g.status === "live");
}
