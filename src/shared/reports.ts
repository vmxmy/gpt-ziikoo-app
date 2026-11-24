import type { Protocol } from "./protocols.ts";
import type { OverallStatus } from "./types.ts";

export type ReportSummary = {
	totalCalls: number;
	passedCalls: number;
	failedCalls: number;
	p50Ms?: number;
	ttftP50Ms?: number;
	note?: string;
};

export type ReportSaveRequest = {
	host: string;
	model: string;
	protocol: Protocol;
	overall: OverallStatus;
	summary: ReportSummary;
};

export type SavedReport = {
	id: string;
	host: string;
	model: string;
	protocol: string;
	overall: string;
	summary: ReportSummary;
	aiDiagnosis: string | null;
	createdAt: number;
};
