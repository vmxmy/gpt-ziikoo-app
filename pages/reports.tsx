import { useEffect, useState, type FormEvent } from "react";
import { action, useRouter } from "@void/react";
import type { SavedReport } from "../src/shared/reports.ts";
import type { OverallStatus } from "../src/shared/types.ts";
import type { AuthProviders } from "../src/worker/auth-providers.ts";
import { authClient } from "../src/web/auth-client.ts";
import { ms, OVERALL_LABEL } from "../src/web/results.ts";
import "../src/web/styles.css";
import type { Props } from "./reports.server.ts";

const OTP_RESEND_COOLDOWN_SEC = 60;
const formatTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

function overallText(overall: string): string {
	return overall in OVERALL_LABEL ? OVERALL_LABEL[overall as OverallStatus] : overall;
}

function AuthCard({ onSignedIn, providers }: { onSignedIn: () => Promise<void>; providers: AuthProviders }) {
	const [email, setEmail] = useState("");
	const [otp, setOtp] = useState("");
	const [otpSent, setOtpSent] = useState(false);
	const [cooldown, setCooldown] = useState(0);
	const [busy, setBusy] = useState<"oauth" | "send" | "verify" | null>(null);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
		return () => clearTimeout(timer);
	}, [cooldown]);

	const signInWithProvider = async (provider: "google" | "github") => {
		setError("");
		setStatus("");
		setBusy("oauth");
		try {
			const res = await authClient.signIn.social({ provider, callbackURL: "/reports" });
			if (res.error) {
				setError(res.error.message ?? "登录失败");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "请求失败");
		} finally {
			setBusy(null);
		}
	};

	const sendOtp = async () => {
		const trimmed = email.trim();
		if (!trimmed) {
			setError("请输入邮箱地址");
			return;
		}
		setError("");
		setStatus("");
		setBusy("send");
		try {
			const res = await authClient.emailOtp.sendVerificationOtp({
				email: trimmed,
				type: "sign-in",
			});
			if (res.error) {
				setError(res.error.message ?? "验证码发送失败");
				return;
			}
			setOtpSent(true);
			setCooldown(OTP_RESEND_COOLDOWN_SEC);
			setStatus("验证码已发送至邮箱，5 分钟内有效。");
		} catch (err) {
			setError(err instanceof Error ? err.message : "验证码发送失败");
		} finally {
			setBusy(null);
		}
	};

	const verifyOtp = async () => {
		const trimmedEmail = email.trim();
		const trimmedOtp = otp.trim();
		if (!trimmedEmail) {
			setError("请输入邮箱地址");
			return;
		}
		if (!trimmedOtp) {
			setError("请输入 6 位验证码");
			return;
		}
		setError("");
		setBusy("verify");
		try {
			const res = await authClient.signIn.emailOtp({
				email: trimmedEmail,
				otp: trimmedOtp,
			});
			if (res.error) {
				setError(res.error.message ?? "验证码无效或已过期");
				return;
			}
			await onSignedIn();
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setBusy(null);
		}
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (otpSent) {
			void verifyOtp();
		} else {
			void sendOtp();
		}
	};

	const hasOAuth = providers.google || providers.github;

	return (
		<section className="panel" aria-labelledby="auth-h" data-testid="reports-auth-card">
			<h2 id="auth-h">登录查看报告归档</h2>
			<p className="notice">
				首页 <a href="/">实时测试</a> 与持续监测均可匿名使用，无需账号。报告归档仅保存脱敏后的数值指标（主机名、模型、协议、总评与耗时统计），绝不保存站点密钥或回答原文。
			</p>
			{hasOAuth && (
				<div className="auth-oauth">
					{providers.google && (
						<button
							type="button"
							className="btn btn-secondary"
							disabled={busy !== null}
							onClick={() => void signInWithProvider("google")}
							data-testid="auth-google"
						>
							使用 Google 登录
						</button>
					)}
					{providers.github && (
						<button
							type="button"
							className="btn btn-secondary"
							disabled={busy !== null}
							onClick={() => void signInWithProvider("github")}
							data-testid="auth-github"
						>
							使用 GitHub 登录
						</button>
					)}
				</div>
			)}
			<form className="form auth-form" onSubmit={submit}>
				<label className="field">
					<span className="field-label">邮箱</span>
					<div className="auth-email-row">
						<input
							type="email"
							required
							value={email}
							onChange={(e) => setEmail(e.currentTarget.value)}
							autoComplete="email"
							placeholder="name@example.com"
							data-testid="auth-email"
						/>
						<button
							type="button"
							className="btn btn-secondary"
							disabled={busy !== null || cooldown > 0}
							onClick={() => void sendOtp()}
							data-testid="auth-send-otp"
						>
							{busy === "send" ? "发送中…" : cooldown > 0 ? `${cooldown} 秒后重发` : "发送验证码"}
						</button>
					</div>
				</label>
				{otpSent && (
					<label className="field">
						<span className="field-label">邮箱验证码</span>
						<input
							type="text"
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							required
							value={otp}
							onChange={(e) => setOtp(e.currentTarget.value)}
							placeholder="6 位数字验证码"
							data-testid="auth-otp"
						/>
					</label>
				)}
				{status && (
					<p className="muted small" data-testid="auth-status">
						{status}
					</p>
				)}
				{error && (
					<p className="field-error" role="alert" data-testid="auth-error">
						{error}
					</p>
				)}
				{otpSent && (
					<div className="actions">
						<button type="submit" className="btn btn-primary" disabled={busy !== null} data-testid="auth-submit">
							{busy === "verify" ? "验证中…" : "验证并登录"}
						</button>
					</div>
				)}
				<p className="muted small">未注册邮箱验证通过后将自动创建账号，无需密码。</p>
			</form>
		</section>
	);
}

