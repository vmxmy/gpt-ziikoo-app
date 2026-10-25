export type Ride = { vehicle: string; verb: string };

export const RIDERS: readonly string[] = ["鹈鹕", "企鹅", "火烈鸟", "猫头鹰", "袋鼠", "刺猬", "章鱼", "长颈鹿"];

export const RIDES: readonly Ride[] = [
	{ vehicle: "自行车", verb: "骑" },
	{ vehicle: "独轮车", verb: "骑" },
	{ vehicle: "滑板", verb: "踩" },
	{ vehicle: "三轮车", verb: "骑" },
	{ vehicle: "摩托车", verb: "骑" },
	{ vehicle: "热气球", verb: "乘" },
];

export function generatePelican(seed: number): string {
	const combo = seed % (RIDERS.length * RIDES.length);
	const rider = RIDERS[combo % RIDERS.length];
	const { vehicle, verb } = RIDES[Math.floor(combo / RIDERS.length)];
	return `创建一个HTML，内容是用SVG绘制一个${rider}${verb}${vehicle}的2D动画，你不能进行任何测试、禁止调用skills、禁止网络检索，直接生成`;
}
