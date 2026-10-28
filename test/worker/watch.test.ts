import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { alarmAfterUpdate, planWatch, watchRotation } = await import("../../src/worker/watch.ts");

const NOW = 1_000_000_000_000;

describe("watchRotation", () => {
	it("rotates through every watch question on a watch made before questions could be picked", () => {
		expect(watchRotation(undefined).map((q) => q.id)).toEqual(["thibault", "candy", "candy-var", "ciallo"]);
	});

	it("rotates through the picked questions in bank order", () => {
		expect(watchRotation(["ciallo", "thibault"]).map((q) => q.id)).toEqual(["thibault", "ciallo"]);
	});
});

describe("alarmAfterUpdate", () => {
	it("pulls the queued round in for a shorter interval, keeps it for a longer one, and sleeps a paused watch", () => {
		const running = { status: { kind: "running" } as const, expiresAt: NOW + 86_400_000, intervalMin: 1 };
		expect(alarmAfterUpdate(running, NOW + 1_800_000, NOW)).toBe(NOW + 60_000);
		expect(alarmAfterUpdate({ ...running, intervalMin: 30 }, NOW + 60_000, NOW)).toBe(NOW + 60_000);
		expect(alarmAfterUpdate({ ...running, status: { kind: "paused" } }, NOW + 60_000, NOW)).toBe(NOW + 86_400_000);
	});
});

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
