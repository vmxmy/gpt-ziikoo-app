import { useState, type FormEvent } from "react";
import { action, useRouter } from "@void/react";
import { auth } from "void/client";
import type { SavedReport } from "../src/shared/reports.ts";
import type { OverallStatus } from "../src/shared/types.ts";
import { ms, OVERALL_LABEL } from "../src/web/results.ts";
import "../src/web/styles.css";
import type { Props } from "./reports.server.ts";

const formatTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

function overallText(overall: string): string {
	return overall in OVERALL_LABEL ? OVERALL_LABEL[overall as OverallStatus] : overall;
}

function AuthCard({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
	const [mode, setMode] = useState<"signin" | "signup">("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setError("");
		setBusy(true);
		try {
			if (mode === "signin") {
				const res = await auth.signIn.email({ email: email.trim(), password });
				if (res.error) {
					setError(res.error.message ?? "登录失败");
					return;
				}
			} else {
				const res = await auth.signUp.email({
					email: email.trim(),
					password,
					name: name.trim() || email.trim().split("@")[0] || "User",
				});
				if (res.error) {
					setError(res.error.message ?? "注册失败");
					return;
				}
			}
			await onSignedIn();
		} catch (err) {
			setError(err instanceof Error ? err.message : "请求失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="panel" aria-labelledby="auth-h" data-testid="reports-auth-card">
			<h2 id="auth-h">{mode === "signin" ? "登录查看报告归档" : "注册归档账号"}</h2>
			<p className="notice">
				首页 <a href="/">实时测试</a> 与持续监测均可匿名使用，无需账号。报告归档仅保存脱敏后的数值指标（主机名、模型、协议、总评与耗时统计），绝不保存站点密钥或回答原文。
			</p>
			<form className="form" onSubmit={(e) => void submit(e)}>
				{mode === "signup" && (
					<label className="field">
						<span className="field-label">昵称</span>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.currentTarget.value)}
							autoComplete="name"
							placeholder="可选"
							data-testid="auth-name"
						/>
					</label>
				)}
				<label className="field">
					<span className="field-label">邮箱</span>
					<input
						type="email"
						required
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						autoComplete="email"
						placeholder="name@example.com"
						data-testid="auth-email"
					/>
				</label>
				<label className="field">
					<span className="field-label">密码</span>
					<input
						type="password"
						required
						minLength={8}
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						autoComplete={mode === "signin" ? "current-password" : "new-password"}
						placeholder="至少 8 位"
						data-testid="auth-password"
					/>
				</label>
				{error && (
					<p className="field-error" role="alert" data-testid="auth-error">
						{error}
					</p>
				)}
				<div className="actions">
					<button type="submit" className="btn btn-primary" disabled={busy} data-testid="auth-submit">
						{busy ? "提交中…" : mode === "signin" ? "登录" : "注册"}
					</button>
					<button
						type="button"
						className="btn-text"
						onClick={() => {
							setMode(mode === "signin" ? "signup" : "signin");
							setError("");
						}}
						data-testid="auth-mode-toggle"
					>
						{mode === "signin" ? "没有账号？去注册" : "已有账号？去登录"}
					</button>
				</div>
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

export default function ReportsPage({ user, reports }: Props) {
	const router = useRouter();

	const signOut = async () => {
		await auth.signOut();
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
