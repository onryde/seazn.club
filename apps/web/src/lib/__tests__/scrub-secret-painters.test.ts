// An element that PAINTS a scrubbed secret must carry `ph-no-capture`.
//
// PostHog replay compresses its DOM frames before `before_send` can see them, so the scrubber (scrub-score-url.ts) never gets
// to clean a secret that is rendered into the page: the claim link a failed email leaves on screen, the dev sign-in link, a
// team's join link. The recorder blocks exactly one thing, an element with the class `ph-no-capture`
// (components/v2/seazn-qr-image.tsx, the rule every sensitive QR already follows), and a blocked element's attributes are
// dropped from the frame along with its text.
//
// This is a source scan with a parser (the TypeScript compiler API), derived rather than typed:
//  - the VOCABULARY of secret-bound names comes from the scrubber's own secret routes (`VERDICTS`: the path segment before
//    each credential segment) and from the route builders that scrubScoreUrl really changes (`routes.claim`, `routes.checkin`):
//    a variable, property or function whose initialiser builds one of those URLs (`const claim_url = `${base}${routes.claim(s)}``)
//    is secret-bound; so is the scrubbed `join_code` query parameter and its camelCase;
//  - the names are followed through `useState` (`setLink(out.claim_url)` makes `link` secret-bound) and local `const`s;
//  - a secret handed to a COMPONENT as a prop is followed into that component's file: `<AuthForm next={`/claim/${token}`} />`
//    makes `next` secret-bound there, and a template or `encodeURIComponent(...)` built from a bound name is bound too, so
//    its `<a href={`/api/auth/google?next=${encodeURIComponent(next)}`}>` is a painter (review 2: the Google button's href
//    carried the claim secret, and the scan, which only knew names bound in a file, never saw it);
//  - a secret stored in an object field a component builds for its siblings (`{ next: lichessReturn }` -> `lichess.next` in the
//    step next door) binds that field's name in the files of the same directory;
//  - every JSX site that PAINTS one (an interpolated text child, or an attribute other than an event handler) is found;
//  - each painting element, or an ancestor in the same file, must carry the class, unless its file is in `PAINTERS` with a
//    reason it does not paint the secret. A file with a painter that is in neither list fails: a new painter needs a verdict.
//
// Sport: not applicable (the registry sweep does not reach a scan of the page source).
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { routes } from "@/lib/routes";
import { NOT_ONE_TIME, SRC_DIR, VERDICTS, linkBuilders } from "./_route-scan";
import { JOIN_CODE_PARAMS, scrubScoreUrl } from "../scrub-score-url";

const CLASS = "ph-no-capture";
/** A real-shaped secret for probing which route builders the scrubber treats as credential URLs. */
const PROBE = "k3Yp9QwErTyUiOpAsDfGhJkLzXcVbNm1";

// ---- the sources --------------------------------------------------------------------------------------------------------

interface Source {
  rel: string;
  file: ts.SourceFile;
  tsx: boolean;
}
function sources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !/\.d\.ts$/.test(e.name) && e.name !== "scrub-score-url.ts") {
        const text = fs.readFileSync(full, "utf8");
        const tsx = e.name.endsWith("x");
        out.push({
          rel: path.relative(SRC_DIR, full),
          tsx,
          file: ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
        });
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

// ---- the vocabulary -------------------------------------------------------------------------------------------------------

/** `routes.<name>(` for each builder the scrubber changes the output of (a credential URL), derived by calling it. */
function secretBuilderNames(): string[] {
  return Object.entries(routes)
    .filter(([, fn]) => {
      const url = `https://seazn.club${(fn as (...a: string[]) => string)(...Array.from({ length: 4 }, () => PROBE))}`;
      return scrubScoreUrl(url) !== url;
    })
    .map(([name]) => name);
}
/** The path segment before a credential segment, from the secret-route table: `join/[token]` -> `join`. */
function secretSegments(): string[] {
  return [
    ...new Set(
      Object.entries(VERDICTS)
        .filter(([, verdict]) => verdict === true)
        .map(([key]) => key.split("/").filter((s) => !/^\(.*\)$/.test(s)))
        .map((segs) => segs[segs.length - 2]!),
    ),
  ];
}
/** The one-time links the app builds as `<path>?token=${...}`, from the scan the other scrub suites share (the reusable cart link is not one). */
function oneTimeLinkPaths(): string[] {
  return [...linkBuilders().keys()].filter((p) => !(p in NOT_ONE_TIME));
}
/** The text of a template that builds a credential URL: `/<segment>/${`, `routes.<builder>(`, `<one-time path>?token=${`, the scrubbed `join_code=`. */
function secretTemplate(): RegExp {
  const links = oneTimeLinkPaths().map((p) => `${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?(?:[^\`\\s]*&)?token=\\$\\{`);
  return new RegExp(
    [`/(?:${secretSegments().join("|")})/\\$\\{`, `\\broutes\\.(?:${secretBuilderNames().join("|")})\\(`, `[?&]join_code=`, ...links].join("|"),
  );
}
/**
 * The names the scrubber scrubs by NAME rather than by route: the join code's parameters, and their camelCase. A bare `join`
 * is left out (every array has a `.join`); the deep link's code is read into `joinCode` by the register page.
 */
const SEED_NAMES = JOIN_CODE_PARAMS.filter((name) => name.includes("_")).flatMap((name) => [name, name.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())]);

