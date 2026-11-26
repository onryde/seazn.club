// A script that runs while the browser parses the server's HTML, before the first paint (Next's guide,
// docs/01-app/02-guides/preventing-flash-before-hydration.md, "Extracting a reusable component"). When React draws it in
// the browser instead (a client-side navigation), the type is `text/plain`: a script React inserts never runs, and React
// warns about a live one. The component around it must get the same result from its own state then.
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
