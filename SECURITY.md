# Security Policy

Quilt runs `git` on your behalf and writes commits, so I take reports about data
loss or unexpected history changes seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Instead, either:

- Use GitHub's private [Report a vulnerability](https://github.com/wkoverfield/quilt/security/advisories/new)
  form, or
- Email wilson@joinfindu.com with `quilt security` in the subject.

Include the smallest repro you can, the Quilt version (`quilt --version`), and
what you expected to happen versus what did. I aim to acknowledge within a few
days.

## What counts

Quilt is meant to fail safe: it should never silently lose or corrupt work, and
every collision is detect-and-preserve. Reports that especially matter:

- A path where Quilt drops, overwrites, or misattributes committed or uncommitted
  work without surfacing it.
- Anything that makes Quilt write outside `.quilt/` and the commits you asked for,
  or rewrite existing history.
- Path traversal or command injection through claim targets, actor ids, or MCP
  input.

## Supported versions

Quilt is pre-1.0 and moves fast. Fixes land on the latest published `@quilt-dev/cli`
release; please reproduce against that before reporting.
