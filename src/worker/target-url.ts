export type Site = { ok: true; origin: string; host: string } | { ok: false };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const STRIP_SUFFIXES = ["/chat/completions", "/responses", "/v1"];

// Sites such as openrouter.ai host the API under a path prefix; peel only whole
// segments the probe re-adds itself, so /v11 stays part of the prefix.
function pathPrefix(pathname: string): string {
	let path = pathname;
	let changed = true;
	while (changed) {
		changed = false;
		path = path.replace(/\/+$/, "");
		for (const suffix of STRIP_SUFFIXES) {
			if (!path.endsWith(suffix)) continue;
			path = path.slice(0, -suffix.length);
			changed = true;
			break;
		}
	}
	return path;
}

// The WHATWG parser already lowercases the host, drops port 443 and canonicalises
// hex/decimal IPv4 forms to dotted quads, so checks run on its output.
export function parseSite(input: string): Site {
	if (!URL.canParse(input.trim())) return { ok: false };
	const url = new URL(input.trim());
	// A trailing dot names the same DNS host; left in place it slips past the localhost checks and splits the object id.
	const hostname = url.hostname.replace(/\.+$/, "");
	const rejected =
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		hostname.startsWith("[") ||
		IPV4.test(hostname) ||
		hostname.endsWith(".localhost") ||
		!hostname.includes(".");
	if (rejected) return { ok: false };
	const authority = url.port ? `${hostname}:${url.port}` : hostname;
	return { ok: true, origin: `https://${authority}${pathPrefix(url.pathname)}`, host: hostname };
}