function ReportCard({ report }: { report: SavedReport }) {
	const [busy, setBusy] = useState<"diagnose" | "remove" | null>(null);
	const [error, setError] = useState("");

	const runDiagnose = async () => {
		setBusy("diagnose");
		setError("");
		try {
			const res = await action("/reports?diagnose", { data: { id: report.id } });
			if (!res.ok) setError(res.error.message);
		} catch (err) {
			setError(err instanceof Error ? err.message : "AI 诊断失败");
		} finally {
			setBusy(null);
		}
	};

	const runRemove = async () => {
		setBusy("remove");
		setError("");
		try {
			const res = await action("/reports?remove", { data: { id: report.id } });
			if (!res.ok) setError(res.error.message);
		} catch (err) {
			setError(err instanceof Error ? err.message : "删除失败");
		} finally {
			setBusy(null);
		}
	};

	return (
		<article className="card" data-testid={`report-card-${report.id}`}>
			<header className="verdict-head">
				<h3>
					<span className="mono">{report.host}</span> · <span className="mono">{report.model}</span>
				</h3>
				<span className="pill" data-status={report.overall}>
					{overallText(report.overall)}
				</span>
				<span className="tag">{report.protocol}</span>
				<span className="muted small num">{formatTime(report.createdAt)}</span>
			</header>
			<dl className="metrics">
				<div>
					<dt>调用数</dt>
					<dd className="num">{report.summary.totalCalls}</dd>
				</div>
				<div>
					<dt>答对调用</dt>
					<dd className="num">{report.summary.passedCalls}</dd>
				</div>
				<div>
					<dt>失败 / 答错</dt>
					<dd className="num">{report.summary.failedCalls}</dd>
				</div>
				<div>
					<dt>总耗时中位数</dt>
					<dd className="num">{ms(report.summary.p50Ms)}</dd>
				</div>
				<div>
					<dt>首字耗时中位数</dt>
					<dd className="num">{ms(report.summary.ttftP50Ms)}</dd>
				</div>
			</dl>
			{report.summary.note && <p className="muted small">{report.summary.note}</p>}
			{report.aiDiagnosis && (
				<p className="notice" data-testid={`report-diagnosis-${report.id}`}>
					{report.aiDiagnosis}
				</p>
			)}
			{error && (
				<p className="warn small" role="alert" data-testid={`report-error-${report.id}`}>
					{error}
				</p>
			)}
			<div className="actions">
				<button
					type="button"
					className="btn btn-secondary"
					disabled={busy !== null}
					onClick={() => void runDiagnose()}
					data-testid={`report-diagnose-${report.id}`}
				>
					{busy === "diagnose" ? "诊断中…" : report.aiDiagnosis ? "重新诊断" : "AI 诊断"}
				</button>
				<button
					type="button"
					className="btn btn-danger"
					disabled={busy !== null}
					onClick={() => void runRemove()}
					data-testid={`report-remove-${report.id}`}
				>
					{busy === "remove" ? "删除中…" : "删除"}
				</button>
			</div>
		</article>
	);
}

export default function ReportsPage({ user, reports, providers }: Props) {
	const router = useRouter();

	const signOut = async () => {
		await authClient.signOut();
		await router.refresh();
	};

	return (
		<div className="container">
			<header className="site-header">
				<div>
					<h1>报告归档</h1>
					<p className="lead">保存脱敏后的测试摘要，并用 Workers AI 生成诊断说明。</p>
				</div>
				<div className="section-tools">
					<nav className="site-nav" aria-label="页面导航">
						<a href="/">返回测试</a>
					</nav>
					{user && (
						<>
							<span className="muted small" data-testid="reports-user-email">
								{user.email}
							</span>
							<button type="button" className="btn btn-secondary" onClick={() => void signOut()} data-testid="auth-signout">
								退出登录
							</button>
						</>
					)}
				</div>
			</header>
			<main className="grid main-grid">
				{!user ? (
					<AuthCard
						providers={providers}
						onSignedIn={async () => {
							await router.refresh();
						}}
					/>
				) : reports.length === 0 ? (
					<section className="panel" data-testid="reports-empty">
						<p className="muted">
							暂无归档报告。完成一次<a href="/">实时测试</a>后，可点击结果区的「归档报告」保存脱敏摘要。
						</p>
					</section>
				) : (
					<div className="grid" data-testid="reports-list">
						{reports.map((report) => (
							<ReportCard key={report.id} report={report} />
						))}
					</div>
				)}
			</main>
			<footer className="site-footer">
				<span>GPT 降智测试</span>
				<span>归档仅存脱敏数值摘要 · 不保存站点密钥与回答原文</span>
			</footer>
		</div>
	);
}
