# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`speeddial` is a single static page (`index.html`, plus a small `assets/` folder of icon overrides) — a browser "speed dial" / new-tab start page rendering a grid of bookmark links with favicons. There is no build step, no dependencies, and no server. Open `index.html` directly in a browser (or set it as the new-tab page) to run it.

Bookmarks are managed in **Raindrop.io**, not in this repo. `scripts/sync-raindrop.mjs` regenerates the `LINKS` array from a public Raindrop collection; see **Syncing bookmarks** below. It is published via GitHub Pages from `main` at <https://roblindsey.github.io/speeddial/>, so a push deploys.

## Architecture

Everything lives in `index.html`: inline `<style>` and a single inline `<script>`. Key pieces:

- **`LINKS` array** (top of the script): **generated — do not hand-edit.** It sits between `// LINKS:BEGIN` and `// LINKS:END` markers and is rewritten wholesale by `scripts/sync-raindrop.mjs`. Each entry is `{ label, href, domain }` plus an optional `icon`, sorted case-insensitively by `label`. To change bookmarks, edit the Raindrop collection and re-run the sync.
- **Icon overrides** — an entry's `icon` wins over everything else: `resolveIcons()` assigns it directly, with no fetch and no cache entry, so a bundled icon can never go stale. Used where the fetched favicon is unusable (e.g. GitHub's black Octocat on the dark background). Bitmap overrides live in `assets/`.
- **`assets/link-overrides.json`** — the hand-maintained half of `LINKS`, keyed by `href`, holding what Raindrop cannot express: an `icon` override, and a `domain` override for cases where the URL's own host yields the wrong favicon (`google.com/maps` → `maps.google.com` for the Maps pin). An optional `_why` documents each entry and is emitted as a comment into `index.html`. This file, not `index.html`, is where icon fixes belong.
- **`ICONS` object** (below `LINKS`, also generated): favicons inlined as base64 data URLs at build time, keyed by domain. The page therefore makes **no network requests for icons at all**.
- **Favicon resolution** — precedence is `icon` override → inlined `ICONS[domain]` → a live fetch from Google's favicon service (`FAVICON_API`) as a last resort. Inlining happens in Node during the sync because that service sends no CORS headers, so the browser cannot fetch and re-encode the icons itself — an earlier `localStorage` cache attempted exactly that and silently never populated.
- **Rendering flow**: links render with single-letter placeholders, then each `img.src` is assigned from the precedence above — synchronously, since the icons are already in the document. On `img` error the letter placeholder stays visible.

## Syncing bookmarks

```sh
node scripts/sync-raindrop.mjs                  # rewrites LINKS + ICONS in index.html
node scripts/sync-raindrop.mjs --refresh-icons  # also re-fetch every favicon
git commit -am "sync links" && git push         # Pages deploys from main
```

**Adding a bookmark needs no icon work.** Add it in Raindrop, run the sync: the new domain's favicon is fetched and inlined automatically. Only step in when the result is unusable — a generic globe, a dark glyph invisible on the background, or the wrong subdomain's icon — by adding an entry to `assets/link-overrides.json`.

Already-inlined icons are **reused** rather than re-fetched, so a sync normally makes one request. This keeps runs idempotent: re-fetching every time would churn the diff even when nothing changed. Only `data:image/png;base64,` values are reused, so override icons are never mistaken for cached favicons.

No credentials and no dependencies — it reads the collection's **public page**, not the authenticated API. (`api.raindrop.io` demands a token even for public collections, and a Raindrop test token grants full account read/write, so it must never appear in this public repo.)

The collection URL defaults to a constant in the script and is overridable via `RAINDROP_PAGE_URL`; `RAINDROP_PERPAGE` exists to exercise the pagination loop in testing.

**Failure behavior:** any fetch error, shape change, zero-item result, count mismatch, or unmatched override entry exits non-zero with `index.html` untouched. The script never writes a partial list — a broken sync leaves the last good page serving. A *favicon* that cannot be fetched is only a warning: that link falls back to a runtime fetch, then to its letter placeholder.

**Fragility to know about:** the data source is `…/index.pageContext.json`, the public page's *undocumented* server-rendered data route. It can change without notice. If it does, the RSS feed at `…/feed` is a token-free fallback (50-item cap, `domain` derivable from `link`). Also note the route's quirk: the first `/view/` parameter is silently namespaced away, so the URL leads with a throwaway `theme=auto` to make `perpage` and `page` take effect.

## No runtime caching

There is deliberately no `localStorage` favicon cache and no `CACHE_VERSION`. An earlier version had both; they never worked, because the favicon service sends no `Access-Control-Allow-Origin` — with `crossOrigin="anonymous"` the image load is blocked, and without it the canvas is tainted and `toDataURL()` throws. Build-time inlining replaces them, so there is nothing left to invalidate.
