import { useEffect, useRef, useState } from "preact/hooks";
import { MONITOR, type MonitorState } from "../shared/monitor.ts";
import { WATCH_IDLE_DAYS, WATCH_MAX_PER_IP, type WatchStatus, type WatchView } from "../shared/watch.ts";
import { adoptBoard, createWatch, deleteWatch, fetchBoardView, fetchWatch, setWatchState } from "./api.ts";
import { MonitorCard } from "./monitor-card.tsx";
import { badgeLabel, emptyBuckets, latencyP50, monitorView } from "./monitor-view.ts";
import { ms, pct } from "./results.ts";
import { WatchAddForm } from "./watch-add.tsx";
import { WatchShare } from "./watch-share.tsx";
import {
	BOARD_KEY,
	cardId,
	cardLabel,
	clearLegacyTokens,
	loadBoard,
	loadLegacyTokens,
	parseBoardHash,
	parseWatchInput,
	saveBoard,
	statusNotice,
	type FieldError,
	type WatchInput,
} from "./watch.ts";

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

// `running` as a boolean cannot say bad_key, whose row shows neither pause nor resume.
type LiveRowCells = { kind: "live"; host: string; alias: string | null; state: MonitorState; label: string; uptime: string; correct: string; p50: string; states: MonitorState[]; status: WatchStatus["kind"] };
type LiveCard = Extract<WatchCard, { kind: "live" }>;

function rowCells(card: LiveCard): LiveRowCells {
	const view = monitorView(card.view.monitor);
	const buckets = card.view.monitor.buckets.length === MONITOR.buckets ? card.view.monitor.buckets : emptyBuckets();
	return {
		kind: "live",
		host: card.view.host,
		alias: card.view.alias || null,
		state: view.data.state,
		label: badgeLabel(view),
		uptime: pct(view.data.uptimePct),
		correct: pct(view.data.correctPct),
		p50: ms(latencyP50(buckets)),
		states: buckets.map((b) => b.state),
		status: card.view.status.kind,
	};
}

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

type BoardActions = Pick<CardProps, "onToggle" | "onRemove" | "onRetry">;

