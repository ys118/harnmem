# Publishing `pi-harnmem` to pi.dev/packages — research

Status: **listed** — verified 2026-10-31 ~15:35 Asia/Shanghai against
`pi-harnmem@0.4.4`. No submission or review step was ever involved: the gallery
picked the package up automatically once its npm-search rank entered the
enumerable window. Earlier revisions of this note (2026-10-25/26, versions
0.2.0–0.3.0) documented the blocked state.

Update 2026-10-31 (evening): `v0.7.2` makes `pi-harnmem` `0.4.5` the version on
`master` (the UTF-8 BOM config fix from #37), but npm still serves `0.4.4`
until the next publish, so the gallery detail page keeps showing `0.4.4`. The
gallery preview image and the docs-recommended peer ranges are queued for
`0.4.6` (see "Remaining optional work").

## Outcome (verified 2026-10-31)

- Catalog card: `https://pi.dev/packages?name=pi-harnmem` returns **1 result**
  (also via `?type=extension&name=harnmem`); the card shows the description,
  author `ys118`, `644/mo`, `1d ago`, type `extension`, and
  `$ pi install npm:pi-harnmem`.
- Detail page `https://pi.dev/packages/pi-harnmem`:
  Version `0.4.4`, Published `Oct 30, 2026`, Downloads `644/mo · 644/wk`,
  Author `ys118`, License `MIT`, Types `extension`, Size `594.8 KB`,
  Dependencies `0 dependencies · 3 peers`, Pi manifest
  `{"extensions":["./pi-harnmem.js"]}`, and the current npm-first README.
- The page updates automatically on `npm publish` (0.2.0 → 0.3.0 → 0.4.4 were
  picked up without any manual action). Catalog total on 2026-10-31: 5,404
  packages.

## Why it appeared (mechanism confirmed)

The crawler still pages npm search
(`registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=…&from=…`) and
npm still caps `from` at 5000 (issue #7885), but the package's own search rank
rose above that limit because the ranking is download-driven:

- `text=keywords:pi-package` now reports `total` **13,076**; the reachable window
  is `from=0..5000` at `size=250` → 5,250 slots.
- `pi-harnmem` sits at global rank **2,235** (page `from=2000`, index 234):
  `searchScore` 18.9486, `downloads.monthly` 644, `downloads.weekly` 644,
  `dependents` 0.
- The last reachable page (`from=5000`, ranks ~5,001–5,250) on the same day:
  monthly downloads 140–147, `score.final` ≈13.950–13.955. The package is
  therefore ~4.5× above the current download boundary.
- `score.detail` is `{popularity: 1, quality: 1, maintenance: 1}` for both the
  top result and `pi-harnmem`, so README/keyword/description edits do not move
  the rank; only downloads do.
- Daily npm downloads: Oct 24 **0**, Oct 25 **289**, Oct 26 **177**,
  Oct 27 **161**, Oct 28 **17**, Oct 29 **162**, Oct 30 not aggregated yet
  (806 over Oct 23–29). The spike is release-week install/test traffic; as those
  days roll out of the monthly window the rank can decay, so the listing is not
  guaranteed forever.

Upstream status is unchanged: #7885 is closed (`not_planned`), has no comments
since 2026-09-25, and no relevant crawler/mirror commits landed. The listing did
**not** require an upstream fix — it required getting inside the window.

## Package verification (`pi-harnmem@0.4.4`)

- npm `latest` 0.4.4, published 2026-10-30T06:04:23Z; tarball has 20 files /
  609,065 bytes, LICENSE, and a README whose SHA-256 equals
  `packages/pi-harnmem/README.md` on `master`; `dependencies` is empty because
  0.4.3 vendored core into the bundle (assets ship under `dist/data` and
  `dist/prompts`).
- Tarball `package.json` vs repo: only `@harnmem/core` in `devDependencies` is
  rewritten from `workspace:^` to `^0.4.2`; everything else matches.
- `pi install npm:pi-harnmem` on **pi 1.4.0** with an isolated
  `PI_CODING_AGENT_DIR`: “added 1 package, and audited 2 packages … found 0
  vulnerabilities”, and `pi list` shows `npm:pi-harnmem`. (On this machine the
  `pi` binary lives at `%LOCALAPPDATA%\pnpm\bin\pi.cmd`, not on `PATH`.)
- `npm install pi-harnmem@0.4.4` also resolves (npm auto-installs the three
  peers; Pi suppresses peer auto-install for managed packages, so this is only a
  sanity check).

## Remaining optional work

| Item | Current state | Change | Why |
| --- | --- | --- | --- |
| Gallery preview | `GET /api/packages/preview-media?name=pi-harnmem` → `{"previews":[{"name":"pi-harnmem","media":null}]}` | Add `pi.image` (a plain URL string, like `pi-netrunner`'s; a 1024×1024 logo committed under the package and served from `raw.githubusercontent.com/ys118/harnmem/master/...`) and publish a patch release; planned for `0.4.6` | Card preview in the gallery; cosmetic only |
| Host peer ranges | `">=1.3.0 <2.0.0"` | `"*"` as the docs recommend for host-provided packages; planned for `0.4.6` | Future pi 2.x installs |
| Discoverability | Card/detail live | Link `https://pi.dev/packages/pi-harnmem` from the package/root README and release notes | The listing is now a real distribution surface |

## Monitoring

- Weekly: open `https://pi.dev/packages?name=pi-harnmem` and check
  `api.npmjs.org/downloads/point/last-month/pi-harnmem`; the window boundary was
  ~140–150 monthly downloads on 2026-10-31. A drop below it can rotate the
  package out (seen with other packages, e.g. `@nomeelnoj/pi-prompt-timer`).
- Only revisit #7885 if the listing disappears; the window cap is still unfixed.
- The card's `644/mo` lags npm (search index showed 644 while the downloads API
  reported 806/week); both refresh on their own schedules.

## Sources

- <https://pi.dev/packages> and <https://pi.dev/packages/pi-harnmem>
  (2026-10-31 ~15:30–15:45 Asia/Shanghai); card attributes and
  `preview-media` endpoint.
- <https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=…>
  for the rank/window data (2026-10-31).
- npm registry metadata/tarball for `pi-harnmem@0.4.4`; `api.npmjs.org/downloads`
  range for 2026-10-24..30.
- `pi install npm:pi-harnmem` on pi 1.4.0 with an isolated `PI_CODING_AGENT_DIR`.
- Earlier evidence: <https://github.com/earendil-works/pi/issues/7885>,
  pi docs at <https://pi.dev/docs/latest/packages>, and the related
  gallery-missing issues (#6873/#10145/#10173/#11130).
