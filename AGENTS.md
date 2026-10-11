# Development notes

- This repository is a local-first personal DSH sync MVP, not the installed DSH checkout.
- Do not modify a real DSH installation/profile or upload real user data to test changes. Use synthetic fixtures and loopback listeners only unless the user explicitly requests deployment.
- Node.js 24+, ESM, no runtime third-party dependencies for server/CLI. Host adapter depends on exact DSH 0.2.0-rc.2 peers; inspect actual SDK contracts before changing them.
- Run `node --test --test-isolation=none tests/*.test.mjs`. Fixtures belong under `.test-tmp`; verify their exact directory before cleanup.
- Restoration must never merge with or overwrite an existing directory, auto-start agents, or copy unrelated credentials.
- Preserve immutable checkpoints, authenticated device binding, literal state-directory exclusions, strict path/hash/size checks, and partial-failure reporting.
- `.inspection` is read-only installed-code research plus synthetic smoke harnesses. Do not publish its contents. Production package contents come from the explicit whitelist in package.json.
- Build distributable with `node scripts/pack.mjs`; do not package credentials, test data, research copies, or node_modules.
- Document the difference between archived logs and the narrower safely resumable subset, and between mocked contracts, isolated native smoke tests, and real GUI integration.
