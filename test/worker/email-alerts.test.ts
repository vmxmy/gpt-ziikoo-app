import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmailTestHarness, createInboundTestHarness } from "void/email/testing";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("cloudflare:email", () => ({
	EmailMessage: class {
		constructor(
			readonly from: string,
			readonly to: string,
			readonly raw: ReadableStream<Uint8Array>,
		) {}
	},
}));

const {
	ALERT_COOLDOWN_MS,
	ALERT_DOMAIN,
	ALERT_FROM,
	base32ToHex,
	evaluateAlert,
	hexToBase32,
	makeReplyToken,
	parseEmailCommand,
	replyAddress,
	sendAlertEmail,
	verifyReplyToken,
} = await import("../../src/worker/email-alerts.ts");
const { default: inboundHandler } = await import("../../email/w+[token].ts");
const { Watch } = await import("../../src/worker/watch.ts");

const PEPPER = "pepper-for-email-tests";
const WATCH_ENC_KEY = "enc-key-for-email-tests";
const SAMPLE_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("hexToBase32 / base32ToHex", () => {
	it("round-trips 32-byte watch IDs and arbitrary even-length hex", () => {
		for (const hex of [SAMPLE_ID, "00".repeat(32), "ff".repeat(32), "deadbeef"]) {
			const encoded = hexToBase32(hex);
			expect(encoded).toMatch(/^[a-z2-7]+$/);
			expect(base32ToHex(encoded)).toBe(hex);
			expect(base32ToHex(encoded.toUpperCase())).toBe(hex);
		}
		expect(hexToBase32(SAMPLE_ID)).toHaveLength(52);
	});

	it("rejects invalid hex and invalid base32 inputs", () => {
		expect(() => hexToBase32("")).toThrow();
		expect(() => hexToBase32("abc")).toThrow();
		expect(() => hexToBase32("zzzz")).toThrow();
		expect(base32ToHex("")).toBeNull();
		expect(base32ToHex("a")).toBeNull();
		expect(base32ToHex("abc")).toBeNull();
		expect(base32ToHex("abcdef")).toBeNull();
		expect(base32ToHex("0189")).toBeNull();
		// Non-zero trailing padding bits on 52-char encoding of 32 bytes.
		const valid = hexToBase32(SAMPLE_ID);
		const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
		const lastIdx = alphabet.indexOf(valid.at(-1)!);
		const tampered = valid.slice(0, -1) + alphabet[lastIdx ^ 1]!;
		expect(base32ToHex(tampered)).toBeNull();
	});
});

describe("reply tokens and addresses", () => {
	it("signs, verifies case-insensitively, and stays within RFC 5321 64-byte local-part limit", async () => {
		const token = await makeReplyToken(PEPPER, SAMPLE_ID);
		expect(token).toMatch(/^[a-z2-7]{52}-[0-9a-f]{8}$/);
		expect(await verifyReplyToken(PEPPER, token)).toBe(SAMPLE_ID);
		expect(await verifyReplyToken(PEPPER, token.toUpperCase())).toBe(SAMPLE_ID);

		const address = await replyAddress(PEPPER, SAMPLE_ID);
		expect(address).toBe(`w+${token}@${ALERT_DOMAIN}`);
		const [local] = address.split("@");
		expect(local!.length).toBeLessThanOrEqual(64);
	});

	it("rejects tampered signatures, tampered IDs, and wrong peppers", async () => {
		const token = await makeReplyToken(PEPPER, SAMPLE_ID);
		const [b32, sig] = token.split("-");
		const badSig = (sig![0] === "0" ? "1" : "0") + sig!.slice(1);
		expect(await verifyReplyToken(PEPPER, `${b32}-${badSig}`)).toBeNull();
		const otherToken = await makeReplyToken(PEPPER, "ff".repeat(32));
		expect(await verifyReplyToken(PEPPER, `${otherToken.split("-")[0]}-${sig}`)).toBeNull();
		expect(await verifyReplyToken("other-pepper", token)).toBeNull();
		expect(await verifyReplyToken(PEPPER, "not-a-token")).toBeNull();
	});
});

