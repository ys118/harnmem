# Publishing `pi-harnmem` to pi.dev/packages — research

Status: **listed and shipping gallery metadata** — verified 2026-10-31. The
gallery picked the package up automatically once its npm-search rank entered the
enumerable window; no submission or review step was involved. `pi-harnmem@0.4.6`
(published 2026-10-31T14:23:19Z) is the first release carrying the gallery
preview image and the docs-recommended host peer ranges. Earlier revisions of
this note (2026-10-25/26, versions 0.2.0–0.3.0) documented the blocked state.

## Outcome (verified 2026-10-31)

- Catalog: `https://pi.dev/packages?name=pi-harnmem` returns **1 result** (also
  via `?type=extension&name=harnmem`); the card shows the description, author
  `ys118`, `806/mo`, type `extension`, and `$ pi install npm:pi-harnmem`;
  card attributes on the same page: `data-package-downloads="806"`,
  `data-package-date="1793450977474"`.
- Detail page `https://pi.dev/packages/pi-harnmem` at 22:30 Asia/Shanghai
  (after the 0.4.6 publish) still rendered Version `0.4.5`, Published
  `Oct 31, 2026`, Downloads `806/mo`: pi.dev caches registry metadata, and
  earlier releases also took a cache cycle to show the new version (0.2.0 →
  0.3.0 → 0.4.4 → 0.4.5 were all picked up automatically, without any manual
  action).
- `GET /api/packages/preview-media?name=pi-harnmem` now returns
  `{"previews":[{"name":"pi-harnmem","media":{"type":"image","url":"https://raw.githubusercontent.com/ys118/harnmem/master/packages/pi-harnmem/logo.png"}}]}`,
  and that logo URL serves HTTP 200. The server-rendered catalog card's preview
  frame was still `data-package-preview-status="missing"` at 22:30; it should
  fill in on the next cache cycle.
- Catalog total on 2026-10-31: 5,398–5,404 packages (it grew from 5,361 the day
  before; the enumerable window is still the 5,250-slot subset).

## Why it appeared (mechanism confirmed)

The crawler still pages npm search
(`registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=…&from=…`) and
npm still caps `from` at 5000 (issue #7885), but the package's own search rank
rose above that limit because the ranking is download-driven:

- `text=keywords:pi-package` reported `total` **13,076** on 2026-10-31; the
  reachable window is `from=0..5000` at `size=250` → 5,250 slots.
- `pi-harnmem` sat at global rank **2,235** (page `from=2000`, index 234):
  `searchScore` 18.9486, `downloads.monthly` 644, `downloads.weekly` 644,
  `dependents` 0.
- The last reachable page (`from=5000`, ranks ~5,001–5,250) on the same day:
  monthly downloads 140–147, `score.final` ≈13.950–13.955. The package is
  therefore ~4.5× above the current download boundary.
- `score.detail` is `{popularity: 1, quality: 1, maintenance: 1}` for both the
  top result and `pi-harnmem`, so README/keyword/description edits do not move
  the rank; only downloads do.
- Daily npm downloads: Oct 24 **0**, Oct 25 **289**, Oct 26 **177**,
  Oct 27 **161**, Oct 28 **17**, Oct 29 **162**, Oct 30 not aggregated at the
  time of writing (806 over Oct 23–29). The spike is release-week install/test
  traffic; as those days roll out of the monthly window the rank can decay, so
  the listing is not guaranteed forever.

Upstream status is unchanged: #7885 is closed (`not_planned`), has no comments
since 2026-09-25, and no relevant crawler/mirror commits landed. The listing did
**not** require an upstream fix — it required getting inside the window.

## Package verification (`pi-harnmem@0.4.6`)

- npm `latest` 0.4.6, published 2026-10-31T14:23:19Z; tarball has 20 files /
  624,258 bytes, including `logo.png` (12,823 bytes), LICENSE, and a README
  whose SHA-256 equals `packages/pi-harnmem/README.md` on `master`;
  `dependencies` is empty because core is vendored into the bundle (assets ship
  under `dist/data` and `dist/prompts`).
- Published manifest: `pi` =
  `{"image":"https://raw.githubusercontent.com/ys118/harnmem/master/packages/pi-harnmem/logo.png","extensions":["./pi-harnmem.js"]}`;
  `peerDependencies` are `"*"` for `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent` and `typebox`, as the pi docs require for
  host-provided packages.
- `pi install npm:pi-harnmem` on **pi 1.4.0** with an isolated
  `PI_CODING_AGENT_DIR`: “added 1 package, and audited 2 packages … found 0
  vulnerabilities”; `pi list` shows `npm:pi-harnmem`; the installed tree
  contains `logo.png` (12,823 bytes) and the installed package.json reports
  0.4.6. A `memory_write` in one session ("stored") was recalled by a second
  session, and a config file with a UTF-8 BOM still parsed (the #37 fix). (On
  this machine the `pi` binary lives at `%LOCALAPPDATA%\pnpm\bin\pi.cmd`, not on
  `PATH`.)
- `0.4.5` was published manually at 12:49Z after the release workflow skipped
  npm for lack of an `NPM_TOKEN`; `0.4.6` re-published the same bundle with the
  gallery metadata and peer ranges (see CHANGELOG `[0.7.3]`). The CHANGELOG also
  records the `@harnmem/core` 0.4.3 write fix (#42) that the adapters re-bundle.

## Remaining optional work

| Item | State (2026-10-31) |
| --- | --- |
| Gallery preview | Done in `0.4.6`: `pi.image` served via `raw.githubusercontent.com/ys118/harnmem/master/packages/pi-harnmem/logo.png`; the preview-media API returns it, the SSR card preview catches up on pi.dev's cache cycle |
| Host peer ranges | Done in `0.4.6`: all three host packages are `"*"` |
| Discoverability | Done: the package README and the root README link to the [pi.dev gallery listing](https://pi.dev/packages/pi-harnmem) (#39) |

## Monitoring

- Weekly session reminder `schedule-5ad98862-7ecd-4b2a-978c-a5dd38790ca5`
  (Mondays 09:00 Asia/Shanghai) checks the gallery card/detail page, the docs
  page version, `api.npmjs.org/downloads/point/last-month/pi-harnmem`, and the
  `from=5000` window boundary.
- The window boundary was ~140–150 monthly downloads on 2026-10-31; `pi-harnmem`
  reported 806 for the week Oct 23–29. A drop below the boundary can rotate the
  package out (seen with other packages, e.g. `@nomeelnoj/pi-prompt-timer`).
- Only revisit #7885 if the listing disappears; the window cap is still unfixed.
- pi.dev's card and detail page refresh on their own cache cycles (minutes to a
  couple of hours), so a fresh publish can lag on the page while npm already
  serves the new version.

## Sources

- <https://pi.dev/packages> and <https://pi.dev/packages/pi-harnmem>
  (2026-10-31 ~22:30 Asia/Shanghai); card attributes and `preview-media`
  endpoint.
- <https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=…>
  for the rank/window data (2026-10-31).
- npm registry metadata/tarball for `pi-harnmem@0.4.6`; `api.npmjs.org/downloads`
  range for 2026-10-23..30.
- `pi install npm:pi-harnmem` on pi 1.4.0 with an isolated `PI_CODING_AGENT_DIR`
  (0.4.4 and 0.4.6).
- Earlier evidence: <https://github.com/earendil-works/pi/issues/7885>,
  pi docs at <https://pi.dev/docs/latest/packages>, and the related
  gallery-missing issues (#6873/#10145/#10173/#11130).
