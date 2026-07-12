# quilt.dev site

The static storefront: landing page (`index.html`), the worldview argument
(`why.html`), benchmark results (`bench.html`), and `llms.txt`. The landing
stays a short product page; depth lives on the other pages. No build step, no framework, no dependencies;
every page is self-contained HTML with inline CSS/JS. Fonts load from Google
Fonts; everything else is local.

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

- The bench numbers on `index.html` and `bench.html` mirror
  [`bench/RESULTS.md`](../bench/RESULTS.md). When a bench run changes the
  numbers, update all three together.
- The dashboard screenshot is `assets/ui.png`, captured from `quilt ui`
  against a fixture repo (the same capture ships as `examples/ui.png` on
  the quilt ui branch, PR #105). `assets/contrast.gif` is copied from
  `examples/contrast.gif`.
- Writing style: no em dashes in page prose (repo-wide rule).
