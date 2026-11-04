export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function downloadReport(html: string, fileName: string): void {
	const url = URL.createObjectURL(new Blob(["\uFEFF", html], { type: "application/octet-stream" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.click();
	URL.revokeObjectURL(url);
}

export function reportFileName(host: string, model: string, kind: "qps_bench" | "claude_protocol"): string {
	return `${host.replace(/[^\w.-]/g, "-")}_${model.replace(/[^\w.-]/g, "-")}_${kind}.html`;
}