function RowActions({ card, onToggle, onRemove }: { card: WatchCard } & Pick<BoardActions, "onToggle" | "onRemove">) {
	const t = `custom-${cardId(card.token)}`;
	return (
		<>
			{card.kind === "live" && card.view.status.kind === "running" && (
				<button type="button" class="icon-btn" aria-label="暂停" title="暂停" onClick={() => onToggle(card.token, "pause")} data-testid={`${t}-pause`}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path class="icon-stroke" d="M5.5 3.5v9M10.5 3.5v9" />
					</svg>
				</button>
			)}
			{card.kind === "live" && card.view.status.kind === "paused" && (
				<button type="button" class="icon-btn" aria-label="继续监测" title="继续监测" onClick={() => onToggle(card.token, "resume")} data-testid={`${t}-resume`}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path class="icon-fill" d="M5 3.2c0-.6.7-1 1.2-.6l6 4.4c.5.4.5 1.2 0 1.6l-6 4.4c-.5.4-1.2 0-1.2-.6V3.2z" />
					</svg>
				</button>
			)}
			<button
				type="button"
				class="icon-btn icon-btn-danger"
				aria-label="删除"
				title="删除"
				onClick={() => confirm(`删除 ${cardName(card)} 的持续监测？服务器上的密钥与调用记录会立即清空。`) && onRemove(card)}
				data-testid={`${t}-remove`}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path class="icon-stroke" d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 8.3c0 .6.5 1.2 1.2 1.2h4.2c.7 0 1.2-.6 1.2-1.2l.7-8.3M6.7 7v4M9.3 7v4" />
				</svg>
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

function WatchTableRow({ card, onToggle, onRemove, onRetry }: { card: WatchCard } & BoardActions) {
	const t = `custom-${cardId(card.token)}`;
	if (card.kind !== "live") {
		return (
			<tr data-testid={`${t}-row`}>
				<td class="mono">{cardName(card)}</td>
				<td colspan={5}>
					{card.kind === "loading" ? (
						<span class="muted" data-testid={`${t}-loading`}>
							读取中…
						</span>
					) : (
						<span class="row-error" data-kind="rejected" data-testid={`${t}-error`}>
							{card.message}
							<button type="button" class="btn-text" onClick={() => onRetry(card.token)} data-testid={`${t}-retry`}>
								重试
							</button>
						</span>
					)}
				</td>
				<td>
					<div class="row-actions">
						<RowActions card={card} onToggle={onToggle} onRemove={onRemove} />
					</div>
				</td>
			</tr>
		);
	}
	const cells = rowCells(card);
	return (
		<tr data-testid={`${t}-row`} data-paused={cells.status === "paused" ? true : undefined}>
			<td>
				<span class="row-site">
					{cells.alias && <span class="card-alias">{cells.alias}</span>}
					<span class={cells.alias ? "mono muted" : "mono"}>{cells.host}</span>
				</span>
			</td>
			<td colspan={4} data-state={cells.state}>
				<span class="row-state">
					{cells.label}
				</span>
				<span class="row-metrics">
					<span class="num">{cells.uptime}</span>
					<span class="num">{cells.correct}</span>
					<span class="num" data-col="p50">
						{cells.p50}
					</span>
				</span>
			</td>
			<td data-col="bar">
				<div class="mini-bar" aria-hidden="true">
					{cells.states.map((state, i) => (
						<span class="segment" data-state={state} key={i} />
					))}
				</div>
			</td>
			<td>
				<div class="row-actions">
					<RowActions card={card} onToggle={onToggle} onRemove={onRemove} />
				</div>
			</td>
		</tr>
	);
}

function WatchTable(props: { cards: WatchCard[] } & BoardActions) {
	const { cards, ...rest } = props;
	return (
		<div class="watch-table-wrap">
			<table class="watch-table">
				<thead>
					<tr>
						<th>站点</th>
						<th colspan={4}>状态 · 可用率 · 答对率 · 总耗时中位数</th>
						<th data-col="bar">近24小时</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{cards.map((card) => (
						<WatchTableRow key={card.token} card={card} {...rest} />
					))}
				</tbody>
			</table>
		</div>
	);
}

export function WatchBoard() {
	const [cards, setCards] = useState<WatchCard[]>([]);
	const [board, setBoard] = useState<string | null>(null);
	const [boardNotice, setBoardNotice] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [adding, setAdding] = useState(false);
	const [layout, setLayout] = useState<"cards" | "list">("cards");
	const latest = useRef(cards);
	latest.current = cards;

	useEffect(() => {
		const migrate = async () => {
			const legacy = loadLegacyTokens();
			if (legacy.length > 0) {
				try {
					const existing = loadBoard();
					const result = await adoptBoard(existing ?? undefined, legacy);
					if (result.board) {
						saveBoard(result.board);
						setBoard(result.board);
						clearLegacyTokens();
					}
				} catch {
					clearLegacyTokens();
				}
			}
		};
		const handleHash = async () => {
			const hashBoard = parseBoardHash(location.hash);
			if (hashBoard) {
				const localBoard = loadBoard();
				try {
					const view = await fetchBoardView(hashBoard);
					if (view.watches.length > 0 || !localBoard) {
						if (localBoard && localBoard !== hashBoard) {
							const moved = await import("./api.ts").then((m) => m.moveBoard(localBoard, hashBoard));
							saveBoard(moved.board);
							setBoard(moved.board);
						} else {
							saveBoard(hashBoard);
							setBoard(hashBoard);
						}
						history.replaceState(null, "", "#watch");
						setBoardNotice("已载入看板");
					} else if (localBoard) {
						saveBoard(localBoard);
						setBoard(localBoard);
						setBoardNotice("看板不存在或已过期");
					}
				} catch {
					if (localBoard) {
						saveBoard(localBoard);
						setBoard(localBoard);
					}
					setBoardNotice("看板不存在或已过期");
				}
			}
		};
		void migrate().then(() => {
			const existing = loadBoard();
			if (existing) setBoard(existing);
			void handleHash();
		});
		addEventListener("hashchange", () => void handleHash());
	}, []);

	useEffect(() => {
		if (!board) return;
		const refresh = async () => {
			try {
				const result = await fetchBoardView(board);
				setCards(
					result.watches.map(({ token, watch }): WatchCard =>
						watch ? { kind: "live", token, view: watch, actionError: null } : { kind: "error", token, message: "读取失败" },
					),
				);
			} catch (err) {
				console.error("board view failed", err);
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [board]);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, []);

	const add = async (input: WatchInput): Promise<FieldError | null> => {
		const draft = parseWatchInput(input, board ?? undefined);
		if (!draft.ok) return draft.error;
		let result: Awaited<ReturnType<typeof createWatch>>;
		try {
			result = await createWatch(draft.request);
		} catch {
			return { field: "form", message: "连不上本站接口，请稍后再试" };
		}
		if (!result.ok) return { field: result.error.field ?? "form", message: result.error.message };
		const { board: newBoard, token, watch } = result.value;
		saveBoard(newBoard);
		setBoard(newBoard);
		setCards((prev) => [...prev, { kind: "live", token, view: watch, actionError: null }]);
		return null;
	};

	const toggle = async (token: string, action: "pause" | "resume"): Promise<void> => {
		try {
			const view = await setWatchState(token, action);
			if (view) {
				setCards((prev) => prev.map((c) => (c.token === token ? { kind: "live", token, view, actionError: null } : c)));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "操作失败";
			setCards((prev) => prev.map((c) => (c.token === token && c.kind === "live" ? { ...c, actionError: message } : c)));
		}
	};

	const remove = async (card: WatchCard): Promise<void> => {
		try {
			await deleteWatch(card.token);
			setCards((prev) => prev.filter((c) => c.token !== card.token));
		} catch {
			setCards((prev) =>
				prev.map((c) =>
					c.token === card.token
						? c.kind === "live"
							? { ...c, actionError: "删除失败，请重试" }
							: { kind: "error", token: card.token, message: "删除失败，请重试" }
						: c,
				),
			);
		}
	};

	const refreshOne = async (token: string): Promise<void> => {
		try {
			const view = await fetchWatch(token);
			if (view) {
				setCards((prev) => prev.map((c) => (c.token === token ? { kind: "live", token, view, actionError: null } : c)));
			}
		} catch (err) {
			setCards((prev) => prev.map((c) => (c.token === token ? { kind: "error", token, message: err instanceof Error ? err.message : "读取失败" } : c)));
		}
	};

	return (
		<section class="monitor" id="watch-board" aria-labelledby="watch-board-h">
			<div class="section-head">
				<h2 id="watch-board-h">持续监测</h2>
				<div class="section-tools">
					<div class="view-toggle" role="group" aria-label="版式">
						<button type="button" class="view-toggle-btn" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")} data-testid="watch-view-cards">
							卡片
						</button>
						<button type="button" class="view-toggle-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")} data-testid="watch-view-list">
							列表
						</button>
					</div>
					{board && cards.length > 0 && <WatchShare board={board} onReset={(newBoard) => setBoard(newBoard)} />}
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
			{boardNotice && (
				<p class="card-notice" role="status" data-testid="watch-board-notice">
					{boardNotice}
				</p>
			)}
			{adding && <WatchAddForm onAdd={add} onClose={() => setAdding(false)} />}
			{layout === "cards" || cards.length === 0 ? (
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
			) : (
				<WatchTable cards={cards} onToggle={(token, action) => void toggle(token, action)} onRemove={(c) => void remove(c)} onRetry={(token) => void refreshOne(token)} />
			)}
			<p class="footnote">每个网络最多 {WATCH_MAX_PER_IP} 个持续监测。</p>
		</section>
	);
}
