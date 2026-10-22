import { useEffect, useRef, useState } from "preact/hooks";
import { WATCH_IDLE_DAYS, WATCH_MAX_PER_IP, type WatchView } from "../shared/watch.ts";
import { createWatch, deleteWatch, fetchWatch, setWatchState } from "./api.ts";
import { MonitorCard } from "./monitor-card.tsx";
import { monitorView } from "./monitor-view.ts";
import { WatchAddForm } from "./watch-add.tsx";
import { cardId, cardLabel, loadTokens, parseWatchInput, saveTokens, statusNotice, type FieldError, type WatchInput } from "./watch.ts";

const REFRESH_MS = 60_000;
const TICK_MS = 1_000;

type WatchCard =
	| { kind: "loading"; token: string }
	| { kind: "live"; token: string; view: WatchView; actionError: string | null }
	| { kind: "error"; token: string; message: string };

type CardProps = {
	card: WatchCard;
	now: number;
	onToggle: (token: string, action: "pause" | "resume") => void;
	onRemove: (card: WatchCard) => void;
	onRetry: (token: string) => void;
};

const cardName = (card: WatchCard): string => (card.kind === "live" ? cardLabel(card.view) : `令牌 ${cardId(card.token)}`);

function CardActions({ card, onToggle, onRemove }: Omit<CardProps, "now" | "onRetry">) {
	const t = `custom-${cardId(card.token)}`;
	return (
		<>
			{card.kind === "live" && card.view.status.kind === "running" && (
				<button type="button" class="btn-text" onClick={() => onToggle(card.token, "pause")} data-testid={`${t}-pause`}>
					暂停
				</button>
			)}
			{card.kind === "live" && card.view.status.kind === "paused" && (
				<button type="button" class="btn-text" onClick={() => onToggle(card.token, "resume")} data-testid={`${t}-resume`}>
					继续监测
				</button>
			)}
			<button
				type="button"
				class="btn-text btn-text-danger"
				onClick={() => confirm(`删除 ${cardName(card)} 的持续监测？服务器上的密钥与调用记录会立即清空。`) && onRemove(card)}
				data-testid={`${t}-remove`}
			>
				删除卡片
			</button>
		</>
	);
}

function WatchCardItem(props: CardProps) {
	const { card, now } = props;
	const t = `custom-${cardId(card.token)}`;
	if (card.kind === "loading") {
		return (
			<section class="card monitor-card" data-testid={`${t}-card`}>
				<p class="muted" data-testid={`${t}-loading`}>
					读取中…
				</p>
			</section>
		);
	}
	if (card.kind === "error") {
		return (
			<section class="card monitor-card" data-testid={`${t}-card`}>
				<h3 class="card-title">
					<span class="mono">{cardName(card)}</span>
				</h3>
				<p class="card-notice" data-kind="rejected" role="alert" data-testid={`${t}-error`}>
					{card.message}
				</p>
				<div class="card-actions">
					<button type="button" class="btn-text" onClick={() => props.onRetry(card.token)} data-testid={`${t}-retry`}>
						重试
					</button>
					<CardActions {...props} />
				</div>
			</section>
		);
	}
	const notice = statusNotice(card.view.status);
	return (
		<MonitorCard
			testPrefix={t}
			rootTestId={`${t}-card`}
			host={card.view.host}
			alias={card.view.alias || undefined}
			source="持续监测"
			protocol={card.view.protocol}
			view={monitorView(card.view.monitor)}
			now={now}
			actions={<CardActions {...props} />}
		>
			{notice && (
				<p class="card-notice" data-kind={card.view.status.kind} role="status" data-testid={`${t}-notice`}>
					{notice}
				</p>
			)}
			{card.actionError && (
				<p class="card-notice" data-kind="rejected" role="alert" data-testid={`${t}-action-error`}>
					{card.actionError}
				</p>
			)}
		</MonitorCard>
	);
}

