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
//  - the names are followed through `useState` (`setLink(out.claim_url)` makes `link` secret-bound) and local `const`s, through
//    a `Promise.all` destructure by position (`const [names, href] = await Promise.all([…, homeHref(…)])`), and into the
//    parameter of a function of the same file a secret is passed to (`scanColumn(href, …)` binds its `backHref`): the pad's
//    way back to its quick match (`/q/<token>`) reaches its link only through both hops (quick match plan 2 Task 5, A6);
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
  /** Where each component of the scanned tree is declared (`componentDecls`): the files a prop hop can land in. */
  components: Map<string, { fileName: string; exported: boolean }[]>;
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
  const known: Known = {
    endpoints: [],
    global: new Set(SEED_NAMES),
    local: new Map(all.map((s) => [s.file.fileName, new Set<string>(SEED_NAMES)])),
    props: [],
    components,
  };
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
      // The parameters of the file's own named functions, so a secret passed to one binds the parameter it lands in.
      const params = new Map<string, readonly ts.ParameterDeclaration[]>();
      const collect = (n: ts.Node) => {
        if (ts.isFunctionDeclaration(n) && n.name) params.set(n.name.text, n.parameters);
        else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          const init = unwrap(n.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) params.set(n.name.text, init.parameters);
        }
        ts.forEachChild(n, collect);
      };
      collect(file);
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
          } else if (ts.isArrayBindingPattern(n.name) && n.initializer) {
            // `const [a, b] = await Promise.all([x, y])`: each name is as secret as the value in its place.
            const init = unwrap(n.initializer);
            const list = ts.isCallExpression(init) && init.expression.getText(file) === "Promise.all" ? init.arguments[0] : undefined;
            if (list && ts.isArrayLiteralExpression(list)) {
              n.name.elements.forEach((el, i) => {
                const value = list.elements[i];
                if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && value && !ts.isSpreadElement(value) && secret(value)) addLocal(el.name.text);
              });
            }
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
        } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && params.has(n.expression.text)) {
          // A secret passed to a function of this file binds the parameter it lands in.
          const declared = params.get(n.expression.text)!;
          n.arguments.forEach((arg, i) => {
            const param = declared[i];
            if (param && ts.isIdentifier(param.name) && secret(arg)) addLocal(param.name.text);
          });
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
/** The vocabulary `isSecretValue` reads, derived once (the one-time link scan walks the tree). */
let vocabulary: { template: RegExp; builders: Set<string> } | undefined;
const secretVocabulary = () => (vocabulary ??= { template: secretTemplate(), builders: new Set(secretBuilderNames()) });

function sitesIn(file: ts.SourceFile, known: Known): Site[] {
  const secret = new Set([...known.global, ...known.local.get(file.fileName)!]);
  const { template, builders } = secretVocabulary();
  const out: Site[] = [];
  // A component the prop hop follows (`learn`): declared in the tree, and exported or in this file. Any other uppercase tag
  // (`Link` from next/link, a third-party component) lands in a file the scan never reads, so its site is checked HERE.
  const followed = (tag: string) =>
    isComponentTag(tag) && (known.components.get(tag) ?? []).some((d) => d.exported || d.fileName === file.fileName);
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
      // A name bound to a credential URL, or the URL written inline (`href={routes.quickMatch(token)}`, `{`/claim/${t}`}`),
      // which names nothing the scan learned: the value itself is the secret (ledger CARRY to T7).
      const named = namesIn(n.expression).filter((x) => secret.has(x));
      const hit = named.length || !isSecretValue(n.expression, file, known, template, builders) ? named : [n.expression.getText(file)];
      if (hit.length) {
        const line = file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
        if (ts.isJsxAttribute(par)) {
          if (!NOT_PAINTED_ATTR.test(par.name.getText(file))) {
            const open = par.parent.parent as ts.JsxOpeningLikeElement;
            const tag = open.tagName.getText(file);
            out.push({ line, names: hit, tag, blocked: ancestorsBlocked(open), component: followed(tag), how: `attribute ${par.name.getText(file)}` });
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

/** The sites of a hand-off file that do NOT hand the secret to a component declared in one of its named target files: a
 *  site painted here, or a prop handed to some other component, is not the hand-off its verdict names. */
function strayHandoffs(sites: Site[], targets: string[], known: Known): Site[] {
  const files = new Set(targets.map((t) => path.join(SRC_DIR, t)));
  return sites.filter((s) => !s.component || !(known.components.get(s.tag) ?? []).some((d) => files.has(d.fileName)));
}

// ---- the verdicts ---------------------------------------------------------------------------------------------------------

/**
 * Every file with a painter, and its verdict: `true` = each painting element carries `ph-no-capture` (asserted); a string = why
 * the file paints no secret that needs it; `handoff` names the file (or files) a component passes the secret to as a prop. The
 * props a component receives a secret under are found by the scan (`Known.props`), not listed here.
 */
const PAINTERS: Record<string, { verdict: true | string; handoff?: string | string[] }> = {
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
  // Polish wave P6: the captain's invite links are built and painted by InviteTeammates (each row is ph-no-capture); the card hands it the code.
  "app/(public)/live/[orgSlug]/[competitionSlug]/register/status/entry-card.tsx": {
    verdict: "passes the team's join code to InviteTeammates as a prop and paints nothing itself",
    handoff: "app/(public)/live/[orgSlug]/[competitionSlug]/register/status/invite-teammates.tsx",
  },
  "app/(public)/live/[orgSlug]/[competitionSlug]/register/status/invite-teammates.tsx": { verdict: true },
  "components/registration-hub-registrant-detail.tsx": {
    verdict: "passes the team's join link (built by joinLinkPath) to RegistrationHubRegistrantJoinCode as a prop and paints nothing itself",
    handoff: "components/registration-hub-registrant-join-code.tsx",
  },
  // The Lichess refusal's link: its `href` carries the return path, which carries the join code (`?join_code=`), a capability token.
  "app/(public)/live/[orgSlug]/[competitionSlug]/register/join/join-form.tsx": { verdict: true },
  "app/(public)/live/[orgSlug]/[competitionSlug]/register/join/page.tsx": {
    verdict:
      "passes join_code to JoinForm as a prop (and to previewJoinEntry on the server): JoinForm uses it in the preview request's URL and the join POST body, and paints it only into the Lichess refusal link's href (join-form.tsx, verdict true above), never anywhere else",
  },
  // Sponsor deals T22: the invoice page's PDF link and pay form carry the invoice token (`/r/sponsor/invoice/<token>/pdf`, `/pay`).
  "components/sponsors/invoice-view.tsx": { verdict: true },
  // Task 23: the pay form is its own client island (a double click sends one post); invoice-view hands it the pay action.
  "components/sponsors/invoice-pay-form.tsx": { verdict: true },
  "app/(public)/r/sponsor/invoice/[token]/page.tsx": {
    verdict: "builds the invoice's PDF link and pay action from the token and hands both to SponsorInvoiceView as props; it paints nothing itself",
    handoff: "components/sponsors/invoice-view.tsx",
  },
  // Player payment page (Task 4): the Pay form's action carries the token (`/r/pay/<token>/pay`).
  "components/registrations/pay-page-view.tsx": { verdict: true },
  "app/(public)/r/pay/[token]/page.tsx": {
    verdict: "builds the Pay action from the token and hands it to PayPageView as a prop; it paints nothing itself",
    handoff: "components/registrations/pay-page-view.tsx",
  },
  "components/org-team.tsx": {
    verdict:
      "paints the MASKED link (`/join/abcd…wxyz`: first and last four characters, deliberate against shoulder-surfing); the full URL goes only to the clipboard",
  },
  // A quick match's pad: its way back to the home, `/q/<home token>` (quick match plan 1 Task 9; plan 2 Task 5, A6).
  "components/v2/quick-match-back-link.tsx": { verdict: true },
  "app/score/[token]/page.tsx": {
    verdict: "builds the quick match's home URL and hands it to QuickMatchBackLink as its href; the page paints it nowhere itself",
    handoff: "components/v2/quick-match-back-link.tsx",
  },
  // The home's Score control: its form's action is `/q/<home token>/score/<fixture>` (quick match plan 2 Task 6). The page
  // builds it and hands it over as a prop, painting nothing itself, so the scan finds the painter here, not on the page.
  "components/quick-match/score-form.tsx": { verdict: true },
  // The recent strip: each row links to its home, `/q/<home token>` (quick match plan 2 Task 9).
  "components/quick-match/recent-strip.tsx": { verdict: true },
  // Found once the scan learned to read an INLINE credential URL (ledger CARRY to T7): each page writes its own secret path
  // straight into a component's prop, which the old name-only scan never saw as a site of the page.
  "app/checkin/[token]/page.tsx": {
    verdict: "writes its own `/checkin/<token>` path into AuthForm's `next` prop inline and paints it nowhere itself",
    handoff: "components/auth-form.tsx",
  },
  "app/claim/[token]/page.tsx": {
    verdict: "writes its own `/claim/<token>` path into AuthForm's `next` prop inline and paints it nowhere itself",
    handoff: "components/auth-form.tsx",
  },
  "app/join/[token]/page.tsx": {
    verdict: "writes its own `/join/<token>` path into AuthForm's `next` prop inline and paints it nowhere itself",
    handoff: "components/auth-form.tsx",
  },
  "components/claim-invite.tsx": {
    verdict: "writes the invite's `/join/<token>` path into AuthForm's `next` prop inline and paints it nowhere itself",
    handoff: "components/auth-form.tsx",
  },
  "components/claim-sign-in.tsx": {
    verdict: "writes the claim's `/claim/<token>` path into AuthForm's `next` prop inline and paints it nowhere itself",
    handoff: "components/auth-form.tsx",
  },
  // The quick match home (plan 2 Tasks 6, 7): builds `routes.quickMatchScore(token, fixture)` inline into the Score form's `action`,
  // and `routes.quickMatch(token)` into the Share island's `path`.
  "app/q/[token]/page.tsx": {
    verdict:
      "builds the home's own `/q/<token>` paths inline into its islands' props (the Score form's action, the Share island's path) and paints them nowhere itself",
    handoff: ["components/quick-match/score-form.tsx", "components/quick-match/share.tsx"],
  },
  // The home's Share (plan 2 Task 7): the home link in its read-only field, handed to the share sheet; the QR is `sensitive`.
  "components/quick-match/share.tsx": { verdict: true },
};

/** The files that paint a quick match's home URL, `/q/<token>`: every one must be FOUND by the scan, not just listed, or a
 *  painter that loses its class goes unseen. Plan 2 Tasks 6, 7 and 9 add theirs (the Score form, the share link, the strip). */
const QUICK_MATCH_PAINTERS = [
  "app/score/[token]/page.tsx",
  "components/v2/quick-match-back-link.tsx",
  "components/quick-match/score-form.tsx",
  "components/quick-match/recent-strip.tsx",
  // The home itself: it writes `routes.quickMatch(token)` inline into its islands' props (ledger CARRY to T7).
  "app/q/[token]/page.tsx",
  "components/quick-match/share.tsx",
];

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
    // quickMatch: the guest's home, `/q/<token>` (quick match plan 2, A6); quickMatchSave: its save page, `/q/<token>/save`
    // (plan 3 Task 2, the reminder mail's link); quickMatchScore: its Score post, `/q/<token>/score/<fixture>` (branch fix A).
    expect(secretBuilderNames().sort()).toEqual(["checkin", "claim", "quickMatch", "quickMatchSave", "quickMatchScore"]);
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
    expect(hrefNames("app/(public)/live/[orgSlug]/[competitionSlug]/register/join/join-form.tsx")).toContain("joinCode");
    expect(painters.size).toBeGreaterThanOrEqual(12);
    let sites = 0;
    for (const s of painters.values()) sites += s.length;
    expect(sites).toBeGreaterThanOrEqual(14);
  });

  it("the scan reaches every file that paints a quick match's home URL (A6): the pad's back link through two hops", () => {
    let checked = 0;
    for (const rel of QUICK_MATCH_PAINTERS) {
      expect(painters.has(rel), `${rel} paints /q/<token>: the scan must find it`).toBe(true);
      expect(PAINTERS[rel], `${rel} has a verdict`).toBeDefined();
      checked++;
    }
    expect(checked).toBe(QUICK_MATCH_PAINTERS.length);
    // The route the hops follow, so a refactor that breaks one of them reds here and not in a blind green.
    expect(known.props).toEqual(
      expect.arrayContaining([{ component: "QuickMatchBackLink", prop: "href", from: "app/score/[token]/page.tsx" }]),
    );
    const link = painters.get("components/v2/quick-match-back-link.tsx") ?? [];
    expect(link.filter((site) => site.how === "attribute href" && site.tag === "a").map((site) => site.blocked)).toEqual([true]);
    // The recent strip's one row link (plan 2 Task 9): a host <a>, so its class is checked here and not handed off.
    const strip = painters.get("components/quick-match/recent-strip.tsx") ?? [];
    expect(strip.filter((site) => site.how === "attribute href" && site.tag === "a").map((site) => site.blocked)).toEqual([true]);
  });

  it("the home's Score form (Task 6): the page hands its action to QuickMatchScoreForm, whose host <form> carries the class", () => {
    // The hop the scan follows: the home page builds `routes.quickMatchScore(token, id)` straight into the prop.
    expect(known.props).toEqual(
      expect.arrayContaining([{ component: "QuickMatchScoreForm", prop: "action", from: "app/q/[token]/page.tsx" }]),
    );
    const form = painters.get("components/quick-match/score-form.tsx") ?? [];
    expect(form.filter((site) => site.how === "attribute action" && site.tag === "form").map((site) => site.blocked)).toEqual([true]);
    // ... and the page's own site, now that an inline credential URL is one: a component, so it is checked in that file.
    const page = painters.get("app/q/[token]/page.tsx") ?? [];
    expect(page.filter((site) => site.tag === "QuickMatchScoreForm").map((site) => [site.how, site.component])).toEqual([
      ["attribute action", true],
    ]);
  });

  it("the home's Share (Task 7): the page hands the home path to QuickMatchShare inline; the island's link field carries the class", () => {
    // The hop: `path={routes.quickMatch(token)}`, written inline, so only the inline rule finds the page's site.
    expect(known.props).toEqual(expect.arrayContaining([{ component: "QuickMatchShare", prop: "path", from: "app/q/[token]/page.tsx" }]));
    const page = painters.get("app/q/[token]/page.tsx") ?? [];
    expect(page.filter((site) => site.tag === "QuickMatchShare").map((site) => [site.how, site.component])).toEqual([["attribute path", true]]);
    // In the island, the path becomes the URL its field shows, and the URL it hands to the share sheet (a component whose
    // own file paints nothing of it: share-button.tsx is no painter).
    const share = painters.get("components/quick-match/share.tsx") ?? [];
    expect(share.filter((site) => site.tag === "input").map((site) => [site.how, site.blocked])).toEqual([["attribute value", true]]);
    expect(share.filter((site) => site.tag === "ShareButton").map((site) => [site.how, site.component])).toEqual([["attribute url", true]]);
    expect(known.props).toEqual(expect.arrayContaining([{ component: "ShareButton", prop: "url", from: "components/quick-match/share.tsx" }]));
    expect(painters.has("components/share-button.tsx")).toBe(false);
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
        const targets = [handoff].flat();
        expect(targets.length, `${rel}: a hand-off names its file`).toBeGreaterThan(0);
        for (const target of targets) {
          handoffs++;
          expect(PAINTERS[target]?.verdict, `${rel} hands the secret to ${target}, which must be verdict true`).toBe(true);
        }
        const strays = strayHandoffs(painters.get(rel) ?? [], targets, known).map((s) => `${rel}:${s.line} <${s.tag}> ${s.how}`);
        expect(strays, `${rel}: a hand-off file paints only through its named targets' components:\n${strays.join("\n")}`).toEqual([]);
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

// Ledger CARRY to T7 (confirmed by the plan-2 T9 review): the scan used to find a painting site by the NAMES in its
// expression only, so a credential URL written INLINE, `<a href={routes.quickMatch(token)}>`, named nothing it knew and
// went unflagged. These files are parsed exactly as the scan parses the app's sources, and learned on their own.
describe("the scan flags a credential URL written inline in JSX, not only a name bound to one", () => {
  const sitesOf = (body: string, decls = ""): Site[] => {
    const rel = "components/__painter-fixture__/inline.tsx";
    const text = `import { routes } from "@/lib/routes";\nexport function Inline({ token }: { token: string }) {\n  return ${body};\n}\n${decls}`;
    const src: Source = {
      rel,
      tsx: true,
      file: ts.createSourceFile(path.join(SRC_DIR, rel), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    };
    return sitesIn(src.file, learn([src]));
  };
  const shape = (sites: Site[]) => sites.map((s) => [s.tag, s.how, s.blocked]);

  it("an inline href built by a credential builder is a painter: unblocked bare, blocked under the class", () => {
    expect(shape(sitesOf(`<a href={routes.quickMatch(token)}>open</a>`))).toEqual([["a", "attribute href", false]]);
    expect(shape(sitesOf(`<p className="ph-no-capture"><a href={routes.quickMatch(token)}>open</a></p>`))).toEqual([
      ["a", "attribute href", true],
    ]);
  });

  it("an inline credential template, and one printed as text, are painters too", () => {
    expect(shape(sitesOf(`<a href={\`/claim/\${token}\`}>claim</a>`))).toEqual([["a", "attribute href", false]]);
    expect(shape(sitesOf(`<code>{routes.checkin(token)}</code>`))).toEqual([["code", "text", false]]);
    // Handed to a component declared in the tree inline: a site of this file, checked in the component's own file.
    const island = `function Island(_: { path: string }) {\n  return null;\n}\n`;
    expect(sitesOf(`<Island path={routes.quickMatch(token)} />`, island).map((s) => [s.tag, s.component])).toEqual([["Island", true]]);
  });

  it("an uppercase tag the tree does not declare (`Link`, from next/link) is no hand-off: the scan cannot follow it, so it is a painter here", () => {
    // Review minor (T7): every uppercase tag used to count as a component, so `<Link href={routes.quickMatch(token)}>` was
    // skipped as "checked in its own file", a file the scan never reads.
    expect(sitesOf(`<Link href={routes.quickMatch(token)}>open</Link>`).map((s) => [s.tag, s.how, s.blocked, s.component])).toEqual([
      ["Link", "attribute href", false, false],
    ]);
    expect(sitesOf(`<Link className="ph-no-capture" href={routes.quickMatch(token)}>open</Link>`).map((s) => [s.tag, s.blocked, s.component])).toEqual([
      ["Link", true, false],
    ]);
  });
  it("an inline URL the scrubber leaves alone is not a painter (the negative pair)", () => {
    expect(sitesOf(`<a href={routes.me()}>me</a>`)).toEqual([]);
    expect(sitesOf(`<a href={\`/about/\${token}\`}>about</a>`)).toEqual([]);
  });
});

// The hand-off rule, on a page and the form it hands its link to, parsed and learned exactly as the app's sources are.
describe("a hand-off file passes its secret only to its named targets' components", () => {
  const fixture = (rel: string, text: string): Source => ({
    rel,
    tsx: true,
    file: ts.createSourceFile(path.join(SRC_DIR, rel), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  });
  const FORM = "components/__painter-fixture__/form.tsx";
  const OTHER = "components/__painter-fixture__/other.tsx";
  const strays = (body: string): string[] => {
    const page = fixture(
      "app/__painter-fixture__/page.tsx",
      `import Link from "next/link";\nimport { routes } from "@/lib/routes";\nimport { Form } from "@/components/__painter-fixture__/form";\nimport { Other } from "@/components/__painter-fixture__/other";\nexport default function Page({ token }: { token: string }) {\n  return <main>${body}</main>;\n}\n`,
    );
    const form = fixture(FORM, `export function Form({ next }: { next: string }) {\n  return <a className="ph-no-capture" href={next}>go</a>;\n}\n`);
    const other = fixture(OTHER, `export function Other({ next }: { next: string }) {\n  return <a className="ph-no-capture" href={next}>go</a>;\n}\n`);
    const known = learn([page, form, other]);
    return strayHandoffs(sitesIn(page.file, known), [FORM], known).map((s) => `<${s.tag}> ${s.how}`);
  };

  it("the named target's component is the hand-off (the positive pair)", () => {
    expect(strays(`<Form next={routes.quickMatch(token)} />`)).toEqual([]);
  });

  it("an inline-href <Link> beside it is a stray: the link is painted in this file, not handed off", () => {
    expect(strays(`<Form next={routes.quickMatch(token)} /><Link href={routes.quickMatch(token)}>open</Link>`)).toEqual([
      "<Link> attribute href",
    ]);
  });

  it("a component of the tree that is not one of the named targets is a stray too", () => {
    expect(strays(`<Form next={routes.quickMatch(token)} /><Other next={routes.quickMatch(token)} />`)).toEqual(["<Other> attribute next"]);
  });
});
