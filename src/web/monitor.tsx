import { useEffect, useRef, useState } from "preact/hooks";
import { probeSite } from "./api.ts";
import {
	canAdd,
	cardLabel,
	cardMonitor,
	deserializeCards,
	MAX_SITES,
	needsKey,
	newCard,
	normalizeAlias,
	parseSite,
	pauseCard,
	probeCard,
	probeDue,
	resumeCard,
	serializeCards,
	statusNotice,
	STORAGE_KEY,
	type CustomCard,
	type KeyStore,
} from "./custom-monitor.ts";
import { AddSiteForm, type AddInput, type FieldError } from "./monitor-add.tsx";
import { MonitorCard } from "./monitor-card.tsx";
import { monitorView } from "./monitor-view.ts";
import { normalizeKey } from "./results.ts";

const TICK_MS = 1_000;

// Keys live only in this module-level map: never in component state, storage, the URL or the DOM.
const keys: KeyStore = new Map<string, string>();

// Storage can be blocked (private mode, site data disabled); custom monitoring then lives only for this page.
function loadCards(): CustomCard[] {
	try {
		return deserializeCards(localStorage.getItem(STORAGE_KEY), Date.now());
	} catch {
		return [];
	}
}

function saveCards(cards: CustomCard[]): boolean {
	try {
		localStorage.setItem(STORAGE_KEY, serializeCards(cards));
		return true;
	} catch {
		return false;
	}
}

function useScheduler(cards: CustomCard[], questionIds: string[], setCards: (f: (prev: CustomCard[]) => CustomCard[]) => void) {
	const [now, setNow] = useState(() => Date.now());
	const latest = useRef({ cards, questionIds });
	latest.current = { cards, questionIds };
	const inflight = useRef(new Set<string>());
	const hasCards = cards.length > 0;
	useEffect(() => {
		if (!hasCards) return;
		const tick = () => {
			const t = Date.now();
			setNow(t);
			const { cards, questionIds } = latest.current;
			if (questionIds.length === 0) return;
			for (const card of cards) {
				if (inflight.current.has(card.id)) continue;
				inflight.current.add(card.id);
				probeDue(card, keys, questionIds, probeSite, t)
					.then((update) => update && setCards((prev) => prev.map((c) => (c.id === card.id ? update(c) : c))))
					.finally(() => inflight.current.delete(card.id));
			}
		};
		tick();
		const timer = setInterval(tick, TICK_MS);
		return () => clearInterval(timer);
	}, [hasCards, setCards]);
	return now;
}

function useCustomMonitors(questionIds: string[]) {
	const [cards, setCards] = useState(loadCards);
	const [stored, setStored] = useState(true);
	useEffect(() => setStored(saveCards(cards)), [cards]);
	const now = useScheduler(cards, questionIds, setCards);
	const update = (id: string, f: (c: CustomCard) => CustomCard) => setCards((prev) => prev.map((c) => (c.id === id ? f(c) : c)));

	const add = async (input: AddInput): Promise<FieldError | null> => {
		const parsed = parseSite(input.site);
		if (!parsed.ok) return { field: "site", message: parsed.message };
		const key = normalizeKey(input.key);
		if (key === "") return { field: "key", message: "请输入密钥" };
		if (input.model.trim() === "") return { field: "model", message: "请输入模型" };
		if (questionIds.length === 0) return { field: "site", message: "题目还在加载，请稍后再试" };
		const t = Date.now();
		const id = crypto.randomUUID().slice(0, 8);
		const config = { id, site: parsed.site, alias: normalizeAlias(input.alias), model: input.model.trim(), protocol: input.protocol, intervalMin: input.intervalMin, createdAt: t };
		const card = newCard(config, parsed.host);
		const first = (await probeCard(card, key, questionIds, probeSite, t))(card);
		if (first.status.kind === "rejected") return { field: "site", message: first.status.message };
		if (first.unauthorized > 0) return { field: "key", message: "密钥无效或模型无权限，请检查后重试" };
		keys.set(card.id, key);
		setCards((prev) => (canAdd(prev) ? [...prev, first] : prev));
		return null;
	};
	const remove = (id: string) => {
		keys.delete(id);
		setCards((prev) => prev.filter((c) => c.id !== id));
	};
	const pause = (id: string) => update(id, pauseCard);
	const resume = (id: string, key?: string) => {
		if (key) keys.set(id, key);
		if (keys.has(id)) update(id, (c) => resumeCard(c, Date.now()));
	};
	return { cards, now, stored, add, remove, pause, resume };
}

