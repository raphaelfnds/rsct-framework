// Global test setup.
//
// The update check consults by default (#38), and `statusHandler` reaches it through
// `getUpdateNotice()` — which resolves $HOME and a real `fetch` when nothing is
// injected. Sixteen call sites across status/load-context/topology/universe tests
// would therefore hit api.github.com (six CI cells against a 60/hour anonymous
// limit) and rewrite the contributor's REAL ~/.rsct/update-check.json, including any
// consent they recorded.
//
// The kill switch is the same one shipped to users, so this is not a test-only code
// path pretending to be the product. Tests that exercise the check on purpose pass
// `env: {}` through UpdateOptions to opt back in against a temp $HOME.
process.env.RSCT_UPDATE_CHECK = 'off'
