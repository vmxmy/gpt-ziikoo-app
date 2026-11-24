import { defineEmail, parseEmail, replyEmail } from "void/email";
import { ALERT_FROM, parseEmailCommand, verifyReplyToken } from "../src/worker/email-alerts.ts";

export default defineEmail(async (message, rawEnv, _ctx, info) => {
	const env = rawEnv as Env;
	const token = info?.params?.token;
	const idHex = token && env.PEPPER ? await verifyReplyToken(env.PEPPER, token) : null;
	if (!idHex) {
		message.setReject("invalid token");
		return;
	}

	let parsed: Awaited<ReturnType<typeof parseEmail>>;
	try {
		parsed = await parseEmail(message);
	} catch {
		message.setReject("invalid message");
		return;
	}

	const command = parseEmailCommand(parsed.text, parsed.subject ?? message.headers.get("Subject") ?? undefined);
	const result = await env.WATCH.get(env.WATCH.idFromName(idHex)).handleEmailCommand(message.from, command, Date.now());
	if (!result.ok) {
		message.setReject("unauthorized");
		return;
	}

	await replyEmail(message, { from: ALERT_FROM, text: result.replyText });
});
