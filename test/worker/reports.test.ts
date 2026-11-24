import { describe, expect, it } from "vitest";
import { parseReportSave } from "../../src/worker/reports.ts";

describe("parseReportSave", () => {
	const valid = {
		host: "api.example.com",
		model: "gpt-6-astra",
		protocol: "responses",
		overall: "all_passed",
		summary: {
			totalCalls: 31,
			passedCalls: 31,
			failedCalls: 0,
			p50Ms: 420.4,
			ttftP50Ms: 110.6,
			note: "共 1 题，通过 1 题",
		},
	};

	it("accepts a valid sanitized report summary and rounds latencies", () => {
		expect(parseReportSave(valid)).toEqual({
			ok: true,
			value: {
				host: "api.example.com",
				model: "gpt-6-astra",
				protocol: "responses",
				overall: "all_passed",
				summary: {
					totalCalls: 31,
					passedCalls: 31,
					failedCalls: 0,
					p50Ms: 420,
					ttftP50Ms: 111,
					note: "共 1 题，通过 1 题",
				},
			},
		});
	});

	it("accepts a public IPv4 host and omits optional summary fields", () => {
		const res = parseReportSave({
			host: "8.8.8.8",
			model: "claude-sonnet-4-6",
			protocol: "anthropic",
			overall: "partial",
			summary: {
				totalCalls: 10,
				passedCalls: 5,
				failedCalls: 5,
			},
		});
		expect(res).toEqual({
			ok: true,
			value: {
				host: "8.8.8.8",
				model: "claude-sonnet-4-6",
				protocol: "anthropic",
				overall: "partial",
				summary: {
					totalCalls: 10,
					passedCalls: 5,
					failedCalls: 5,
				},
			},
		});
	});

	it("rejects private IPv4, localhost, URLs, and oversized host", () => {
		expect(parseReportSave({ ...valid, host: "127.0.0.1" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, host: "192.168.1.1" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, host: "localhost" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, host: "https://api.example.com" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, host: `${"a".repeat(250)}.com` }).ok).toBe(false);
	});

	it("rejects invalid model, protocol, and overall", () => {
		expect(parseReportSave({ ...valid, model: "" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, model: "a".repeat(101) }).ok).toBe(false);
		expect(parseReportSave({ ...valid, protocol: "unknown" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, overall: "unknown" }).ok).toBe(false);
	});

	it("rejects key-like patterns in host, model, or summary.note", () => {
		expect(parseReportSave({ ...valid, model: "sk-1234567890abcdef" }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { ...valid.summary, note: "token sk-proj-abc12345" } }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { ...valid.summary, note: "Bearer secret_token_1234" } }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { ...valid.summary, note: "AIzaSyDummyKey12345" } }).ok).toBe(false);
	});

	it("rejects raw text > 200 chars, extra summary keys, and inconsistent counts", () => {
		expect(parseReportSave({ ...valid, summary: { ...valid.summary, note: "x".repeat(201) } }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { ...valid.summary, rawBody: "hello" } }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { totalCalls: 5, passedCalls: 6, failedCalls: 0 } }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { totalCalls: 5, passedCalls: 3, failedCalls: 3 } }).ok).toBe(false);
		expect(parseReportSave({ ...valid, summary: { totalCalls: 5, passedCalls: 3, failedCalls: 2, p50Ms: -1 } }).ok).toBe(false);
	});
});
