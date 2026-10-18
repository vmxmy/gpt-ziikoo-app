export type Site = { ok: true; origin: string; host: string } | { ok: false };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

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
	return { ok: true, origin: `https://${authority}`, host: hostname };
}
