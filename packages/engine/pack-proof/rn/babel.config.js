// `@react-native/babel-preset` (what `react-native init` ships) does NOT transform `export * as ns from "x"`, and zod 4's ESM entry
// (`zod/v4/classic/external.js`: `export * as core from "../core/index.js"`) uses it, so Metro fails on zod - a peer of the engine -
// before it reaches any engine file ("Export namespace should be first transformed by
// @babel/plugin-transform-export-namespace-from"). The real phone consumer is an Expo app, whose preset (babel-preset-expo) carries
// that transform; this fixture adds the same transform so it models that consumer rather than a bare template.
export default {
  presets: ["module:@react-native/babel-preset"],
  plugins: ["@babel/plugin-transform-export-namespace-from"],
};
