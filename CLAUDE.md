# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`speeddial` is a single static page (`index.html`, plus a small `assets/` folder of icon overrides) — a browser "speed dial" / new-tab start page rendering a grid of bookmark links with favicons. There is no build step, no dependencies, and no server. Open `index.html` directly in a browser (or set it as the new-tab page) to run it.

## Architecture

Everything lives in `index.html`: inline `<style>` and a single inline `<script>`. Key pieces:

- **`LINKS` array** (top of the script): the source of truth for bookmarks. Each entry is `{ label, href, domain }`, plus an optional `icon` (a path or data URL) that overrides the fetched favicon. Editing bookmarks means editing this array — it is kept alphabetized by `label`.
- **Icon overrides** — an entry's `icon` wins over everything else: `resolveIcons()` assigns it directly, with no fetch and no cache entry, so a bundled icon can never go stale. Used where the fetched favicon is unusable (e.g. GitHub's black Octocat on the dark background). Bitmap overrides live in `assets/`.
- **Favicon resolution** — icons for everything else come from Google's favicon service (`FAVICON_API`, `https://www.google.com/s2/favicons`). Fetched icons are drawn to a canvas, converted to base64 data URLs, and cached in `localStorage` so subsequent loads are instant with no network calls.
- **Rendering flow**: links render immediately with single-letter placeholders, then `resolveIcons()` fills in favicons — from cache when present, otherwise fetched concurrently via `Promise.allSettled`. On `img` error the letter placeholder stays visible; canvas tainting (CORS) falls back to the raw favicon URL and is not persisted.

## Cache invalidation

`CACHE_VERSION` (a constant in the script) is part of the `localStorage` key. **Bump `CACHE_VERSION` whenever you change the `LINKS` list** to force a fresh favicon fetch; otherwise stale cached icons may persist.
