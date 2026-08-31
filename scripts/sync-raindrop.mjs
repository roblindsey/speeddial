#!/usr/bin/env node
// Regenerates the LINKS array in index.html from the public Raindrop.io collection.
//
//   node scripts/sync-raindrop.mjs
//
// No credentials: this reads the collection's *public page*, not the authenticated API.
// (api.raindrop.io requires a token even for public collections, and a Raindrop test token
// grants full account read/write — unusable in a public repo.)
//
// Favicons are inlined as data URLs at build time (Node has no CORS restriction, unlike the
// browser), so the published page makes no network requests at all. Already-inlined icons are
// reused as-is; pass --refresh-icons to re-fetch them all.
//
// The script never writes a partial or empty list: any fetch failure, shape change, or
// count mismatch exits non-zero with index.html untouched.

import { readFileSync, writeFileSync } from "node:fs";

const PAGE_URL =
	process.env.RAINDROP_PAGE_URL ??
	"https://roblindsey77.raindrop.page/speed-dial-74568744";
const PERPAGE = Number(process.env.RAINDROP_PERPAGE ?? 50); // 50 is the server-side max
const HTML_FILE = "index.html";
const OVERRIDES_FILE = "assets/link-overrides.json";

const REFRESH_ICONS = process.argv.includes("--refresh-icons");
const FAVICON_API = (domain) =>
	`https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

const PRINT_WIDTH = 80; // matches the repo's Prettier formatting
const TAB_WIDTH = 2;
const INDENT = "\t\t\t\t"; // nesting of a LINKS entry inside the inline <script>

// The public page's server-rendered data route. Undocumented, so treat its shape as
// untrusted and validate before use.
//
// Quirk: the first /view/ parameter comes back namespaced as `view/<key>` and is ignored,
// so `theme=auto` is a deliberate throwaway that lets perpage and page take effect. Without
// it, perpage silently stays at the default 30. The query-string form (?perpage=50) is
// ignored entirely; only this path form works.
const pageURL = (n) =>
	`${PAGE_URL}/view/theme=auto&perpage=${PERPAGE}&page=${n}/index.pageContext.json`;

function fail(message) {
	console.error(`sync-raindrop: ${message}`);
	console.error(`sync-raindrop: ${HTML_FILE} left unchanged.`);
	process.exit(1);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────────────
async function fetchAllRaindrops() {
	const items = [];
	let expected = null;

	for (let page = 0; ; page++) {
		if (page > 200) fail("pagination did not terminate");

		let res;
		try {
			res = await fetch(pageURL(page));
		} catch (err) {
			fail(`request failed on page ${page}: ${err.message}`);
		}
		if (!res.ok) {
			fail(
				`HTTP ${res.status} on page ${page} — is the collection still shared as a public page?`,
			);
		}

		let body;
		try {
			body = await res.json();
		} catch {
			fail(`page ${page} was not JSON — the public page route has likely changed`);
		}

		// A missing or unshared collection answers 200 with a 404 page-context rather than
		// an HTTP error, so this must be checked before the shape test below — otherwise the
		// likeliest real failure reports itself as "the route changed".
		if (body?.is404 || body?.abortStatusCode === 404) {
			fail(
				`collection not found at ${PAGE_URL} — is it still shared as a public page?`,
			);
		}

		const raindrops = body?.data?.raindrops;
		if (!raindrops || !Array.isArray(raindrops.items)) {
			fail(
				`unexpected shape at data.raindrops on page ${page} — the public page route has likely changed`,
			);
		}

		expected = raindrops.count;
		items.push(...raindrops.items);
		if (raindrops.items.length < PERPAGE) break;
	}

	// Guard against silently publishing a truncated dial.
	if (items.length === 0) fail("collection returned zero links");
	if (typeof expected === "number" && items.length !== expected) {
		fail(`fetched ${items.length} links but the collection reports ${expected}`);
	}
	return items;
}

// ─── Shape ───────────────────────────────────────────────────────────────────────────
function toLinks(items, overrides) {
	const links = items.map((item) => {
		const href = item.link;
		if (!href) fail(`a raindrop has no link: ${JSON.stringify(item).slice(0, 120)}`);

		let domain = item.domain;
		if (!domain) {
			try {
				domain = new URL(href).hostname;
			} catch {
				fail(`could not derive a domain from ${href}`);
			}
		}

		const label = (item.title ?? "").trim() || domain;
		const override = overrides[href] ?? {};

		return {
			label,
			href,
			// Overrides win: Raindrop derives `domain` from the URL, which is wrong wherever a
			// subdomain serves the better favicon (e.g. google.com/maps -> maps.google.com).
			domain: override.domain ?? domain,
			...(override.icon ? { icon: override.icon } : {}),
			...(override._why ? { _why: override._why } : {}),
		};
	});

	// Case-insensitive, plain comparison — deliberately NOT localeCompare, whose punctuation
	// handling reorders "Y! Finance" against "YouTube" relative to the existing grid.
	links.sort((a, b) => {
		const x = a.label.toLowerCase();
		const y = b.label.toLowerCase();
		return x < y ? -1 : x > y ? 1 : 0;
	});

	const unmatched = Object.keys(overrides).filter(
		(href) => !links.some((l) => l.href === href),
	);
	// Not fatal: removing a bookmark from Raindrop routinely orphans its override, and
	// blocking the sync over that would force a JSON edit for an ordinary change. The entry
	// is left in place so it takes effect again if the bookmark ever comes back — but it is
	// reported, since the other cause is a typo'd key that would otherwise do nothing.
	if (unmatched.length) {
		console.warn(
			`sync-raindrop: ${unmatched.length} override(s) in ${OVERRIDES_FILE} match no bookmark and are inactive:\n  ${unmatched.join("\n  ")}`,
		);
	}

	return links;
}

// ─── Favicons ────────────────────────────────────────────────────────────────────────
// Read the icons already inlined in index.html so a sync only fetches what is new. Without
// this every run would re-download all 36 and churn the diff even when nothing changed.
//
// Only `data:image/png;base64,` values are reused: that is what this function writes, so
// anything else (an assets/ path, an inline SVG) came from link-overrides.json and must not
// be mistaken for a cached favicon.
function readInlinedIcons(html) {
	const begin = html.indexOf("// ICONS:BEGIN");
	const end = html.indexOf("// ICONS:END");
	if (begin === -1 || end === -1) return {};
	const body = html.slice(html.indexOf("{", begin), html.lastIndexOf("}", end) + 1);
	let parsed;
	try {
		parsed = new Function(`return ${body};`)();
	} catch {
		return {};
	}
	return Object.fromEntries(
		Object.entries(parsed).filter(([, v]) =>
			String(v).startsWith("data:image/png;base64,"),
		),
	);
}

async function inlineFavicons(links, existing) {
	const icons = REFRESH_ICONS ? {} : { ...existing };
	// Overridden entries never need a fetched favicon.
	const wanted = links.filter((l) => !l.icon).map((l) => l.domain);
	const missing = [...new Set(wanted.filter((d) => !icons[d]))];

	const failed = [];
	await Promise.all(
		missing.map(async (domain) => {
			try {
				const res = await fetch(FAVICON_API(domain), { redirect: "follow" });
				if (!res.ok) return failed.push(`${domain} (HTTP ${res.status})`);
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length === 0) return failed.push(`${domain} (empty response)`);
				icons[domain] = `data:image/png;base64,${buf.toString("base64")}`;
			} catch (err) {
				failed.push(`${domain} (${err.message})`);
			}
		}),
	);

	// A missing favicon is not fatal — the page falls back to fetching it at runtime, and
	// then to the letter placeholder. Failing the sync would block an otherwise good link.
	if (failed.length) {
		console.warn(
			`sync-raindrop: could not inline ${failed.length} favicon(s), they will load at runtime:\n  ${failed.join("\n  ")}`,
		);
	}

	// Drop icons for domains no longer on the dial.
	const live = new Set(wanted);
	for (const domain of Object.keys(icons)) if (!live.has(domain)) delete icons[domain];

	return { icons, fetched: missing.length - failed.length };
}

// ─── Render ──────────────────────────────────────────────────────────────────────────
const displayWidth = (line) =>
	line.replace(/^\t+/, (tabs) => " ".repeat(tabs.length * TAB_WIDTH)).length;

// Escape `<` so a bookmark titled "</script>" cannot break out of the inline <script>.
const str = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

function renderEntry({ label, href, domain, icon, _why }) {
	const props = [
		["label", label],
		["href", href],
		["domain", domain],
		...(icon ? [["icon", icon]] : []),
	];

	// Prettier collapses an object onto one line when it fits; mirror that so generated
	// output does not churn against the existing hand-formatted file.
	if (!_why) {
		const inline = `${INDENT}{ ${props.map(([k, v]) => `${k}: ${str(v)}`).join(", ")} },`;
		if (displayWidth(inline) <= PRINT_WIDTH) return inline;
	}

	const lines = [`${INDENT}{`];
	for (const [key, value] of props) {
		// The rationale sits directly above the property it justifies, matching the
		// convention already used for the GitHub and Yahoo icons.
		if (_why && (key === "icon" || (!icon && key === "domain"))) {
			lines.push(`${INDENT}\t// ${_why}`);
		}
		lines.push(`${INDENT}\t${key}: ${str(value)},`);
	}
	lines.push(`${INDENT}},`);
	return lines.join("\n");
}

