const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(pepper: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