// ---- the scan -------------------------------------------------------------------------------------------------------------

/** Every identifier, and the final name of every property access, in an expression. */
const namesIn = (node: ts.Node): string[] => {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else if (ts.isPropertyAccessExpression(n)) {
      out.push(n.name.text);
      visit(n.expression);
    } else ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
};
const hasJsx = (node: ts.Node): boolean => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
};
const unwrap = (n: ts.Expression): ts.Expression => {
  let cur = n;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
  return cur;
};

/** An API route's file as the pattern its URL has in a client's source: `app/api/v1/fixtures/[id]/checkin-link/route.ts` -> `/api/v1/fixtures/${…}/checkin-link`. */
function endpointCall(rel: string): RegExp {
  const segs = rel.replace(/^app\//, "").replace(/\/route\.tsx?$/, "").split("/").filter((s) => !/^\(.*\)$/.test(s));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("/" + segs.map((s) => (/^\[.+\]$/.test(s) ? "\\$\\{[^}]*\\}" : esc(s))).join("/") + "(?![\\w/-])");
}

/** Calls that return their argument in another spelling: `encodeURIComponent(next)` is as secret as `next`. */
const PASS_THROUGH = new Set(["encodeURIComponent", "encodeURI", "decodeURIComponent", "decodeURI", "String"]);

/** Names too common to carry a secret across files by themselves. */
const GENERIC = new Set(["url", "link", "href", "code", "token", "secret", "value", "path", "data", "result"]);

/** What the scan has learned so far: names bound to a credential URL, per file and across the app. */
interface Known {
  /** A generic JSON field (`url`) an API route replies with a credential under, and the pattern of its endpoint in a client's source. */
  endpoints: { key: string; call: RegExp; route: string }[];
  /** Names that cross a file: a JSON field an API route replies with, an exported function that builds the URL, the seeds. */
  global: Set<string>;
  local: Map<string, Set<string>>;
  /** Secrets handed to a component as a prop, and the call site: `<AuthForm next={`/claim/${token}`} />` -> AuthForm / next. */
  props: { component: string; prop: string; from: string }[];
}

/** Is this expression a credential URL, or a value derived straight from one (a template, a builder call, a bound name)? */
function isSecretValue(node: ts.Expression, file: ts.SourceFile, known: Known, template: RegExp, builders: Set<string>): boolean {
  const e = unwrap(node);
  const local = known.local.get(file.fileName)!;
  const again = (x: ts.Expression) => isSecretValue(x, file, known, template, builders);
  // A template is a credential URL by its text, or by what it interpolates (`/api/auth/google?next=${encodeURIComponent(next)}`).
  if (ts.isTemplateExpression(e)) return template.test(e.getText(file)) || e.templateSpans.some((span) => again(span.expression));
  if (ts.isNoSubstitutionTemplateLiteral(e)) return template.test(e.getText(file));
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    // A wrapper that returns the value in another spelling keeps it a secret.
    if (ts.isIdentifier(callee) && PASS_THROUGH.has(callee.text)) return e.arguments.some((a) => again(a));
    if (ts.isPropertyAccessExpression(callee) && callee.expression.getText(file) === "routes" && builders.has(callee.name.text)) return true;
    // A call of a function known to build one: `claimHref(...)`.
    return ts.isIdentifier(callee) && (local.has(callee.text) || known.global.has(callee.text));
  }
  if (ts.isConditionalExpression(e)) return again(e.whenTrue) || again(e.whenFalse);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) return again(e.left) || again(e.right);
    return false;
  }
  if (ts.isIdentifier(e)) return local.has(e.text) || known.global.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return known.global.has(e.name.text) || local.has(e.name.text);
  return false;
}
/** Does a function-like build a credential URL (an expression body, or a `return` of one)? */
function buildsSecret(fn: ts.FunctionLikeDeclaration, file: ts.SourceFile, known: Known, template: RegExp, builders: Set<string>): boolean {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return isSecretValue(fn.body, file, known, template, builders);
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression && isSecretValue(n.expression, file, known, template, builders)) found = true;
    if (!ts.isFunctionLike(n) || n === fn) ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return found;
}

