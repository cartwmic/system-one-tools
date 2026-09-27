# Working in system-one-tools

## Scope and authority

This file governs repository work. Follow the owner's request and applicable global safety rules. For repository procedure, the most specific `AGENTS.md` applies; this root file covers the tree today. [README.md](README.md) is for people installing and using the tools. The package READMEs document their APIs. There is no repository PRD or nested agent guide.

## Workflow

Choose the owning package before editing:

- `packages/system-one-connections` owns the user catalog, credential-variable lookup, and composition of the published System One SDK client. Keep provider paths in connection data.
- `packages/system-one-cli` owns process input, output, exit status, and signal handling.
- `packages/pi-system-one` owns one Pi extension entry: the agent tool in `src/index.js`, owner commands in `src/ui.js`, and session preferences in `src/internal.js`. Keep `/so` and the tool in this package.

Start from the checked-in lockfile. Run the affected workspace test while editing; run the root check before handing off code changes:

```sh
npm ci
npm run build
npm test --workspace @cartwmic/system-one-cli
npm run check
```

Focused caller tests import the shared package's ignored `dist/` files. After editing shared source, rebuild `@cartwmic/system-one-connections` before CLI or Pi focused tests; `npm run check` rebuilds all packages. Use `npm test --workspace @cartwmic/system-one-connections` or `npm test --workspace @cartwmic/pi-system-one` when those packages own the change. For behavior shared by callers, run `npm run test:journey`. For Pi commands or session behavior, run `npm run test:tui` and inspect the TAP result for a completed test with zero skips. For packaging or supported-platform claims, run `npm run test:package` on macOS with Docker running. The Linux Node 20 consumer in that matrix exercises the CLI; the Pi extension requires Node 22.19+.

The tests use scripted HTTP backends and temporary user homes. Prove public behavior with the CLI process, Pi TUI, or installed-tarball journey above. A passing internal test alone cannot establish those outcomes. `test:tui` uses a PTY and Python 3. It does not test tmux. The `dist/` trees and tarballs are generated and ignored: edit source, then build or pack through npm. Pi's Git package is the repository root: its `pi.extensions` points to the nested entry, and `prepare` builds the shared `dist/` during Pi's production-only dependency install. Keep root `typescript` and `@types/node` installable for that build. Pi's exported `src/index.d.ts` and `src/internal.d.ts` are tracked and maintained by hand; update them when the corresponding JavaScript API changes. The Pi build checks JavaScript syntax but does not check declaration agreement. Before a handoff, inspect `git status -sb` and `git diff --check` (or check the committed diff if the tree is clean).

This is a public repository. Keep credential **values** out of source and logs; the catalog stores only the environment-variable name. Ask before a paid provider call, npm publication, installation into the user's regular Pi environment, or a push. Required tests may install local tarballs into disposable consumers. Use scripted endpoints for ordinary validation. Scripted routes prove adapter dispatch and caller behavior. For a claim of live-provider compatibility, obtain approval for a bounded paid call and validate the CLI and Pi against that provider with runtime credentials; report which routes, model, and caller paths actually completed. Do not treat a URL-shaped local fixture as live compatibility or claim local-model calibration from these checks. Markdown is advisory; tests and CI should enforce any repeatable never-rule that can be automated.

## Completion and handoff

Report changed paths, the focused and public-path commands actually run, their results and host requirements, and any skipped or unrun checks. State the Git commit/push disposition and the remaining live-provider limitation. When committing or pushing was requested, commit only task-owned changes and report any unrelated work already present. Do not discard unrelated changes to make the worktree clean. Do not silently broaden a documentation task into package release or live configuration work.