describe("parseEmailCommand", () => {
	it("parses English and Chinese commands from the first non-empty non-quoted line", () => {
		expect(parseEmailCommand("pause", undefined)).toBe("pause");
		expect(parseEmailCommand("  PAUSE  \n> old line", undefined)).toBe("pause");
		expect(parseEmailCommand("\n> quoted\n  暂停 \n> more", undefined)).toBe("pause");
		expect(parseEmailCommand("Resume", undefined)).toBe("resume");
		expect(parseEmailCommand("继续", undefined)).toBe("resume");
		expect(parseEmailCommand("恢复", undefined)).toBe("resume");
		expect(parseEmailCommand("ReCheck", undefined)).toBe("recheck");
		expect(parseEmailCommand("重测", undefined)).toBe("recheck");
		expect(parseEmailCommand("立即检测", undefined)).toBe("recheck");
	});

	it("falls back to subject when body has only blank/quoted lines", () => {
		expect(parseEmailCommand("", "pause")).toBe("pause");
		expect(parseEmailCommand("\n> quoted\n", "  继续 ")).toBe("resume");
		expect(parseEmailCommand(undefined, "RECHECK")).toBe("recheck");
	});

	it("returns null for unrecognized text and subject", () => {
		expect(parseEmailCommand("hello world", "Re: alert")).toBeNull();
		expect(parseEmailCommand("", "")).toBeNull();
		expect(parseEmailCommand(undefined, undefined)).toBeNull();
	});
});

describe("evaluateAlert", () => {
	const T0 = 1_000_000_000;

	it("requires 2 consecutive failures to trigger down and enforces cooldown", () => {
		const r1 = evaluateAlert(undefined, "fail", T0);
		expect(r1).toEqual({ next: { failures: 1, alertedAt: null }, send: null });

		const r2 = evaluateAlert(r1.next, "fail", T0 + 5_000);
		expect(r2).toEqual({ next: { failures: 2, alertedAt: T0 + 5_000 }, send: "down" });

		// Suppressed within cooldown.
		const r3 = evaluateAlert(r2.next, "fail", T0 + 5_000 + ALERT_COOLDOWN_MS - 1);
		expect(r3).toEqual({ next: { failures: 3, alertedAt: T0 + 5_000 }, send: null });

		// Allowed once cooldown elapses.
		const r4 = evaluateAlert(r3.next, "fail", T0 + 5_000 + ALERT_COOLDOWN_MS);
		expect(r4).toEqual({ next: { failures: 4, alertedAt: T0 + 5_000 + ALERT_COOLDOWN_MS }, send: "down" });
	});

	it("triggers bad_key immediately and suppresses duplicates during cooldown", () => {
		const r1 = evaluateAlert(undefined, "bad_key", T0);
		expect(r1).toEqual({ next: { failures: 1, alertedAt: T0 }, send: "bad_key" });

		const r2 = evaluateAlert(r1.next, "bad_key", T0 + 60_000);
		expect(r2).toEqual({ next: { failures: 2, alertedAt: T0 }, send: null });

		const r3 = evaluateAlert(r2.next, "bad_key", T0 + ALERT_COOLDOWN_MS);
		expect(r3).toEqual({ next: { failures: 3, alertedAt: T0 + ALERT_COOLDOWN_MS }, send: "bad_key" });
	});

	it("triggers recovered only when previously alerted and resets state", () => {
		const noAlert = evaluateAlert({ failures: 1, alertedAt: null }, "ok", T0);
		expect(noAlert).toEqual({ next: { failures: 0, alertedAt: null }, send: null });

		const recovered = evaluateAlert({ failures: 3, alertedAt: T0 - 10_000 }, "ok", T0);
		expect(recovered).toEqual({ next: { failures: 0, alertedAt: null }, send: "recovered" });

		const after = evaluateAlert(recovered.next, "ok", T0 + 5_000);
		expect(after).toEqual({ next: { failures: 0, alertedAt: null }, send: null });
	});
});

