/**
 * The community plugin scanner's own CSS checks, run locally on `styles.css`.
 *
 * `stylelint-config-obsidianmd` is the ruleset the scanner behind the
 * community directory's scorecard applies to plugin and theme stylesheets
 * (obsidianmd/stylelint-config). Its Obsidian rules (`:has()`, `!important`,
 * unsupported browser features, external URLs, …) are warnings there; run with
 * `--max-warnings 0` they fail the lint here, so each one we keep needs a
 * disable comment saying why.
 *
 * The scanner itself (obsidianmd/obsidian-workflows, `src/lint.ts`) runs only
 * these Obsidian rules, not the `stylelint-config-standard` preset below, and
 * with `ignoreDisables`, so every disable comment here still shows up on the
 * scorecard: the comment is our record of why, not a way to hide the finding.
 *
 * It extends `stylelint-config-standard`, whose conventions this stylesheet
 * does not follow and which `@eslint/css` and Prettier already cover where
 * they matter. Those are switched off below, one by one, rather than dropping
 * the preset, so any rule it adds later still reports.
 */
export default {
  extends: ['stylelint-config-obsidianmd'],
  reportDescriptionlessDisables: true,
  reportInvalidScopeDisables: true,
  reportNeedlessDisables: true,
  rules: {
    'alpha-value-notation': null,
    'color-function-alias-notation': null,
    'color-function-notation': null,
    'comment-empty-line-before': null,
    'declaration-empty-line-before': null,
    'length-zero-no-unit': null,
    'media-feature-range-notation': null,
    // Rule order follows the features, and each override says what it beats.
    'no-descending-specificity': null,
    // WebKit still needs `-webkit-box-decoration-break`, and iOS runs WebKit.
    'property-no-vendor-prefix': null,
    'rule-empty-line-before': null,
    'selector-class-pattern': null,
    'selector-not-notation': null,
    // The scanner picks the Electron floor from manifest.json's minAppVersion
    // through its own table, whose newest row is Electron 39 (Obsidian
    // 1.11.4), so 1.13.4 is checked against 39, not the preset's 43.
    'plugin/no-unsupported-browser-features': [
      true,
      {
        browsers: ['electron >= 39'],
        ignore: ['css-nesting', 'css-cascade-layers'],
        severity: 'warning',
      },
    ],
  },
};
