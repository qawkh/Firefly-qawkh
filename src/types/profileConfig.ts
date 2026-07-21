export type ProfileConfig = {
	avatar?: string;
	name: string;
	bio?: string;
	api?: {
		enable?: boolean;
		endpoint?: string;
	};
	links: {
		name: string;
		url: string;
		icon: string;
		showName?: boolean;
	}[];
};