type CardHandlers = { onPause: (id: string) => void; onResume: (id: string, key?: string) => void; onRemove: (id: string) => void };

function CardActions({ card, onPause, onResume, onRemove }: CardHandlers & { card: CustomCard }) {
	const t = `custom-${card.id}`;
	const active = card.status.kind === "running" || card.status.kind === "rate_limited";
	return (
		<>
			{active && (
				<button type="button" class="btn-text" onClick={() => onPause(card.id)} data-testid={`${t}-pause`}>
					暂停
				</button>
			)}
			{!active && !needsKey(card.status) && (
				<button type="button" class="btn-text" onClick={() => onResume(card.id)} data-testid={`${t}-resume`}>
					继续
				</button>
			)}
			<button
				type="button"
				class="btn-text btn-text-danger"
				onClick={() => confirm(`删除 ${cardLabel(card)} 的监测卡片和本地样本？`) && onRemove(card.id)}
				data-testid={`${t}-remove`}
			>
				删除
			</button>
		</>
	);
}

function KeyPrompt({ card, onResume }: { card: CustomCard; onResume: CardHandlers["onResume"] }) {
	const keyInput = useRef<HTMLInputElement>(null);
	const t = `custom-${card.id}`;
	const submit = () => {
		const input = keyInput.current;
		if (!input) return;
		const key = normalizeKey(input.value);
		input.value = "";
		if (key === "") input.focus();
		else onResume(card.id, key);
	};
	return (
		<form
			class="key-row"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<input class="sr-only" type="text" autocomplete="username" value={cardLabel(card)} readOnly tabIndex={-1} aria-hidden="true" />
			<input ref={keyInput} type="password" autocomplete="current-password" spellcheck={false} aria-label={`${cardLabel(card)} 的密钥`} placeholder="重新输入密钥" data-testid={`${t}-key`} />
			<button type="submit" class="btn btn-primary" data-testid={`${t}-resume`}>
				继续监测
			</button>
		</form>
	);
}

function CustomMonitorCard(props: CardHandlers & { card: CustomCard; now: number }) {
	const { card, now } = props;
	const t = `custom-${card.id}`;
	const notice = statusNotice(card.status, now);
	return (
		<MonitorCard testPrefix={t} rootTestId={`${t}-card`} host={card.host} alias={card.alias} source="自定义" protocol={card.protocol} view={monitorView(cardMonitor(card, now))} now={now} actions={<CardActions {...props} />}>
			{notice && (
				<p class="card-notice" data-kind={card.status.kind} role="status" data-testid={`${t}-notice`}>
					{notice}
				</p>
			)}
			{needsKey(card.status) && <KeyPrompt card={card} onResume={props.onResume} />}
		</MonitorCard>
	);
}

export function Monitor({ questionIds }: { questionIds: string[] }) {
	const m = useCustomMonitors(questionIds);
	const [adding, setAdding] = useState(false);
	const full = !canAdd(m.cards);
	return (
		<section class="monitor" id="monitor" aria-labelledby="monitor-board-h">
			<div class="section-head">
				<h2 id="monitor-board-h">监测</h2>
				<div class="section-tools">
					{full && <span class="muted">最多 {MAX_SITES} 个自定义站点</span>}
					<button
						type="button"
						class="btn btn-secondary"
						aria-expanded={adding && !full}
						disabled={full}
						onClick={() => setAdding(!adding)}
						data-testid="monitor-add-toggle"
					>
						添加站点
					</button>
				</div>
			</div>
			{adding && !full && <AddSiteForm ready={questionIds.length > 0} onAdd={m.add} onClose={() => setAdding(false)} />}
			<div class="grid card-grid">
				{m.cards.map((card) => (
					<CustomMonitorCard key={card.id} card={card} now={m.now} onPause={m.pause} onResume={m.resume} onRemove={m.remove} />
				))}
				{!full && (
					<button type="button" class="card-add" onClick={() => setAdding(true)} data-testid="monitor-add-card">
						<span class="card-add-title">添加站点</span>
						<span class="muted">监测你自己的中转站。站点与样本只存在本浏览器，密钥不保存。</span>
					</button>
				)}
			</div>
			{m.cards.length > 0 && <p class="footnote">关闭页面后自定义监测暂停。密钥不会被保存。</p>}
			{!m.stored && <p class="warn">浏览器存储不可用，刷新页面后自定义监测卡片会消失。</p>}
		</section>
	);
}
