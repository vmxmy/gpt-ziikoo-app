export const PROTOCOLS = ["responses", "chat", "anthropic", "gemini"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

const DEFAULT_PROTOCOL = "responses" satisfies Protocol;
const RACE_PARTNER = "chat" satisfies Protocol;

const MODEL_FAMILIES: Record<Protocol, RegExp | null> = { responses: null, chat: null, anthropic: /claude/i, gemini: /gemini/i };

const family = (model: string): Protocol | null => PROTOCOLS.find((p) => MODEL_FAMILIES[p]?.test(model)) ?? null;

// The first protocol wins when both answer the stage-1 race.
export const raceProtocols = (model: string): readonly [Protocol, Protocol] => [family(model) ?? DEFAULT_PROTOCOL, RACE_PARTNER];

export function protocolForModel(model: string, current: Protocol): Protocol {
	return family(model) ?? (MODEL_FAMILIES[current] ? DEFAULT_PROTOCOL : current);
}

// The page races the family protocol against chat and continues with the first of the two when both answer or neither does
// (design.md). This order puts that first protocol ahead in every race.
export const RACE_ORDER: readonly Protocol[] = [...PROTOCOLS.filter((p) => p !== RACE_PARTNER), RACE_PARTNER];

export const PROTOCOL_MESSAGE = `protocol 必须是 ${PROTOCOLS.slice(0, -1).join("、")} 或 ${PROTOCOLS.at(-1)}`;
