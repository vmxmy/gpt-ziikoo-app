import { createEmail, sendEmail } from "void/email";
import { hmacHex } from "./hmac.ts";

export const ALERT_DOMAIN = "mail.gpt.ziikoo.app";
export const ALERT_FROM = `alerts@${ALERT_DOMAIN}`;
export const ALERT_COOLDOWN_MS = 60 * 60_000;

export type EmailCommand = "pause" | "resume" | "recheck";
export type AlertKind = "down" | "bad_key" | "recovered";
export type AlertOutcome = "ok" | "fail" | "bad_key";
export type AlertState = { failures: number; alertedAt: number | null };

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_HEX_RE = /^[0-9a-f]{64}$/i;
const REPLY_TOKEN_RE = /^([a-z2-7]{52})-([0-9a-f]{8})$/i;

const COMMAND_ALIASES: Record<string, EmailCommand> = {
	pause: "pause",
	暂停: "pause",
	resume: "resume",
	继续: "resume",
	恢复: "resume",
	recheck: "recheck",
	重测: "recheck",
	立即检测: "recheck",
};

/** Encode an even-length hex string as unpadded lowercase RFC 4648 base32. */
export function hexToBase32(hex: string): string {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
		throw new Error("invalid hex input");
	}
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < hex.length; i += 2) {
		buffer = (buffer << 8) | parseInt(hex.slice(i, i + 2), 16);
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f]!;
			buffer &= (1 << bits) - 1;
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]!;
	}
	return out;
}

/** Decode unpadded case-insensitive RFC 4648 base32 into lowercase hex. */
export function base32ToHex(b32: string): string | null {
	if (b32.length === 0 || [1, 3, 6].includes(b32.length % 8)) return null;
	const lower = b32.toLowerCase();
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < lower.length; i++) {
		const val = BASE32_ALPHABET.indexOf(lower[i]!);
		if (val === -1) return null;
		buffer = (buffer << 5) | val;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >>> bits) & 0xff);
			buffer &= (1 << bits) - 1;
		}
	}
	if (bits > 0 && buffer !== 0) return null;
	return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build an RFC 5321 lowercase-safe reply token (`52b32-8hex`). */
export async function makeReplyToken(pepper: string, idHex: string): Promise<string> {
	if (!ID_HEX_RE.test(idHex)) throw new Error("idHex must be 64 hex chars");
	const normalized = idHex.toLowerCase();
	const sig = (await hmacHex(pepper, `email-reply\n${normalized}`)).slice(0, 8);
	return `${hexToBase32(normalized)}-${sig}`;
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/** Verify a reply token and return the 64-char lowercase watch ID hex, or null. */
export async function verifyReplyToken(pepper: string, token: string): Promise<string | null> {
	const match = REPLY_TOKEN_RE.exec(token);
	if (!match) return null;
	const idHex = base32ToHex(match[1]!.toLowerCase());
	if (!idHex || idHex.length !== 64) return null;
	const expected = (await hmacHex(pepper, `email-reply\n${idHex}`)).slice(0, 8);
	return constantTimeEqual(match[2]!.toLowerCase(), expected) ? idHex : null;
}

/** Construct the per-watch reply-to address within the 64-byte local-part limit. */
export async function replyAddress(pepper: string, idHex: string): Promise<string> {
	return `w+${await makeReplyToken(pepper, idHex)}@${ALERT_DOMAIN}`;
}

/** Extract a control command from the first non-empty, non-quoted line of text, or subject. */
export function parseEmailCommand(text: string | undefined, subject: string | undefined): EmailCommand | null {
	const firstLine = (text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line !== "" && !line.startsWith(">"));
	const candidate = (firstLine ?? subject ?? "").trim().toLowerCase();
	return COMMAND_ALIASES[candidate] ?? null;
}

/** Pure alert state transition for failure, bad_key, and recovery notifications. */
export function evaluateAlert(
	prev: AlertState | undefined,
	outcome: AlertOutcome,
	now: number,
): { next: AlertState; send: AlertKind | null } {
	const state = prev ?? { failures: 0, alertedAt: null };
	if (outcome === "ok") {
		const send: AlertKind | null = state.alertedAt !== null ? "recovered" : null;
		return { next: { failures: 0, alertedAt: null }, send };
	}
	const cooldownReady = state.alertedAt === null || now - state.alertedAt >= ALERT_COOLDOWN_MS;
	const failures = state.failures + 1;
	if (outcome === "bad_key") {
		return cooldownReady
			? { next: { failures, alertedAt: now }, send: "bad_key" }
			: { next: { failures, alertedAt: state.alertedAt }, send: null };
	}
	if (failures >= 2 && cooldownReady) {
		return { next: { failures, alertedAt: now }, send: "down" };
	}
	return { next: { failures, alertedAt: state.alertedAt }, send: null };
}

export type SendAlertEmailOptions = {
	to: string;
	replyTo?: string;
	subject: string;
	text: string;
	host: string;
	kind: AlertKind;
};

/** Send an alert email via SEND_EMAIL inside DO alarms, or fall back to void/email sendEmail. */
export async function sendAlertEmail(env: Partial<Pick<Env, "SEND_EMAIL">>, opts: SendAlertEmailOptions): Promise<boolean> {
	const mailOpts = {
		from: ALERT_FROM,
		to: opts.to,
		...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
		subject: opts.subject,
		text: opts.text,
	};
	let ok = false;
	try {
		if (env.SEND_EMAIL) {
			const { email, raw } = await createEmail(mailOpts);
			const { EmailMessage } = await import("cloudflare:email");
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(raw);
					c.close();
				},
			});
			await env.SEND_EMAIL.send(new EmailMessage(email.from.email, opts.to, stream));
			ok = true;
		} else {
			const result = await sendEmail(mailOpts);
			ok = result.ok;
		}
	} catch {
		ok = false;
	}
	console.log(JSON.stringify({ event: "watch_alert", host: opts.host, kind: opts.kind, ok }));
	return ok;
}
