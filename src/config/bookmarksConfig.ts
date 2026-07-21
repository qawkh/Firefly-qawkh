import type {
	BookmarkGroup,
	BookmarksPageConfig,
} from "../types/bookmarksConfig";

// 可以在 src/content/spec/bookmarks.mdx 中编写收藏夹页面下方的自定义内容

// 收藏夹页面配置
export const bookmarksPageConfig: BookmarksPageConfig = {
	title: "收藏夹",
	description: "常用网站、工具和内容入口。",
	showCustomContent: false,
	showComment: false,
	randomizeSort: false,
};

// 静态兜底收藏夹配置。生产展示优先使用后端 /api/user/bookmarks 返回的数据。
export const bookmarksConfig: BookmarkGroup[] = [];

// 获取启用的收藏分组并进行排序
export const getEnabledBookmarkGroups = (): BookmarkGroup[] => {
	const groups = bookmarksConfig
		.filter((group) => group.enabled)
		.map((group) => ({
			...group,
			items: group.items
				.filter((item) => item.enabled)
				.sort((a, b) => a.weight - b.weight),
		}))
		.filter((group) => group.items.length > 0);

	if (bookmarksPageConfig.randomizeSort) {
		return groups.sort(() => Math.random() - 0.5);
	}

	return groups.sort((a, b) => a.weight - b.weight);
};
