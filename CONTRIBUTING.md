# Contributing

## Development

```bash
npm install
npm test             # vitest: protocol, validation and hostile-page cases
npm run typecheck
npm run build        # dist/index.js + dist/index.d.ts
npm run test:exports # the built package loads with require and import
```

Tests run both tabs against fake windows (`src/fake-window.ts`), including
hostile openers and wrong origins. Any change to the protocol or the checks
needs a test there.

## Releasing

Bump `version` in `package.json`, commit, and push a matching tag:

```bash
git tag v1.1.1 && git push origin v1.1.1
```

`.github/workflows/publish.yml` then type-checks, tests, builds and publishes
with npm trusted publishing and provenance (no npm token).
