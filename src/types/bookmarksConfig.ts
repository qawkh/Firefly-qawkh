// 收藏夹配置
export type BookmarkLink = {
	title: string; // 收藏项标题
	desc: string; // 收藏项简介
	imgurl?: string; // 收藏项图片 URL
	siteurl: string; // 收藏项地址
	openInNewWindow?: boolean; // 是否新窗口打开
	tags?: string[]; // 标签数组
	weight: number; // 权重，数字越小排序越靠前
	enabled: boolean; // 是否启用
};

export type BookmarkGroup = {
	title: string; // 分类名称
	slug?: string; // 分类标识
	weight: number; // 权重，数字越小排序越靠前
	enabled: boolean; // 是否启用
	items: BookmarkLink[]; // 分类下收藏项
};

export type BookmarksPageConfig = {
	title?: string; // 页面标题
	description?: string; // 页面描述
	showCustomContent?: boolean; // 是否显示自定义内容（bookmarks.mdx）
	showComment?: boolean; // 是否显示评论区，默认 false
	randomizeSort?: boolean; // 是否打乱排序，如果为 true，将忽略 weight
};
