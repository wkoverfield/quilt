# Contributing to Quilt

Thanks for your interest. Quilt is early and contributions are welcome, whether
that's a bug report, a fix, a new language for symbol-level claims, or an
orchestrator integration.

## Getting set up

```bash
git clone https://github.com/wkoverfield/quilt && cd quilt
npm install
npm run build       # tsc -> dist/
npm test            # build + run the acceptance suite against fixture repos
```

Requires Node 20+ and `git` on the PATH.

Run the CLI from source while you work:

```bash
npm run dev -- status      # runs the CLI via tsx, no build step
```

## Ground rules for changes

Quilt has a few load-bearing properties. Please keep them intact:

- **Git stays the source of truth.** Quilt shells out to `git` and keeps derived
  state under `.quilt/`. It never rewrites history or stores your code.
- **It fails safe.** Every collision is detect-and-preserve. A change should never
  make Quilt silently lose or corrupt work; a blocked or surfaced outcome is
  better than a wrong one.
- **No LLM calls, no spawning agents.** Quilt is a deterministic substrate. The
  user runs and pays for the agents.

## Sending a pull request

1. Fork and branch (`fix/...`, `feat/...`, `docs/...`, `chore/...`).
2. Add a test. The suite lives in `test/` and runs real `git` against throwaway
   fixture repos; match that style.
3. `npm test` should pass, and `npm run build` should be clean.
4. Keep the change focused, and describe what it does and why in the PR.

For anything that touches attribution, commit-splitting, or the reconcile engine,
a short note on the failure mode you're guarding against helps a lot.

## Reporting bugs

Open an issue with the smallest repro you can. `quilt doctor` output and the
relevant `.quilt/` state (minus anything private) are useful to include.

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
