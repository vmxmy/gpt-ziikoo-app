import { generateCandy } from "./candy-gen.ts";
import { generatePelican } from "./pelican-gen.ts";
import type { GeneratorId, Scorer } from "./types.ts";

export type GeneratedContent = { prompt: string; scorer?: Scorer };

const ADJECTIVES = ["amber", "brisk", "calm", "dusty", "early", "faint", "golden", "hollow", "idle", "jagged", "keen", "lucid", "mellow", "narrow", "olive", "pale", "quiet", "rusty", "silent", "tidy", "upper", "vivid", "woven", "young"];
const NOUNS = ["compass", "lantern", "ledger", "anchor", "bellows", "chisel", "drum", "easel", "flask", "gauge", "hinge", "inkwell", "kettle", "ladle", "mallet", "needle", "oar", "pulley", "quill", "rudder", "sextant", "trowel", "valve", "wrench"];
const PLACES = ["northern harbor", "eastern quarry", "southern granary", "western ferry", "upper mill", "lower orchard", "old foundry", "new observatory", "river lock", "mountain station", "coastal archive", "central depot", "inland bakery"];
const FREQUENCIES = ["every third morning", "before each spring tide", "at the end of every month", "after the evening bell", "on the first dry day", "twice in each season", "once the frost has passed"];

const CATALOGUE = Array.from({ length: 210 }, (_, index) => {
	const entry = index + 1;
	return `Entry ${String(entry).padStart(4, "0")}: the ${ADJECTIVES[(entry * 7) % ADJECTIVES.length]} ${NOUNS[(entry * 11) % NOUNS.length]} rests beside the ${PLACES[(entry * 5) % PLACES.length]} and is inspected ${FREQUENCIES[(entry * 3) % FREQUENCIES.length]}.`;
}).join("\n");

export const GENERATORS: Record<GeneratorId, (seed: number) => GeneratedContent> = {
	candy: (seed) => {
		const { prompt, expected } = generateCandy(seed);
		return { prompt, scorer: { type: "final_numbers", expected } };
	},
	pelican: (seed) => ({ prompt: generatePelican(seed), scorer: { type: "svg_animation" } }),
	prefix: (seed) => ({
		prompt: `Measurement ${seed}.\n\nThis fixed catalogue exists only to measure prompt caching and output speed. Do not summarize it.\n\n${CATALOGUE}\n\nIgnore the catalogue above. Count from 1 to 200, one number per line. Output only the numbers.\n`,
	}),
};
