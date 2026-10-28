import { useEffect, useRef, useState } from "preact/hooks";
import { MONITOR, type MonitorState } from "../shared/monitor.ts";
import { WATCH_IDLE_DAYS, type WatchChange, type WatchStatus, type WatchView } from "../shared/watch.ts";
import { adoptBoard, createWatch, deleteWatch, fetchBoardView, fetchWatch, orderBoard, setWatchState, updateWatch } from "./api.ts";
import { BAR_HINT, LEGEND, MonitorCard } from "./monitor-card.tsx";
import { badgeLabel, emptyBuckets, latencyP50, monitorView } from "./monitor-view.ts";
import { ms, pct } from "./results.ts";
import { WatchAddForm } from "./watch-add.tsx";
import { WatchEditForm } from "./watch-edit.tsx";
import { WatchShare } from "./watch-share.tsx";
import {
	BOARD_KEY,
	cardId,
	cardLabel,
	clearLegacyTokens,
	loadBoard,
	loadLegacyTokens,
	nextSort,
	parseBoardHash,
	parseWatchInput,
	saveBoard,
	sortRows,
	statusNotice,
	type FieldError,
	type SortKey,
	type TableSort,
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
	onMove: (token: string, to: "top" | "up" | "down") => void;
	editing: boolean;
	onEdit: (token: string | null) => void;
	onSave: (token: string, change: WatchChange) => Promise<string | null>;
};

const cardName = (card: WatchCard): string => (card.kind === "live" ? cardLabel(card.view) : `令牌 ${cardId(card.token)}`);

// `running` as a boolean cannot say bad_key, whose row shows neither pause nor resume.
type LiveRowCells = { kind: "live"; host: string; alias: string | null; state: MonitorState; label: string; uptime: string; correct: string; p50: string; states: MonitorState[]; status: WatchStatus["kind"] };
type LiveCard = Extract<WatchCard, { kind: "live" }>;

const bucketsOf = (view: WatchView) => (view.monitor.buckets.length === MONITOR.buckets ? view.monitor.buckets : emptyBuckets());

