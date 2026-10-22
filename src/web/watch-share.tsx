import { encode } from "uqr";
import { useState } from "preact/hooks";
import { moveBoard } from "./api.ts";
import { saveBoard } from "./watch.ts";

type Props = {
	board: string;
	onReset: (newBoard: string) => void;
};

function QRCode({ data }: { data: string }) {
	const result = encode(data, { ecc: "M" });
	const size = result.size;
	const quiet = 4;
	const total = size + quiet * 2;
	const modules = result.data;
	let path = "";
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (modules[y * size + x]) {
				path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
			}
		}
	}
	return (
		<svg viewBox={`0 0 ${total} ${total}`} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="看板二维码" data-testid="watch-share-qr">
			<rect class="qr-bg" width={total} height={total} />
			<path class="qr-fg" d={path} />
		</svg>
	);
}

function downloadQR(board: string): void {
	const result = encode(`${location.origin}/#watch/b=${board}`, { ecc: "M" });
	const size = result.size;
	const quiet = 4;
	const scale = 8;
	const total = (size + quiet * 2) * scale;
	const canvas = document.createElement("canvas");
	canvas.width = total;
	canvas.height = total;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, total, total);
	ctx.fillStyle = "#000000";
	const modules = result.data;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (modules[y * size + x]) {
				ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
			}
		}
	}
	canvas.toBlob((blob) => {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "gpt-ziikoo-看板.png";
		a.click();
		URL.revokeObjectURL(url);
	});
}

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
		if (!confirm("重置后旧的二维码与链接立即失效，监测本身不受影响。继续？")) return;
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
			<button type="button" class="btn btn-secondary" onClick={() => setOpen(!open)} data-testid="watch-share-toggle">
				看板二维码
			</button>
			{open && (
				<div class="watch-share" data-testid="watch-share">
					<div class="watch-share-qr">
						<QRCode data={link} />
					</div>
					<input type="text" value={link} readonly class="watch-share-link" data-testid="watch-share-link" />
					<div class="watch-share-actions">
						<button type="button" class="btn btn-secondary" onClick={() => void copy()}>
							{copied ? "已复制" : "复制链接"}
						</button>
						<button type="button" class="btn btn-secondary" onClick={() => downloadQR(board)}>
							保存图片
						</button>
						<button type="button" class="btn btn-secondary" onClick={() => void reset()} disabled={resetting} data-testid="watch-share-reset">
							重置看板码
						</button>
					</div>
					<p class="muted">扫码或打开链接即可在另一台设备载入全部持续监测。这个码就是看板钥匙，只发给自己。</p>
				</div>
			)}
		</>
	);
}