function memoryWatchCtx() {
	const kv = new Map<string, unknown>();
	const samples: { ts: number; sample: string }[] = [];
	let alarmAt: number | null = null;
	const sql = {
		exec(query: string, ...args: unknown[]) {
			if (query.startsWith("CREATE TABLE")) return { toArray: () => [] };
			if (query.startsWith("INSERT INTO samples")) {
				samples.push({ ts: Number(args[0]), sample: String(args[1]) });
				return { toArray: () => [] };
			}
			if (query.startsWith("SELECT sample FROM samples")) {
				const cutoff = Number(args[0]);
				return { toArray: () => samples.filter((s) => s.ts > cutoff).sort((a, b) => a.ts - b.ts).map((s) => ({ sample: s.sample })) };
			}
			if (query.startsWith("DELETE FROM samples WHERE ts <=")) {
				const cutoff = Number(args[0]);
				for (let i = samples.length - 1; i >= 0; i--) {
					if (samples[i]!.ts <= cutoff) samples.splice(i, 1);
				}
				return { toArray: () => [] };
			}
			if (query.startsWith("DELETE FROM samples WHERE rowid")) {
				return { toArray: () => [] };
			}
			return { toArray: () => [] };
		},
	};
	return {
		alarm: () => alarmAt,
		storage: {
			get: async (k: string) => kv.get(k),
			put: async (k: string, v: unknown) => {
				kv.set(k, structuredClone(v));
			},
			getAlarm: async () => alarmAt,
			setAlarm: async (t: number) => {
				alarmAt = t;
			},
			deleteAlarm: async () => {
				alarmAt = null;
			},
			deleteAll: async () => {
				kv.clear();
				samples.length = 0;
			},
			sql,
		},
	};
}

