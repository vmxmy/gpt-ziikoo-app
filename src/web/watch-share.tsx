import { useState } from "preact/hooks";
import { moveBoard } from "./api.ts";
import { saveBoard } from "./watch.ts";
import { Modal } from "./modal.tsx";

type Props = {
	board: string;
	onReset: (newBoard: string) => void;
};

export function WatchShare({ board, onReset }: Props) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [resetting, setResetting] = useState(false);
	const link = `${location.origin}/#watch/b=${board}`;

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			alert("复制失败，请手动选中链接");
		}
	};

	const reset = async () => {
		if (!confirm("重置后旧链接立即失效，监测本身不受影响。继续？")) return;
		setResetting(true);
		try {
			const result = await moveBoard(board);
			saveBoard(result.board);
			onReset(result.board);
		} catch (err) {
			alert(err instanceof Error ? err.message : "重置失败");
		} finally {
			setResetting(false);
		}
	};

	return (
		<>
			<button type="button" class="btn btn-secondary" onClick={() => setOpen(true)} data-testid="watch-share-toggle">
				看板链接
			</button>
			<Modal open={open} onClose={() => setOpen(false)} title="看板链接">
				<div class="watch-share" data-testid="watch-share">
					<input type="text" value={link} readonly class="watch-share-link" data-testid="watch-share-link" />
					<div class="watch-share-actions">
						<button type="button" class="btn btn-secondary" onClick={() => void copy()}>
							{copied ? "已复制" : "复制链接"}
						</button>
						<button type="button" class="btn btn-secondary" onClick={() => void reset()} disabled={resetting} data-testid="watch-share-reset">
							重置看板码
						</button>
					</div>
					<p class="muted">打开链接即可在另一台设备载入全部持续监测。这个码就是看板钥匙，只发给自己。</p>
				</div>
			</Modal>
		</>
	);
}
