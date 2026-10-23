# Repository Guidelines

## Project structure and module organization

This Node.js bridge connects QQ through SnowLuma OneBot v11 to DeepSeek Harness (DSH).

- `src/` contains the bridge, DSH client, MCP servers, and shared libraries. `src/bridge.js` is the entry point.
- `scripts/` contains tests, setup tools, and diagnostics. `src/core/` also contains colocated tests.
- `public/console.html` provides the local console. `assets/` holds images, and `roles/` holds persona cards.
- `dsh/agent-presets/` contains preset sources. `plugins/` contains DSH plugins and generated preset patches.
- `docs/guides/` holds public guides; `docs/README.md` indexes documentation.

## Build, test, and development commands

Run commands from the repository root with Node.js >=22.13.0.

- `npm install` installs dependencies and applies the required SnowLuma SDK patch through `postinstall`.
- `npm start` starts the bridge. Configure `config.json` from `config.example.json` and start DSH and SnowLuma first.
- `npm run test:audit` runs isolated regressions using fixtures and mocks.
- `node --test src/core/session-router.test.mjs` tests conversation routing.
- `npm run preview:console` serves the mock console at `http://127.0.0.1:4173`.
- `npm run test:console-ui` runs browser regressions; see `docs/guides/CONSOLE-UI-TESTING.md` for prerequisites.
- `node scripts/build-agent-preset-patches.mjs` regenerates patches after preset source changes.

There is no application build step or default `npm test` script.

## Coding style and naming conventions

Use ES modules, two-space indentation, semicolons, and single-quoted strings, matching nearby code. Use camelCase for functions and variables, UPPER_SNAKE_CASE for constants, and kebab-case filenames. Name regression scripts `test-*.mjs` and diagnostic probes `probe-*.mjs`. No formatter or linter is configured.

## Testing guidelines

Tests use standalone Node.js scripts, custom assertions, and Node's built-in test runner. Add focused regressions for changed behavior and register applicable scripts in `scripts/test-audit.mjs`. Run the audit suite before submitting code changes; include browser regressions for console changes. No coverage percentage is enforced. Keep live DSH tests and message-sending tools separate from offline checks.

## Commit and pull request guidelines

Use concise `type: summary` subjects, matching the history's `fix:`, `docs:`, `chore:`, and `release:` prefixes. Describe the problem, resulting behavior, and validation in each PR. Link relevant issues, include screenshots for console changes, and note configuration or preset installation changes.

## Security and configuration

Follow `RULES.md`. Never commit `config.json`, `state/`, `audio/`, credentials, or private identifiers. Preserve user data and use temporary directories for test fixtures. Update `config.example.json` with sanitized defaults and run `npm run privacy-scan` before publishing. Update `docs/guides/SECURITY_BASELINE.md` in the same PR when security guarantees change.
