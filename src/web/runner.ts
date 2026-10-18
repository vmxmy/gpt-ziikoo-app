import { evaluateQuestion, MAX_ATTEMPTS, STAGES, type LadderCall } from "../shared/ladder.ts";
import type { ProbeResponse, Protocol } from "../shared/types.ts";

export type ProbeArgs = {
	question: string;
	protocol: Protocol;
	runId: string;
	stage: number;
	seq: number;
	attempt: number;
};

export type ProbeOutcome =
	| { kind: "response"; response: ProbeResponse }
	| { kind: "network_error" }
	| { kind: "stop"; status: number; message: string; retryAfterSec: number | null };

export type Probe = (args: ProbeArgs, signal: AbortSignal) => Promise<ProbeOutcome>;

export type CallState = "pending" | "ok" | "wrong" | "fail";

export type Attempt = ProbeArgs & { response: ProbeResponse | null; done: boolean };

export type StopInfo = { status: number; message: string; retryAfterSec: number | null };

export type RunSnapshot = {
	runId: string;
	protocol: Protocol | null;
	attempts: Attempt[];
	stop: StopInfo | null;
	cancelled: boolean;
	finished: boolean;
};

export type RunOptions = {
	runId: string;
	questions: string[];
	probe: Probe;
	signal: AbortSignal;
	protocol?: Protocol;
	concurrency?: number;
	onUpdate?: (snapshot: RunSnapshot) => void;
};

export const CONCURRENCY = 4;
export const RATE_LIMIT_RETRIES = 3;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done);
	});
}

export function callState(a: Attempt): CallState {
	if (!a.done) return "pending";
	if (!a.response?.ok) return "fail";
	return a.response.correct === false ? "wrong" : "ok";
}

export function ladderCalls(attempts: Attempt[], question: string, protocol: Protocol | null): LadderCall[] {
	return attempts
		.filter((a) => a.done && a.question === question && (protocol === null || a.protocol === protocol))
		.map((a) => ({
			stage: a.stage,
			seq: a.seq,
			attempt: a.attempt,
			ok: a.response?.ok === true,
			correct: a.response?.ok ? a.response.correct : null,
		}));
}

const sameCall = (a: ProbeArgs, b: ProbeArgs) =>
	a.question === b.question && a.protocol === b.protocol && a.stage === b.stage && a.seq === b.seq && a.attempt === b.attempt;

export async function runLadder(opts: RunOptions): Promise<RunSnapshot> {
	const { runId, questions, probe, onUpdate, concurrency = CONCURRENCY } = opts;
	const stopCtrl = new AbortController();
	const runSignal = AbortSignal.any([opts.signal, stopCtrl.signal]);
	let snap: RunSnapshot = {
		runId,
		protocol: opts.protocol ?? null,
		attempts: [],
		stop: null,
		cancelled: false,
		finished: false,
	};
	const update = (patch: Partial<RunSnapshot>) => {
		snap = { ...snap, ...patch };
		onUpdate?.(snap);
	};

	async function probeOnce(args: ProbeArgs, signal: AbortSignal): Promise<ProbeOutcome> {
		try {
			return await probe(args, signal);
		} catch (err) {
			if (!signal.aborted) throw err;
			return { kind: "network_error" };
		}
	}

	// Aborted calls are dropped instead of recorded, so a cancel or early stop never counts as a failed attempt.
	async function call(args: ProbeArgs, signal: AbortSignal): Promise<ProbeResponse | null | "aborted"> {
		if (signal.aborted) return "aborted";
		update({ attempts: [...snap.attempts, { ...args, response: null, done: false }] });
		let outcome = await probeOnce(args, signal);
		// A full two-question run on a fast site exceeds the per-host limit; the worker rejects before recording,
		// so resending the same attempt after Retry-After is safe. A 429 without one (call cap, edge WAF) still stops.
		for (let waits = 0; outcome.kind === "stop" && outcome.retryAfterSec !== null && waits < RATE_LIMIT_RETRIES && !signal.aborted; waits++) {
			await sleep(outcome.retryAfterSec * 1000, signal);
			if (signal.aborted) break;
			outcome = await probeOnce(args, signal);
		}
		if (signal.aborted || outcome.kind === "stop") {
			update({ attempts: snap.attempts.filter((a) => !sameCall(a, args)) });
			if (outcome.kind === "stop" && !snap.stop) {
				update({ stop: { status: outcome.status, message: outcome.message, retryAfterSec: outcome.retryAfterSec } });
				stopCtrl.abort();
			}
			return "aborted";
		}
		const response = outcome.kind === "response" ? outcome.response : null;
		update({ attempts: snap.attempts.map((a) => (sameCall(a, args) ? { ...a, response, done: true } : a)) });
		return response;
	}

	async function runSeq(question: string, protocol: Protocol, stage: number, seq: number, signal: AbortSignal) {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const res = await call({ question, protocol, runId, stage, seq, attempt }, signal);
			if (res === "aborted" || res?.ok) return;
		}
	}

	async function detectProtocol(question: string): Promise<Protocol> {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const base = { question, runId, stage: 1, seq: 1, attempt };
			const [responses, chat] = await Promise.all([
				call({ ...base, protocol: "responses" }, runSignal),
				call({ ...base, protocol: "chat" }, runSignal),
			]);
			if (responses !== "aborted" && responses?.ok) return "responses";
			if (chat !== "aborted" && chat?.ok) return "chat";
			if (runSignal.aborted) break;
		}
		return "responses";
	}

	async function runStage(question: string, protocol: Protocol, index: number) {
		const stage = index + 1;
		const stageCtrl = new AbortController();
		const signal = AbortSignal.any([runSignal, stageCtrl.signal]);
		const check = () => {
			const v = evaluateQuestion(ladderCalls(snap.attempts, question, protocol));
			if (v.status === "unavailable" || v.stages[index]!.state === "failed") stageCtrl.abort();
		};
		let next = 1;
		const worker = async () => {
			while (!signal.aborted && next <= STAGES[index]!.calls) {
				await runSeq(question, protocol, stage, next++, signal);
				check();
			}
		};
		check();
		await Promise.all(Array.from({ length: concurrency }, worker));
	}

	async function runQuestion(question: string, protocol: Protocol, startStage: number) {
		for (let index = startStage; index < STAGES.length; index++) {
			if (runSignal.aborted) return;
			await runStage(question, protocol, index);
			const v = evaluateQuestion(ladderCalls(snap.attempts, question, protocol));
			if (v.stages[index]!.state !== "passed" || v.status === "unavailable") return;
		}
	}

	const [first, ...rest] = questions;
	if (first !== undefined && snap.protocol === null) {
		const protocol = await detectProtocol(first);
		update({ protocol });
		const v = evaluateQuestion(ladderCalls(snap.attempts, first, protocol));
		// The race already settled stage 1 of the first question; an unreachable site stops the whole run here.
		if (v.status !== "unavailable") {
			const firstRest = v.stages[0]!.state === "passed" ? runQuestion(first, protocol, 1) : null;
			await Promise.all([firstRest, ...rest.map((q) => runQuestion(q, protocol, 0))]);
		}
	} else if (snap.protocol !== null) {
		const protocol = snap.protocol;
		await Promise.all(questions.map((q) => runQuestion(q, protocol, 0)));
	}
	update({ cancelled: opts.signal.aborted, finished: true });
	return snap;
}
