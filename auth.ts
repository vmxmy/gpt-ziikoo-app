import { emailOTP } from "better-auth/plugins";
import { defineAuth } from "void/auth";
import { sendEmail } from "void/email";
import { resolveAuthProviders } from "./src/worker/auth-providers.ts";
import { ALERT_FROM } from "./src/worker/email-alerts.ts";

export default defineAuth(({ defaults, env }) => {
	const raw = env as unknown as Record<string, string | undefined>;
	const enabled = resolveAuthProviders(raw);
	const socialProviders: NonNullable<typeof defaults.socialProviders> = {
		...defaults.socialProviders,
	};

	if (enabled.google) {
		socialProviders.google = {
			clientId: raw.AUTH_GOOGLE_CLIENT_ID!.trim(),
			clientSecret: raw.AUTH_GOOGLE_CLIENT_SECRET!.trim(),
		};
	}

	if (enabled.github) {
		socialProviders.github = {
			clientId: raw.AUTH_GITHUB_CLIENT_ID!.trim(),
			clientSecret: raw.AUTH_GITHUB_CLIENT_SECRET!.trim(),
		};
	}

	return {
		...defaults,
		emailAndPassword: { enabled: false },
		socialProviders,
		plugins: [
			...(defaults.plugins ?? []),
			emailOTP({
				otpLength: 6,
				expiresIn: 300,
				disableSignUp: false,
				async sendVerificationOTP({ email, otp, type }) {
					const result = await sendEmail({
						from: ALERT_FROM,
						to: email,
						subject: "GPT 降智测试 登录验证码",
						text: `你的登录验证码是：${otp}\n\n验证码 5 分钟内有效。如非本人操作，请忽略此邮件。`,
					});
					console.log(JSON.stringify({ event: "auth_otp", type, ok: result.ok }));
					if (!result.ok) {
						throw new Error("验证码邮件发送失败，请稍后重试");
					}
				},
			}),
		],
	};
});