export function WatchBoard() {
	const [cards, setCards] = useState<WatchCard[]>(() => loadTokens().map((token): WatchCard => ({ kind: "loading", token })));
	const [stored, setStored] = useState(true);
	const [now, setNow] = useState(() => Date.now());
	const [adding, setAdding] = useState(false);
	const latest = useRef(cards);
	latest.current = cards;

	useEffect(() => setStored(saveTokens(cards.map((c) => c.token))), [cards]);

	const patch = (token: string, next: WatchCard | null) =>
		setCards((prev) => (next === null ? prev.filter((c) => c.token !== token) : prev.map((c) => (c.token === token ? next : c))));

	const refreshOne = async (token: string): Promise<void> => {
		try {
			const view = await fetchWatch(token);
			patch(token, view ? { kind: "live", token, view, actionError: null } : null);
		} catch (err) {
			patch(token, { kind: "error", token, message: err instanceof Error ? err.message : "读取失败" });
		}
	};

	// The server drives the probing; the page only re-reads the latest samples once a minute.
	useEffect(() => {
		const refresh = () => {
			for (const { token } of latest.current) void refreshOne(token);
		};
		refresh();
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, []);

	const add = async (input: WatchInput): Promise<FieldError | null> => {
		const draft = parseWatchInput(input);
		if (!draft.ok) return draft.error;
		let result: Awaited<ReturnType<typeof createWatch>>;
		try {
			result = await createWatch(draft.request);
		} catch {
			return { field: "form", message: "连不上本站接口，请稍后再试" };
		}
		if (!result.ok) return { field: result.error.field ?? "form", message: result.error.message };
		const { token, watch } = result.value;
		setCards((prev) => [...prev, { kind: "live", token, view: watch, actionError: null }]);
		return null;
	};

	const toggle = async (token: string, action: "pause" | "resume"): Promise<void> => {
		try {
			const view = await setWatchState(token, action);
			patch(token, view ? { kind: "live", token, view, actionError: null } : null);
		} catch (err) {
			const message = err instanceof Error ? err.message : "操作失败";
			setCards((prev) => prev.map((c) => (c.token === token && c.kind === "live" ? { ...c, actionError: message } : c)));
		}
	};

	const remove = async (card: WatchCard): Promise<void> => {
		try {
			await deleteWatch(card.token);
			patch(card.token, null);
		} catch {
			patch(card.token, card.kind === "live" ? { ...card, actionError: "删除失败，请重试" } : { kind: "error", token: card.token, message: "删除失败，请重试" });
		}
	};

	return (
		<section class="monitor" id="watch-board" aria-labelledby="watch-board-h">
			<div class="section-head">
				<h2 id="watch-board-h">持续监测</h2>
				<div class="section-tools">
					<button
						type="button"
						class="btn btn-secondary"
						aria-expanded={adding}
						onClick={() => setAdding(!adding)}
						data-testid="watch-add-toggle"
					>
						添加站点
					</button>
				</div>
			</div>
			<p class="muted">监测由本站服务器执行，页面关闭后继续。密钥经你同意后加密保存，闲置 {WATCH_IDLE_DAYS} 天无人查看自动删除。</p>
			{adding && <WatchAddForm onAdd={add} onClose={() => setAdding(false)} />}
			<div class="grid card-grid">
				{cards.map((card) => (
					<WatchCardItem key={card.token} card={card} now={now} onToggle={(token, action) => void toggle(token, action)} onRemove={(c) => void remove(c)} onRetry={(token) => void refreshOne(token)} />
				))}
				{cards.length === 0 && (
					<button type="button" class="card-add" onClick={() => setAdding(true)} data-testid="watch-add-card">
						<span class="card-add-title">添加站点</span>
						<span class="muted">由本站服务器持续调用你的站点。密钥加密保存，页面关闭后监测继续。</span>
					</button>
				)}
			</div>
			<p class="footnote">每个网络最多 {WATCH_MAX_PER_IP} 个持续监测。</p>
			{!stored && <p class="warn">浏览器存储不可用，刷新页面后找不到已添加的持续监测。</p>}
		</section>
	);
}
