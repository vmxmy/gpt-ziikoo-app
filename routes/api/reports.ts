import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { db } from "void/db";
import { reports } from "../../db/schema.ts";
import { parseReportSave } from "../../src/worker/reports.ts";

const HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

export const POST = defineHandler(async (c) => {
	const env = c.env as unknown as Partial<Env>;
	if (env.IP_LIMITER) {
		const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
		if (!(await env.IP_LIMITER.limit({ key: ip })).success) {
			return c.json(
				{ error: "rate_limited", message: "请求过于频繁", retryAfterSec: 60 },
				429,
				{ ...HEADERS, "Retry-After": "60" },
			);
		}
	}

	const user = requireAuth(c);

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		body = undefined;
	}
	const parsed = parseReportSave(body);
	if (!parsed.ok) {
		return c.json({ error: "bad_request", message: parsed.message }, 400, HEADERS);
	}

	const id = crypto.randomUUID();
	const createdAt = Date.now();
	await db.insert(reports).values({
		id,
		userId: user.id,
		host: parsed.value.host,
		model: parsed.value.model,
		protocol: parsed.value.protocol,
		overall: parsed.value.overall,
		summaryJson: JSON.stringify(parsed.value.summary),
		aiDiagnosis: null,
		createdAt,
	});

	return c.json({ id, createdAt }, 201, HEADERS);
});
