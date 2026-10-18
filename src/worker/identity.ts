export async function objectId(pepper: string, origin: string, key: string): Promise<string> {
	const encoder = new TextEncoder();
	const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`${origin}\n${key}`));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
