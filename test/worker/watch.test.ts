import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { planWatch } = await import("../../src/worker/watch.ts");

const NOW = 1_000_000_000_000;

describe("planWatch", () => {
	it("purges once the idle date passes", () => {
		expect(planWatch({ status: { kind: "running" }, expiresAt: NOW, intervalMin: 5 }, NOW)).toEqual({ kind: "purge" });
	});

	it("sleeps a paused watch until its purge date", () => {
		expect(planWatch({ status: { kind: "paused" }, expiresAt: NOW + 1000, intervalMin: 5 }, NOW)).toEqual({
			kind: "sleep",
			until: NOW + 1000,
		});
	});

	it("probes a running watch and schedules the next round one interval out", () => {
		expect(planWatch({ status: { kind: "running" }, expiresAt: NOW + 3_600_000, intervalMin: 15 }, NOW)).toEqual({
			kind: "probe",
			nextAt: NOW + 900_000,
		});
	});

	it("never schedules past the purge date", () => {
		expect(planWatch({ status: { kind: "running" }, expiresAt: NOW + 60_000, intervalMin: 5 }, NOW)).toEqual({
			kind: "probe",
			nextAt: NOW + 60_000,
		});
	});
});
