# quilt.dev site

The static site: landing page (`index.html`), the worldview argument
(`why.html`), on-site docs (`docs.html`, the condensed version; deep
references stay canonical in the repo's docs/), and `llms.txt`. No separate
benchmarks page by design; bench numbers live in the repo.

Design: the landing page, docs, and `quilt ui` share the "Product Surface"
direction. They use a cool paper field, white raised surfaces, Gambetta display
serif, Switzer body text, and IBM Plex Mono for agent and terminal data. The
four agent colors form the Quilt mark, authorship chips, diff states, and docs
reading path. The darker color cuts are used for text on light surfaces, with
the original colors kept for fills. The Quilt mark always reads clockwise from
the top left as amber, green, magenta, then blue. The worldview page retains the
earlier Workshop treatment until it receives its own redesign pass.

No build step, no framework, no dependencies; every page is self-contained
HTML with inline CSS/JS. Fonts load from Fontshare (Gambetta, Switzer) and
Google Fonts (IBM Plex Mono); everything else is local.

## Deploying

Any static host works. For Vercel: import the repo, set the project's root
directory to `site/`, framework preset "Other", no build command, output
directory `.` and it ships. Point the domain at the project once one is
chosen.

## Analytics and the waitlist

The site's entire analytics surface is two events sent straight to PostHog's
capture endpoint (no SDK, no cookies, nothing persisted in the browser):

- `quilt_site_pageview`: a fresh random id per pageview, so it counts visits
  without tracking anyone across pages or days.
- `quilt_waitlist_joined`: fired by the team-tier form with the entered email.

The project token in `index.html` is a PostHog write-only key (safe to be
public by design). It currently points at the WKO "Default project"; if Quilt
gets its own PostHog project later, swap the `KEY` constant in `index.html`.

## Maintenance notes

- The bench numbers on `index.html` mirror
  [`bench/RESULTS.md`](../bench/RESULTS.md). When a bench run changes the
  numbers, update both together.
- `assets/ui.png` is a `quilt ui` capture against a fixture repo (same
  image as `examples/ui.png` from the quilt ui branch, PR #105). It is
  not shown on the landing page by design; it's kept here for future
  pages. `assets/contrast.gif` is copied from `examples/contrast.gif`.
- Writing style: no em dashes in page prose (repo-wide rule).
