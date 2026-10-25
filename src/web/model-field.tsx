import type { TargetedEvent } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ApiFailure, fetchModels, type Target } from "./api.ts";
import { FAILURE_ADVICE } from "./results.ts";

type LoadState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; models: string[] } | { kind: "failed"; message: string };

type Props = {
	value: string;
	onInput: (v: string) => void;
	target: Target;
	testId: string;
	invalid?: boolean;
	describedBy?: string;
	class?: string;
};

const DEBOUNCE_MS = 600;
const MIN_KEY_CHARS = 8;

const loadable = (target: Target) => target.site !== "" && target.key.length >= MIN_KEY_CHARS;

export function ModelField({ value, onInput, target, testId, invalid, describedBy, class: cellClass }: Props) {
	const baseId = useId();
	const listId = `${baseId}-list`;
	const inputId = `${baseId}-input`;
	const [state, setState] = useState<LoadState>({ kind: "idle" });
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!loadable(target)) {
			setState({ kind: "idle" });
			return;
		}
		const controller = new AbortController();
		setState({ kind: "loading" });
		const timer = setTimeout(() => {
			fetchModels(target, controller.signal).then(
				(result) => setState(result.ok ? { kind: "ready", models: result.models } : { kind: "failed", message: FAILURE_ADVICE[result.reason].reason }),
				(err: unknown) => {
					if (controller.signal.aborted) return;
					setState({ kind: "failed", message: err instanceof ApiFailure ? err.message : "连不上本站接口" });
				},
			);
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [target.site, target.key]);

	const models = state.kind === "ready" ? state.models : [];
	const typing = value.trim() !== "" && !models.includes(value);
	const filtered = typing ? models.filter((id) => id.toLowerCase().includes(value.toLowerCase())) : models;
	const options = filtered.length > 0 ? filtered : models;
	// The filter can shrink the list under a highlight set earlier, so every reader clamps the same way.
	const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
	const activeId = open && options.length > 0 ? `${listId}-${activeIndex}` : undefined;

	const choose = (id: string) => {
		onInput(id);
		setOpen(false);
		input.current?.focus();
	};

	const onKeyDown = (e: TargetedEvent<HTMLInputElement, KeyboardEvent>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (options.length === 0) return;
			if (!open) {
				setOpen(true);
				setActive(0);
			} else setActive(Math.min(activeIndex + 1, options.length - 1));
		} else if (e.key === "ArrowUp" && open) {
			e.preventDefault();
			setActive(Math.max(activeIndex - 1, 0));
		} else if (e.key === "Enter" && open) {
			const pick = options[activeIndex];
			if (pick !== undefined) {
				e.preventDefault();
				choose(pick);
			}
		} else if (e.key === "Escape" && open) {
			e.preventDefault();
			setOpen(false);
		}
	};

	const status =
		state.kind === "idle" ? (
			<p class="muted small" role="status" data-testid={`${testId}-status`}>
				填写站点与密钥后自动加载模型列表
			</p>
		) : state.kind === "loading" ? (
			<p class="muted small" role="status" data-testid={`${testId}-status`}>
				正在加载模型列表…
			</p>
		) : state.kind === "ready" ? (
			<p class="muted small" role="status" data-testid={`${testId}-status`}>
				{models.length > 0 ? `${models.length} 个模型，可从列表选择` : "站点没有返回模型列表"}
			</p>
		) : (
			<p class="warn small" data-testid={`${testId}-status`}>
				{state.message}
			</p>
		);

	return (
		<div class={cellClass ? `field combo ${cellClass}` : "field combo"}>
			<label class="field-label" for={inputId}>
				模型
			</label>
			<div class="affix">
				<input
					ref={input}
					id={inputId}
					value={value}
					onInput={(e) => {
						onInput(e.currentTarget.value);
						if (state.kind === "ready") setOpen(true);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => setOpen(false)}
					role="combobox"
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={activeId}
					aria-invalid={invalid || undefined}
					aria-describedby={invalid ? describedBy : undefined}
					autocomplete="off"
					data-testid={testId}
				/>
				<button
					type="button"
					class="combo-toggle"
					aria-label="展开模型列表"
					data-testid={`${testId}-toggle`}
					disabled={state.kind !== "ready"}
					onClick={() => setOpen(!open)}
				>
					<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
						<path d="M0 2 L4 6 L8 2" fill="none" stroke="currentColor" stroke-width="1.5" />
					</svg>
				</button>
			</div>
			{open &&
				state.kind === "ready" &&
				options.length > 0 && (
					<ul role="listbox" id={listId} class="combo-list" data-testid={`${testId}-list`}>
						{options.map((id, i) => (
							<li
								role="option"
								id={`${listId}-${i}`}
								aria-selected={i === activeIndex}
								data-testid={`${testId}-option`}
								onMouseDown={(e) => {
									e.preventDefault();
									choose(id);
								}}
							>
								{id}
							</li>
						))}
					</ul>
				)}
			{status}
		</div>
	);
}
