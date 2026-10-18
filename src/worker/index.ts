export { Target } from "./target.ts";

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/ping") return Response.json({ ok: true });
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler;