describe("outbound alerts and inbound email control round-trip", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("logs only host, kind, and ok without leaking the recipient email or key", async () => {
		const inbox = createEmailTestHarness();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const sent = await sendAlertEmail({}, {
				to: "secret-user@example.com",
				replyTo: await replyAddress(PEPPER, SAMPLE_ID),
				subject: "Alert",
				text: "Body",
				host: "relay.example",
				kind: "down",
			});
			expect(sent).toBe(true);
			expect(inbox.messages).toHaveLength(1);
			expect(inbox.messages[0]!.from.email).toBe(ALERT_FROM);
			expect(inbox.messages[0]!.to[0]!.email).toBe("secret-user@example.com");
			const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(logged).toContain('"event":"watch_alert"');
			expect(logged).toContain('"host":"relay.example"');
			expect(logged).toContain('"kind":"down"');
			expect(logged).toContain('"ok":true');
			expect(logged).not.toContain("secret-user@example.com");
		} finally {
			inbox.dispose();
		}
	});

	it("uses env.SEND_EMAIL with createEmail and cloudflare:email when bound", async () => {
		const sentMessages: { from: string; to: string; raw: ReadableStream<Uint8Array> }[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const env = {
			SEND_EMAIL: {
				send: async (msg: unknown) => {
					sentMessages.push(msg as { from: string; to: string; raw: ReadableStream<Uint8Array> });
					return { messageId: "msg-1" };
				},
			} as unknown as Env["SEND_EMAIL"],
		};
		const ok = await sendAlertEmail(env, {
			to: "user@example.com",
			replyTo: await replyAddress(PEPPER, SAMPLE_ID),
			subject: "Test",
			text: "Hello",
			host: "relay.example",
			kind: "bad_key",
		});
		expect(ok).toBe(true);
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]!.from).toBe(ALERT_FROM);
		expect(sentMessages[0]!.to).toBe("user@example.com");
		const mime = await new Response(sentMessages[0]!.raw).text();
		expect(mime).toContain("Subject: Test");
		expect(mime).toContain("Reply-To:");
		expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ event: "watch_alert", host: "relay.example", kind: "bad_key", ok: true }));
	});

	it("sends down/recovered alerts from Watch.alarm and accepts pause/resume/recheck replies", async () => {
		const inbox = createEmailTestHarness();
		vi.spyOn(console, "log").mockImplementation(() => {});
		let upstreamStatus = 200;
		vi.stubGlobal("fetch", async () => {
			if (upstreamStatus === 200) {
				return new Response(
					JSON.stringify({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "Yes" }] }] }),
				);
			}
			return new Response("upstream down", { status: upstreamStatus });
		});

		const ctx = memoryWatchCtx();
		let watchInstance: InstanceType<typeof Watch>;
		const env = {
			PEPPER,
			WATCH_ENC_KEY,
			HOST_LIMITER: { limit: async () => ({ success: true }) },
			WATCH: {
				idFromName: (name: string) => name,
				get: (id: string) => {
					if (id !== SAMPLE_ID) {
						return { handleEmailCommand: async () => ({ ok: false as const }) };
					}
					return watchInstance;
				},
			},
		};
		watchInstance = new Watch(ctx as unknown as DurableObjectState, env as unknown as Env);

		try {
			const created = await watchInstance.create(
				{
					origin: "https://relay.example",
					host: "relay.example",
					key: "sk-secret-key-1234",
					model: "gpt-6-astra",
					protocol: "responses",
					intervalMin: 5,
					questions: ["thibault"],
					alias: "主通道",
					measure: false,
					alertEmail: "Owner@Example.com",
				},
				SAMPLE_ID,
				Date.now(),
			);
			expect(created.kind).toBe("created");
			if (created.kind !== "created") throw new Error("expected created");
			expect(created.watch.hasAlertEmail).toBe(true);
			expect(JSON.stringify(created.watch)).not.toContain("owner@example.com");
			expect(JSON.stringify(created.watch)).not.toContain("Owner@Example.com");

			// 1st failure: no alert yet. 2nd failure: triggers down alert with replyTo.
			upstreamStatus = 500;
			await watchInstance.alarm();
			expect(inbox.messages).toHaveLength(0);
			await watchInstance.alarm();
			expect(inbox.messages).toHaveLength(1);
			const alertMsg = inbox.messages[0]!;
			expect(alertMsg.subject).toContain("连续检测失败");
			expect(alertMsg.text).not.toContain("sk-secret-key-1234");
			expect(alertMsg.replyTo?.email).toBe(await replyAddress(PEPPER, SAMPLE_ID));

			// Inbound round-trip using the replyTo address from the outbound alert.
			const inbound = createInboundTestHarness({
				routes: { "w+[token]": inboundHandler },
				env,
				slug: null,
			});

			// Reject invalid token.
			await inbound.deliver({ from: "owner@example.com", to: `w+badtoken@${ALERT_DOMAIN}`, text: "pause" });
			expect(inbound.rejects).toEqual(["invalid token"]);

			// Reject unauthorized sender even with valid token.
			await inbound.deliver({ from: "attacker@example.com", to: alertMsg.replyTo!.email, text: "pause" });
			expect(inbound.rejects).toEqual(["invalid token", "unauthorized"]);

			// Unknown command sends usage help reply without rejecting.
			await inbound.deliver({ from: "owner@example.com", to: alertMsg.replyTo!.email, text: "what is this?" });
			expect(inbound.replies).toHaveLength(1);
			expect(new TextDecoder().decode(inbound.replies[0]!.raw)).toContain("pause");

			// Valid pause -> resume -> recheck commands.
			await inbound.deliver({ from: "OWNER@example.com", to: alertMsg.replyTo!.email, text: "pause\n> quoted" });
			expect((await watchInstance.view(Date.now()))?.status).toEqual({ kind: "paused" });
			expect(inbound.replies).toHaveLength(2);

			await inbound.deliver({ from: "owner@example.com", to: alertMsg.replyTo!.email, text: "> quoted only", subject: "继续" });
			expect((await watchInstance.view(Date.now()))?.status).toEqual({ kind: "running" });
			expect(inbound.replies).toHaveLength(3);

			await inbound.deliver({ from: "owner@example.com", to: alertMsg.replyTo!.email, text: "recheck" });
			expect(inbound.replies).toHaveLength(4);
			expect(ctx.alarm()).toBeLessThanOrEqual(Date.now() + 100);

			// Recovery sends recovered alert.
			upstreamStatus = 200;
			await watchInstance.alarm();
			expect(inbox.messages).toHaveLength(2);
			expect(inbox.messages[1]!.subject).toContain("已恢复正常");

			// Update clears alert email and disables inbound command access.
			const clearedView = await watchInstance.update({ alertEmail: null }, Date.now());
			expect(clearedView?.hasAlertEmail).toBe(false);
			expect(await watchInstance.handleEmailCommand("owner@example.com", "pause", Date.now())).toEqual({ ok: false });
		} finally {
			inbox.dispose();
		}
	});
});