function rowCells(card: LiveCard): LiveRowCells {
	const view = monitorView(card.view.monitor);
	const buckets = bucketsOf(card.view);
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

// Ranked by health so that ascending puts the worst site first, as it does for 可用率 and 答对率.
// insufficient and no_data carry no verdict and sort with the rows that have no value.
const HEALTH: Partial<Record<MonitorState, number>> = { down: 0, degraded: 1, quality: 2, fair: 3, operational: 4 };

const SORT_VALUE: Record<SortKey, (view: WatchView) => string | number | null> = {
	site: (view) => view.alias || view.host,
	state: (view) => HEALTH[view.monitor.state] ?? null,
	uptime: (view) => view.monitor.uptimePct,
	correct: (view) => view.monitor.correctPct,
	p50: (view) => latencyP50(bucketsOf(view)),
};

type BoardActions = Pick<CardProps, "onToggle" | "onRemove" | "onRetry" | "onMove" | "onEdit" | "onSave">;
// Without onMove the row has no 置顶/上移/下移: a sorted list would not show the move.
type RowActionProps = { card: WatchCard; index: number; count: number; editing: boolean } & Pick<BoardActions, "onToggle" | "onRemove" | "onEdit"> &
	Partial<Pick<BoardActions, "onMove">>;

function RowActions({ card, onToggle, onRemove, index, count, onMove, editing, onEdit }: RowActionProps) {
	const t = `custom-${cardId(card.token)}`;
	return (
		<>
			{card.kind === "live" && (
				<button
					type="button"
					class="icon-btn"
					aria-label="修改题目与间隔"
					title="修改题目与间隔"
					aria-expanded={editing}
					onClick={() => onEdit(editing ? null : card.token)}
					data-testid={`${t}-edit`}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path class="icon-stroke" d="M10.8 2.7l2.5 2.5-7.8 7.8H3v-2.5zM9.3 4.2l2.5 2.5" />
					</svg>
				</button>
			)}
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
			{onMove && count >= 2 && (
				<>
					<button type="button" class="icon-btn" aria-label="置顶" title="置顶" disabled={index === 0} onClick={() => onMove(card.token, "top")} data-testid={`${t}-top`}>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path class="icon-stroke" d="M3 3.5h10M8 13V5M4.8 7.7L8 4.5l3.2 3.2" />
						</svg>
					</button>
					<button type="button" class="icon-btn" aria-label="上移" title="上移" disabled={index === 0} onClick={() => onMove(card.token, "up")} data-testid={`${t}-up`}>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path class="icon-stroke" d="M8 13V5M4.8 7.7L8 4.5l3.2 3.2" />
						</svg>
					</button>
					<button type="button" class="icon-btn" aria-label="下移" title="下移" disabled={index === count - 1} onClick={() => onMove(card.token, "down")} data-testid={`${t}-down`}>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path class="icon-stroke" d="M8 3v8M4.8 8.3L8 11.5l3.2-3.2" />
						</svg>
					</button>
				</>
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

function WatchCardItem(props: CardProps & { index: number; count: number }) {
	const { card, now, index, count, onMove } = props;
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
					<RowActions card={card} onToggle={props.onToggle} onRemove={props.onRemove} index={index} count={count} onMove={onMove} editing={props.editing} onEdit={props.onEdit} />
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
			protocol={card.view.protocol}
			questions={card.view.questions}
			view={monitorView(card.view.monitor)}
			now={now}
			actions={<RowActions card={card} onToggle={props.onToggle} onRemove={props.onRemove} index={index} count={count} onMove={onMove} editing={props.editing} onEdit={props.onEdit} />}
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
			{props.editing && <WatchEditForm testPrefix={t} view={card.view} onSave={(change) => props.onSave(card.token, change)} onClose={() => props.onEdit(null)} />}
		</MonitorCard>
	);
}

function WatchTableRow({ card, index, count, onToggle, onRemove, onRetry, onMove, editing, onEdit, onSave }: RowActionProps & Pick<BoardActions, "onRetry" | "onSave">) {
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
						<RowActions card={card} onToggle={onToggle} onRemove={onRemove} index={index} count={count} onMove={onMove} editing={editing} onEdit={onEdit} />
					</div>
				</td>
			</tr>
		);
	}
	const cells = rowCells(card);
	return (
		<>
			<tr data-testid={`${t}-row`} data-paused={cells.status === "paused" ? true : undefined}>
				<td>
					<span class="row-site">
						{cells.alias && <span class="card-alias">{cells.alias}</span>}
						<span class={cells.alias ? "mono muted" : "mono"}>{cells.host}</span>
					</span>
				</td>
				<td data-state={cells.state}>
					<span class="row-state">{cells.label}</span>
				</td>
				<td class="num">{cells.uptime}</td>
				<td class="num">{cells.correct}</td>
				<td class="num" data-col="p50">
					{cells.p50}
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
						<RowActions card={card} onToggle={onToggle} onRemove={onRemove} index={index} count={count} onMove={onMove} editing={editing} onEdit={onEdit} />
					</div>
				</td>
			</tr>
			{editing && (
				<tr data-testid={`${t}-edit-row`}>
					<td colspan={7}>
						<WatchEditForm testPrefix={t} view={card.view} onSave={(change) => onSave(card.token, change)} onClose={() => onEdit(null)} />
					</td>
				</tr>
			)}
		</>
	);
}

function SortHeader({ label, sortKey, sort, onSort, num, col }: { label: string; sortKey: SortKey; sort: TableSort; onSort: (key: SortKey) => void; num?: boolean; col?: string }) {
	const dir = sort?.key === sortKey ? sort.dir : null;
	return (
		<th class={num ? "num" : undefined} data-col={col} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}>
			<button type="button" class="sort-btn" onClick={() => onSort(sortKey)} data-testid={`watch-sort-${sortKey}`}>
				{label}
			</button>
		</th>
	);
}

function WatchTable(props: { cards: WatchCard[]; editing: string | null } & BoardActions) {
	const { cards, editing, onMove, ...rest } = props;
	const [sort, setSort] = useState<TableSort>(null);
	const rows = sort ? sortRows(cards, (card) => (card.kind === "live" ? SORT_VALUE[sort.key](card.view) : null), sort.dir) : cards;
	const header = { sort, onSort: (key: SortKey) => setSort(nextSort(sort, key)) };
	return (
		<div class="watch-table-wrap">
			<table class="watch-table">
				<thead>
					<tr>
						<SortHeader label="站点" sortKey="site" {...header} />
						<SortHeader label="状态" sortKey="state" {...header} />
						<SortHeader label="可用率" sortKey="uptime" num {...header} />
						<SortHeader label="答对率" sortKey="correct" num {...header} />
						<SortHeader label="总耗时中位数" sortKey="p50" num col="p50" {...header} />
						<th data-col="bar">近24小时</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((card, i) => (
						<WatchTableRow key={card.token} card={card} index={i} count={rows.length} onMove={sort ? undefined : onMove} editing={editing === card.token} {...rest} />
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
	const [editing, setEditing] = useState<string | null>(null);
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

	const save = async (token: string, change: WatchChange): Promise<string | null> => {
		try {
			const view = await updateWatch(token, change);
			if (!view) return "监测不存在或已过期";
			setCards((prev) => prev.map((c) => (c.token === token ? { kind: "live", token, view, actionError: null } : c)));
			setEditing(null);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : "保存失败，请重试";
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

	const move = async (token: string, to: "top" | "up" | "down"): Promise<void> => {
		if (!board) return;
		const prev = latest.current;
		const from = prev.findIndex((c) => c.token === token);
		const at = to === "top" ? 0 : to === "up" ? from - 1 : from + 1;
		if (from < 0 || at < 0 || at >= prev.length || at === from) return;
		const next = [...prev];
		const [card] = next.splice(from, 1);
		next.splice(at, 0, card!);
		setCards(next);
		try {
			await orderBoard(board, next.map((c) => c.token));
		} catch (err) {
			const message = err instanceof Error ? err.message : "调整顺序失败，请重试";
			setCards(prev.map((c) => (c.token === token && c.kind === "live" ? { ...c, actionError: message } : c)));
		}
	};

	return (
		<section class="monitor" id="watch-board" aria-label="持续监测">
			<div class="section-head">
				<p class="muted">监测由本站服务器执行，页面关闭后继续。密钥经你同意后加密保存，闲置 {WATCH_IDLE_DAYS} 天无人查看自动删除。</p>
				<div class="section-tools">
					{cards.length >= 2 && (
						<div class="view-toggle" role="group" aria-label="版式">
							<button type="button" class="view-toggle-btn" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")} data-testid="watch-view-cards">
								卡片
							</button>
							<button type="button" class="view-toggle-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")} data-testid="watch-view-list">
								列表
							</button>
						</div>
					)}
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
			{boardNotice && (
				<p class="card-notice" role="status" data-testid="watch-board-notice">
					{boardNotice}
				</p>
			)}
			{adding && <WatchAddForm onAdd={add} onClose={() => setAdding(false)} />}
			{cards.length > 0 && (
				<div class="board-legend">
					<p class="muted small">{BAR_HINT}</p>
					<ul class="legend" aria-label="图例">
						{Object.entries(LEGEND).map(([state, label]) => (
							<li data-state={state} key={state}>
								{label}
							</li>
						))}
					</ul>
				</div>
			)}
			{layout === "cards" || cards.length < 2 ? (
				<div class="grid card-grid">
					{cards.map((card, i) => (
						<WatchCardItem
							key={card.token}
							card={card}
							now={now}
							index={i}
							count={cards.length}
							onToggle={(token, action) => void toggle(token, action)}
							onRemove={(c) => void remove(c)}
							onRetry={(token) => void refreshOne(token)}
							onMove={(token, to) => void move(token, to)}
							editing={editing === card.token}
							onEdit={setEditing}
							onSave={save}
						/>
					))}
					{cards.length === 0 && (
						<button type="button" class="card-add" onClick={() => setAdding(true)} data-testid="watch-add-card">
							<span class="card-add-title">添加站点</span>
							<span class="muted">由本站服务器持续调用你的站点。密钥加密保存，页面关闭后监测继续。</span>
						</button>
					)}
				</div>
			) : (
				<WatchTable
					cards={cards}
					editing={editing}
					onToggle={(token, action) => void toggle(token, action)}
					onRemove={(c) => void remove(c)}
					onRetry={(token) => void refreshOne(token)}
					onMove={(token, to) => void move(token, to)}
					onEdit={setEditing}
					onSave={save}
				/>
			)}
		</section>
	);
}