// ─── Splice into index.html ──────────────────────────────────────────────────────────
function replaceBlock(html, name, body) {
	const begin = html.indexOf(`// ${name}:BEGIN`);
	const end = html.indexOf(`// ${name}:END`);
	if (begin === -1 || end === -1) {
		fail(`could not find the ${name}:BEGIN / ${name}:END markers in ${HTML_FILE}`);
	}
	const afterBeginLine = html.indexOf("\n", begin) + 1;
	return html.slice(0, afterBeginLine) + body + html.slice(end);
}

async function main() {
	let overrides;
	try {
		overrides = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"));
	} catch (err) {
		fail(`could not read ${OVERRIDES_FILE}: ${err.message}`);
	}

	const items = await fetchAllRaindrops();
	const links = toLinks(items, overrides);

	const html = readFileSync(HTML_FILE, "utf8");
	const { icons, fetched } = await inlineFavicons(links, readInlinedIcons(html));

	const linksBlock =
		"\t\t\tconst LINKS = [\n" +
		links.map(renderEntry).join("\n") +
		"\n\t\t\t];\n\t\t\t";

	const iconsBlock =
		"\t\t\tconst ICONS = {\n" +
		Object.keys(icons)
			.sort()
			.map((d) => `\t\t\t\t${str(d)}: ${str(icons[d])},`)
			.join("\n") +
		"\n\t\t\t};\n\t\t\t";

	let out = replaceBlock(html, "LINKS", linksBlock);
	out = replaceBlock(out, "ICONS", iconsBlock);

	if (out === html) {
		console.log(
			`sync-raindrop: no change (${links.length} links${fetched ? `, ${fetched} favicon(s) re-fetched identical` : ""})`,
		);
		return;
	}
	writeFileSync(HTML_FILE, out);
	console.log(
		`sync-raindrop: wrote ${links.length} links, ${Object.keys(icons).length} inlined icons` +
			(fetched ? ` (${fetched} newly fetched)` : " (all reused)"),
	);
}

await main();
