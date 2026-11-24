import { integer, sqliteTable, text } from "void/schema-d1";

export const reports = sqliteTable("reports", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull(),
	host: text("host").notNull(),
	model: text("model").notNull(),
	protocol: text("protocol").notNull(),
	overall: text("overall").notNull(),
	summaryJson: text("summary_json").notNull(),
	aiDiagnosis: text("ai_diagnosis"),
	createdAt: integer("created_at").notNull(),
});
