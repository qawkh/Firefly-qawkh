declare module "lunar-javascript" {
	export class Solar {
		static fromYmd(year: number, month: number, day: number): SolarInstance;
	}

	export interface SolarInstance {
		getLunar(): LunarInstance;
		getFestivals(): string[];
		getOtherFestivals(): string[];
	}

	export interface LunarInstance {
		getFestivals(): string[];
		getOtherFestivals(): string[];
		getJieQi(): string;
	}
}
