// Search-suggestion proxy for the speeddial search box.
//
// DuckDuckGo's autocomplete endpoint sends no CORS headers, so the static page cannot
// call it directly. This Worker forwards the query, normalizes the reply to a plain
// array of strings, and adds the CORS header. It holds no secrets.
//
//   GET /?q=weather%20ashe  ->  ["weather asheville", "weather asheville nc", ...]

const DDG_AC = "https://duckduckgo.com/ac/";
const MAX_QUERY = 200;
const MAX_RESULTS = 8;

// One day: suggestions barely change, and this lets the browser's own HTTP cache answer
// repeat queries without reaching the Worker at all.
const CACHE_SECONDS = 86400;

export default {
	async fetch(request) {
		if (request.method === "OPTIONS") return reply(null, 204);
		if (request.method !== "GET") return reply({ error: "method not allowed" }, 405);

		const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
		if (!q) return reply([]);
		if (q.length > MAX_QUERY) return reply({ error: "query too long" }, 400);

		const upstream = await fetch(`${DDG_AC}?q=${encodeURIComponent(q)}&type=list`, {
			headers: { "User-Agent": "speeddial-suggest" },
		});
		if (!upstream.ok) return reply({ error: `upstream ${upstream.status}` }, 502);

		// type=list answers ["query", ["s1", "s2", ...]]; the default shape is
		// [{ phrase: "s1" }, ...]. Accept either in case DDG changes its default.
		const data = await upstream.json();
		const list = Array.isArray(data?.[1]) ? data[1] : Array.isArray(data) ? data.map((d) => d?.phrase) : [];
		const suggestions = list.filter((s) => typeof s === "string").slice(0, MAX_RESULTS);

		return reply(suggestions, 200, CACHE_SECONDS);
	},
};

function reply(body, status = 200, maxAge = 0) {
	return new Response(body === null ? null : JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
		},
	});
}