/** Where each component is declared (an uppercase function or arrow-function const), and whether another file can import it. */
function componentDecls(all: Source[]): Map<string, { fileName: string; exported: boolean }[]> {
  const out = new Map<string, { fileName: string; exported: boolean }[]>();
  const isExported = (n: ts.Node) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const { file, tsx } of all) {
    if (!tsx) continue;
    const add = (name: string, exported: boolean) => out.set(name, [...(out.get(name) ?? []), { fileName: file.fileName, exported }]);
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text)) add(n.name.text, isExported(n));
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer) {
        const init = unwrap(n.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(n.name.text, isExported(n.parent.parent));
      }
      ts.forEachChild(n, visit);
    };
    visit(file);
  }
  return out;
}

/** Learn the secret-bound names of every file, to a fixed point (a file's names feed the files that import them). */
function learn(all: Source[]): Known {
  const template = secretTemplate();
  const builders = new Set(secretBuilderNames());
  const components = componentDecls(all);
  const byDir = new Map<string, Source[]>();
  for (const s of all) if (s.tsx) byDir.set(path.dirname(s.file.fileName), [...(byDir.get(path.dirname(s.file.fileName)) ?? []), s]);
  const known: Known = { endpoints: [], global: new Set(SEED_NAMES), local: new Map(all.map((s) => [s.file.fileName, new Set<string>(SEED_NAMES)])), props: [] };
  for (let changed = true; changed; ) {
    changed = false;
    for (const { file, rel } of all) {
      const local = known.local.get(file.fileName)!;
      const isRoute = /(^|\/)route\.tsx?$/.test(rel);
      const setters = new Map<string, string>();
      const addLocal = (name: string) => {
        if (!local.has(name)) {
          local.add(name);
          changed = true;
        }
      };
      const addGlobal = (name: string) => {
        if (GENERIC.has(name)) {
          // Not app-wide: every object has a `url`, and `x.url` would make everything that reads one a credential. Only the files
          // that call THIS endpoint read it as one.
          if (!known.endpoints.some((e) => e.key === name && e.route === rel)) {
            known.endpoints.push({ key: name, route: rel, call: endpointCall(rel) });
            changed = true;
          }
        } else if (!known.global.has(name)) {
          known.global.add(name);
          changed = true;
        }
      };
      for (const e of known.endpoints) if (!isRoute && e.call.test(file.text)) addLocal(e.key);
      const visit = (n: ts.Node) => {
        const secret = (x: ts.Expression) => isSecretValue(x, file, known, template, builders);
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          // A secret handed to a component as a prop is a secret in the files that declare that component.
          const tag = n.tagName.getText(file);
          if (isComponentTag(tag)) {
            for (const attr of n.attributes.properties) {
              if (!ts.isJsxAttribute(attr) || NOT_PAINTED_ATTR.test(attr.name.getText(file))) continue;
              if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression || !secret(attr.initializer.expression)) continue;
              const prop = attr.name.getText(file);
              for (const decl of components.get(tag) ?? []) {
                if (!decl.exported && decl.fileName !== file.fileName) continue;
                const names = known.local.get(decl.fileName)!;
                if (!names.has(prop)) {
                  names.add(prop);
                  changed = true;
                }
              }
              if (!known.props.some((p) => p.component === tag && p.prop === prop && p.from === rel)) known.props.push({ component: tag, prop, from: rel });
            }
          }
        }
        if (ts.isVariableDeclaration(n)) {
          if (ts.isArrayBindingPattern(n.name) && n.name.elements.length === 2 && n.initializer?.getText(file).startsWith("useState")) {
            const [state, setter] = n.name.elements as unknown as ts.BindingElement[];
            if (ts.isIdentifier(state!.name) && ts.isIdentifier(setter!.name)) setters.set(setter!.name.text, state!.name.text);
          } else if (ts.isIdentifier(n.name) && n.initializer) {
            const init = unwrap(n.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? buildsSecret(init, file, known, template, builders) : secret(init)) {
              addLocal(n.name.text);
              // An exported function that builds the URL is imported by name.
              if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && /\bexport\b/.test(n.parent.parent.getText(file).slice(0, 30))) addGlobal(n.name.text);
            }
          }
        } else if (ts.isFunctionDeclaration(n) && n.name && buildsSecret(n, file, known, template, builders)) {
          addLocal(n.name.text);
          if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) addGlobal(n.name.text);
        } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && secret(n.right)) {
          addLocal(n.left.text);
        } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && setters.has(n.expression.text) && n.arguments.some((a) => secret(a))) {
          addLocal(setters.get(n.expression.text)!);
        } else if (isRoute && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && secret(n.initializer)) {
          // A JSON field an API route replies with crosses to every client that reads it.
          addGlobal(n.name.text);
        } else if (isRoute && ts.isShorthandPropertyAssignment(n) && local.has(n.name.text)) {
          addGlobal(n.name.text);
        } else if (!isRoute && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && !GENERIC.has(n.name.text) && secret(n.initializer)) {
          // A field a component builds for the components beside it.
          for (const sibling of byDir.get(path.dirname(file.fileName)) ?? []) {
            const names = known.local.get(sibling.file.fileName)!;
            if (!names.has(n.name.text)) {
              names.add(n.name.text);
              changed = true;
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(file);
    }
  }
  return known;
}

