import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";

type Props = {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ComponentChildren;
};

export function Modal({ open, onClose, title, children }: Props) {
	useEffect(() => {
		if (!open) return;
		const onEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		addEventListener("keydown", onEscape);
		return () => removeEventListener("keydown", onEscape);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div class="modal-backdrop" onClick={onClose}>
			<div class="modal-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="modal-title">
				<div class="modal-header">
					<h3 id="modal-title">{title}</h3>
					<button type="button" class="modal-close" onClick={onClose} aria-label="关闭">
						×
					</button>
				</div>
				<div class="modal-body">{children}</div>
			</div>
		</div>
	);
}
