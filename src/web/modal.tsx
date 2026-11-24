import { useEffect, type ReactNode } from "react";

type Props = {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
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
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="modal-title">
				<div className="modal-header">
					<h3 id="modal-title">{title}</h3>
					<button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
						×
					</button>
				</div>
				<div className="modal-body">{children}</div>
			</div>
		</div>
	);
}