/** An attribute that is not painted: an event handler, a React bookkeeping prop, a layout prop. */
const NOT_PAINTED_ATTR = /^(?:on[A-Z]|key$|ref$|className$|style$|id$|htmlFor$|disabled$|type$|name$|role$|hidden$)/;
const isComponentTag = (tag: string) => /^[A-Z]/.test(tag);

interface Site {
  line: number;
  names: string[];
  /** The painting element's tag, for the message. */
  tag: string;
  /** True when it, or an ancestor in the file, carries the class. */
  blocked: boolean;
  /** True when it is a component (the value goes to ITS file to paint). */
  component: boolean;
  how: string;
}
function sitesIn(file: ts.SourceFile, known: Known): Site[] {
  const secret = new Set([...known.global, ...known.local.get(file.fileName)!]);
  const out: Site[] = [];
  const carries = (el: ts.JsxOpeningLikeElement) =>
    el.attributes.properties.some((a) => {
      if (!ts.isJsxAttribute(a) || a.name.getText(file) !== "className") return false;
      const text = a.initializer?.getText(file) ?? "";
      return text.includes(CLASS) || /qrCaptureClass\(|QR_NO_CAPTURE/.test(text);
    });
  const openingOf = (el: ts.Node): ts.JsxOpeningLikeElement | undefined =>
    ts.isJsxElement(el) ? el.openingElement : ts.isJsxSelfClosingElement(el) ? el : undefined;
  const ancestorsBlocked = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node; p; p = p.parent) {
      const open = openingOf(p);
      if (open && carries(open)) return true;
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxExpression(n) && n.expression) {
      const par = n.parent;
      const hit = namesIn(n.expression).filter((x) => secret.has(x));
      if (hit.length) {
        const line = file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
        if (ts.isJsxAttribute(par)) {
          if (!NOT_PAINTED_ATTR.test(par.name.getText(file))) {
            const open = par.parent.parent as ts.JsxOpeningLikeElement;
            const tag = open.tagName.getText(file);
            out.push({ line, names: hit, tag, blocked: ancestorsBlocked(open), component: isComponentTag(tag), how: `attribute ${par.name.getText(file)}` });
          }
        } else if (!hasJsx(n.expression)) {
          // A text child: `{link}`, `{t(..., { masked })}`. (An expression with JSX in it paints through that JSX.)
          const el = par as ts.JsxElement | ts.JsxFragment;
          out.push({ line, names: hit, tag: ts.isJsxElement(el) ? el.openingElement.tagName.getText(file) : "<>", blocked: ancestorsBlocked(el), component: false, how: "text" });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

// ---- the verdicts ---------------------------------------------------------------------------------------------------------

/**
 * Every file with a painter, and its verdict: `true` = each painting element carries `ph-no-capture` (asserted); a string = why
 * the file paints no secret that needs it; `handoff` names the file a component passes the secret to as a prop. The props a
 * component receives a secret under are found by the scan (`Known.props`), not listed here.
 */
const PAINTERS: Record<string, { verdict: true | string; handoff?: string }> = {
  "components/v2/invite-claim.tsx": { verdict: true },
  "components/v2/officials-shared.tsx": { verdict: true },
  "components/start-wizard.tsx": { verdict: true },
  "components/auth-form.tsx": { verdict: true },
  "components/v2/checkin-qr.tsx": { verdict: true },
  "components/v2/device-link-panel.tsx": { verdict: true },
  "components/registration-hub-registrant-join-code.tsx": { verdict: true },
  "components/public-site/register/register-lichess-card.tsx": { verdict: true },
  "components/public-site/register/step-consent.tsx": {
    verdict: "passes the register page's return path (which carries the join code) to RegisterLichessCard as a prop and paints nothing itself",
    handoff: "components/public-site/register/register-lichess-card.tsx",
  },
  "components/public-site/register/register-stepper.tsx": { verdict: true },
  "app/(public)/shared/[orgSlug]/[competitionSlug]/register/status/entry-card.tsx": { verdict: true },
  "components/registration-hub-registrant-detail.tsx": {
    verdict: "passes the team's join code to RegistrationHubRegistrantJoinCode as a prop and paints nothing itself",
    handoff: "components/registration-hub-registrant-join-code.tsx",
  },
  // The Lichess refusal's link: its `href` carries the return path, which carries the join code (`?join_code=`), a capability token.
  "app/(public)/shared/[orgSlug]/[competitionSlug]/register/join/join-form.tsx": { verdict: true },
  "app/(public)/shared/[orgSlug]/[competitionSlug]/register/join/page.tsx": {
    verdict:
      "passes join_code to JoinForm as a prop (and to previewJoinEntry on the server): JoinForm uses it in the preview request's URL and the join POST body, and paints it only into the Lichess refusal link's href (join-form.tsx, verdict true above), never anywhere else",
  },
  "components/org-team.tsx": {
    verdict:
      "paints the MASKED link (`/join/abcd…wxyz`: first and last four characters, deliberate against shoulder-surfing); the full URL goes only to the clipboard",
  },
};

describe("every element that paints a scrubbed secret carries ph-no-capture, or its file says why not", () => {
  const all = sources();
  const known = learn(all);
  const painters = new Map<string, Site[]>();
  for (const { rel, file, tsx } of all) {
    if (!tsx) continue;
    const sites = sitesIn(file, known);
    if (sites.length) painters.set(rel, sites);
  }

  it("the scan found the vocabulary and the painters (anti-vacuity)", () => {
    expect(all.length).toBeGreaterThan(500);
    // The builders and segments come from the app, not from this test.
    expect(secretBuilderNames().sort()).toEqual(["checkin", "claim"]);
    expect(oneTimeLinkPaths().length).toBeGreaterThanOrEqual(5);
    expect(secretSegments().sort()).toEqual(expect.arrayContaining(["checkin", "claim", "join", "score"]));
    // The names the producers really use.
    expect(SEED_NAMES).toEqual(["join_code", "joinCode"]);
    expect([...known.global]).toEqual(expect.arrayContaining(["claim_url", "login_url", "join_code", "joinCode"]));
    // A generic field (`url`) is followed by its endpoint, not app-wide: the check-in link route replies `{ url }`.
    expect(known.endpoints.some((e) => e.key === "url" && e.route.includes("checkin-link"))).toBe(true);
    expect(known.global.has("url")).toBe(false);
    // A secret handed to a component as a prop is followed into it: the sign-in form gets `next={`/claim/${token}`}` (and the
    // join and check-in pages' twins), and paints it into the Google button's href.
    const nexts = known.props.filter((p) => p.component === "AuthForm" && p.prop === "next").map((p) => p.from);
    expect(nexts.sort()).toEqual(expect.arrayContaining(["app/checkin/[token]/page.tsx", "app/claim/[token]/page.tsx", "app/join/[token]/page.tsx", "components/claim-invite.tsx"]));
    // The scan REACHES the hrefs that carry a secret under another name: the Google button (`next` prop -> `googleHref`, through
    // a template and `encodeURIComponent`), the Lichess links (the return path's join code, through a sibling's object field).
    const hrefNames = (rel: string) => (painters.get(rel) ?? []).filter((s) => s.how === "attribute href").flatMap((s) => s.names);
    expect(hrefNames("components/auth-form.tsx")).toContain("googleHref");
    expect(hrefNames("components/public-site/register/register-stepper.tsx")).toContain("lichessReturn");
    expect(hrefNames("components/public-site/register/register-lichess-card.tsx")).toContain("next");
    // ... and the join page's refusal link, whose return path interpolates the join code itself.
    expect(hrefNames("app/(public)/shared/[orgSlug]/[competitionSlug]/register/join/join-form.tsx")).toContain("joinCode");
    expect(painters.size).toBeGreaterThanOrEqual(12);
    let sites = 0;
    for (const s of painters.values()) sites += s.length;
    expect(sites).toBeGreaterThanOrEqual(14);
  });

  it("the painter files and the verdict table are the same set", () => {
    const found = [...painters.keys()].sort();
    const listed = Object.keys(PAINTERS).sort();
    const diff = [...found.filter((f) => !listed.includes(f)).map((f) => `+ ${f}`), ...listed.filter((f) => !found.includes(f)).map((f) => `- ${f}`)];
    expect(found, `a file paints a secret: add it to PAINTERS with a verdict (and the class), or drop the stale entry:\n${diff.join("\n")}`).toEqual(listed);
  });

  it("each file with verdict true: every painting element, or an ancestor, carries ph-no-capture (a component gets the secret as a prop and is checked in its own file)", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const [rel, { verdict }] of Object.entries(PAINTERS)) {
      if (verdict !== true) continue;
      for (const site of painters.get(rel) ?? []) {
        if (site.component) continue;
        checked++;
        if (!site.blocked) failures.push(`${rel}:${site.line} <${site.tag}> paints ${site.names.join("/")} as ${site.how} without ph-no-capture`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("each file with a reason is not a free pass: it paints something, the reason names why, and a hand-off lands in a file that is blocked", () => {
    let reasons = 0;
    let handoffs = 0;
    for (const [rel, { verdict, handoff }] of Object.entries(PAINTERS)) {
      if (handoff) {
        handoffs++;
        expect(PAINTERS[handoff]?.verdict, `${rel} hands the secret to ${handoff}, which must be verdict true`).toBe(true);
        expect((painters.get(rel) ?? []).every((s) => s.component), `${rel}: a hand-off file paints only through components`).toBe(true);
      }
      if (verdict === true) continue;
      expect((painters.get(rel) ?? []).length, `${rel}: stale entry`).toBeGreaterThan(0);
      expect(verdict.length, `${rel}: say why`).toBeGreaterThan(30);
      reasons++;
    }
    expect(reasons).toBeGreaterThanOrEqual(3);
    expect(handoffs).toBeGreaterThanOrEqual(1);
  });
});
