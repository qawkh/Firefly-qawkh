import type { MarkdownHeading } from "astro";
import {
	createMarkdownProcessor,
	type MarkdownRenderer,
} from "@astrojs/markdown-remark";
import { pluginCollapsibleSections } from "@expressive-code/plugin-collapsible-sections";
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers";
import { type CollectionEntry, getCollection, render } from "astro:content";
import type { ExpressiveCodeTheme } from "expressive-code";
import { pluginCollapsible } from "expressive-code-collapsible";
import { pluginLanguageBadge } from "expressive-code-language-badge";
import rehypeExpressiveCode from "rehype-expressive-code";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { expressiveCodeConfig } from "@/config/expressiveCodeConfig";
import { getCategoryUrl } from "@utils/url-utils";

type LocalPostEntry = CollectionEntry<"posts">;
type PostData = LocalPostEntry["data"] & {
	excerpt?: string;
	minutes?: number;
	words?: number;
};

export type PostForList = {
	id: string;
	collection?: "posts";
	body?: string;
	filePath?: string;
	source?: "local" | "remote";
	data: PostData;
};

type ApiResult<T> = {
	code?: number;
	message?: string;
	data?: T;
};

type QawkhArticleTag = {
	id?: number;
	name?: string;
};

type QawkhArticleSummary = {
	id?: number | string;
	title?: string;
	summary?: string;
	coverImage?: string;
	categoryId?: number | string;
	categoryName?: string;
	tags?: QawkhArticleTag[];
	isRecommended?: number;
	publishedAt?: string;
	updatedAt?: string;
};

type QawkhArticleDetail = QawkhArticleSummary & {
	contentMarkdown?: string;
	authorName?: string;
};

const remoteArticleEnabled =
	import.meta.env.PUBLIC_QAWKH_ARTICLES_ENABLED !== "false";
const remoteApiBase =
	import.meta.env.QAWKH_API_BASE ||
	import.meta.env.PUBLIC_QAWKH_API_BASE ||
	"http://localhost:8090";
const remoteArticlesEndpoint =
	import.meta.env.QAWKH_ARTICLES_ENDPOINT ||
	import.meta.env.PUBLIC_QAWKH_ARTICLES_ENDPOINT ||
	"/api/user/articles";

let remoteArticlesPromise: Promise<PostForList[] | null> | null = null;
const remoteArticleDetailCache = new Map<string, Promise<PostForList | null>>();
let remoteMarkdownProcessorPromise: Promise<MarkdownRenderer> | null = null;

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function toAbsoluteApiUrl(endpoint: string): string {
	if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
		return endpoint;
	}
	return `${remoteApiBase.replace(/\/$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function getRemoteArticlesUrl(id?: string): string {
	const base = toAbsoluteApiUrl(remoteArticlesEndpoint).replace(/\/$/, "");
	return id ? `${base}/${encodeURIComponent(id)}` : base;
}

function toDate(value: string | undefined, fallback = new Date()): Date {
	if (!value) return fallback;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? fallback : date;
}

function countWords(markdown: string): number {
	const text = markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/[>#*_~\-`|()[\]{}:]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
	const englishWords = text.match(/[A-Za-z0-9]+/g) || [];
	return chineseChars.length + englishWords.length;
}

function createRemarkMeta(markdown: string, fallbackExcerpt = "") {
	const words = countWords(markdown);
	return {
		words,
		minutes: words > 0 ? Math.max(1, Math.ceil(words / 400)) : 0,
		excerpt: fallbackExcerpt,
	};
}

function slugifyHeading(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	const used = new Map<string, number>();
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
		if (!match) continue;
		const text = match[2].trim();
		let slug = slugifyHeading(text);
		if (!slug) slug = `heading-${headings.length + 1}`;
		const count = used.get(slug) || 0;
		used.set(slug, count + 1);
		if (count > 0) slug = `${slug}-${count}`;
		headings.push({ depth: match[1].length, slug, text });
	}
	return headings;
}

function mapRemoteArticle(article: QawkhArticleSummary): PostForList | null {
	const id = normalizeText(String(article.id ?? ""));
	const title = normalizeText(article.title);
	if (!id || !title) return null;

	const summary = normalizeText(article.summary);
	const contentMarkdown = normalizeText(
		(article as QawkhArticleDetail).contentMarkdown,
	);
	const remarkMeta = contentMarkdown
		? createRemarkMeta(contentMarkdown, summary)
		: { excerpt: summary, minutes: undefined, words: undefined };
	const published = toDate(article.publishedAt, toDate(article.updatedAt));
	const updated = toDate(article.updatedAt, published);

	return {
		id,
		collection: "posts",
		source: "remote",
		body: contentMarkdown,
		data: {
			title,
			published,
			updated,
			draft: false,
			description: summary,
			image: normalizeText(article.coverImage),
			tags: Array.isArray(article.tags)
				? article.tags.map((tag) => normalizeText(tag.name)).filter(Boolean)
				: [],
			category: normalizeText(article.categoryName),
			lang: "",
			pinned: article.isRecommended === 1,
			author: normalizeText((article as QawkhArticleDetail).authorName),
			sourceLink: "",
			licenseName: "",
			licenseUrl: "",
			comment: true,
			password: "",
			passwordHint: "",
			prevTitle: "",
			prevSlug: "",
			nextTitle: "",
			nextSlug: "",
			...remarkMeta,
		},
	};
}

async function fetchRemoteArticleList(): Promise<PostForList[] | null> {
	if (!remoteArticleEnabled) return null;
	if (!remoteArticlesPromise) {
		remoteArticlesPromise = fetch(getRemoteArticlesUrl(), {
			headers: { Accept: "application/json" },
		})
			.then(async (response) => {
				if (!response.ok) return null;
				const payload = (await response.json()) as ApiResult<QawkhArticleSummary[]>;
				if (payload.code !== 200 || !Array.isArray(payload.data)) return null;
				return payload.data
					.map(mapRemoteArticle)
					.filter((post): post is PostForList => Boolean(post));
			})
			.catch((error) => {
				console.warn("qawkh 文章接口加载失败，继续使用本地 Markdown。", error);
				return null;
			});
	}
	return remoteArticlesPromise;
}

async function fetchRemoteArticleDetail(id: string): Promise<PostForList | null> {
	if (!remoteArticleEnabled) return null;
	if (!remoteArticleDetailCache.has(id)) {
		remoteArticleDetailCache.set(
			id,
			fetch(getRemoteArticlesUrl(id), { headers: { Accept: "application/json" } })
				.then(async (response) => {
					if (!response.ok) return null;
					const payload = (await response.json()) as ApiResult<QawkhArticleDetail>;
					if (payload.code !== 200 || !payload.data) return null;
					return mapRemoteArticle(payload.data);
				})
				.catch((error) => {
					console.warn(`qawkh 文章详情加载失败：${id}`, error);
					return null;
				}),
		);
	}
	return remoteArticleDetailCache.get(id) ?? null;
}

export function isRemotePost(post: PostForList): boolean {
	return post.source === "remote";
}

function applyAdjacentPosts(sorted: PostForList[]) {
	for (let i = 1; i < sorted.length; i++) {
		sorted[i].data.nextSlug = sorted[i - 1].id;
		sorted[i].data.nextTitle = sorted[i - 1].data.title;
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		sorted[i].data.prevSlug = sorted[i + 1].id;
		sorted[i].data.prevTitle = sorted[i + 1].data.title;
	}
	return sorted;
}

// // Retrieve posts and sort them by publication date
async function getRawSortedPosts() {
	const remotePosts = await fetchRemoteArticleList();
	if (remotePosts) {
		return remotePosts.sort((a, b) => {
			if (a.data.pinned && !b.data.pinned) return -1;
			if (!a.data.pinned && b.data.pinned) return 1;
			return b.data.published.getTime() - a.data.published.getTime();
		});
	}

	const allBlogPosts = await getCollection("posts", ({ data }) => {
		return import.meta.env.PROD ? data.draft !== true : true;
	});

	const sorted = allBlogPosts.sort((a, b) => {
		// 首先按置顶状态排序，置顶文章在前
		if (a.data.pinned && !b.data.pinned) return -1;
		if (!a.data.pinned && b.data.pinned) return 1;

		// 如果置顶状态相同，则按发布日期排序
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted as PostForList[];
}

export async function getSortedPosts() {
	const sorted = await getRawSortedPosts();
	return applyAdjacentPosts(sorted);
}

export async function getSortedPostsList(): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts();

	// delete post.body
	const sortedPostsList = sortedFullPosts.map((post) => ({
		id: post.id,
		collection: post.collection,
		source: post.source,
		data: post.data,
	}));

	return sortedPostsList;
}

export async function hydratePostDetail(post: PostForList): Promise<PostForList> {
	if (!isRemotePost(post)) return post;
	const detail = await fetchRemoteArticleDetail(post.id);
	if (!detail) return post;
	detail.data.prevSlug = post.data.prevSlug;
	detail.data.prevTitle = post.data.prevTitle;
	detail.data.nextSlug = post.data.nextSlug;
	detail.data.nextTitle = post.data.nextTitle;
	return detail;
}

export async function getPostRemarkMeta(post: PostForList) {
	if (isRemotePost(post)) {
		return {
			words: post.data.words,
			minutes: post.data.minutes,
			excerpt: post.data.excerpt || post.data.description || "",
		};
	}
	const { remarkPluginFrontmatter } = await render(post as LocalPostEntry);
	return remarkPluginFrontmatter;
}

export async function renderRemotePost(post: PostForList) {
	const markdown = post.body || "";
	if (!remoteMarkdownProcessorPromise) {
		remoteMarkdownProcessorPromise = createMarkdownProcessor({
			syntaxHighlight: false,
			rehypePlugins: [
				[
					rehypeExpressiveCode,
					{
						themes: [
							expressiveCodeConfig.darkTheme,
							expressiveCodeConfig.lightTheme,
						],
						useDarkModeMediaQuery: false,
						themeCssSelector: (theme: ExpressiveCodeTheme) =>
							`[data-theme='${theme.name}']`,
						plugins: [
							...(expressiveCodeConfig.pluginLanguageBadge?.enable === true
								? [pluginLanguageBadge()]
								: []),
							pluginCollapsibleSections(),
							pluginLineNumbers(),
							...(expressiveCodeConfig.pluginCollapsible?.enable === true
								? [
										pluginCollapsible({
											lineThreshold:
												expressiveCodeConfig.pluginCollapsible.lineThreshold || 15,
											previewLines:
												expressiveCodeConfig.pluginCollapsible.previewLines || 8,
											defaultCollapsed:
												expressiveCodeConfig.pluginCollapsible.defaultCollapsed ?? true,
											expandButtonText: i18n(I18nKey.codeCollapsibleShowMore),
											collapseButtonText: i18n(I18nKey.codeCollapsibleShowLess),
											expandedAnnouncement: i18n(I18nKey.codeCollapsibleExpanded),
											collapsedAnnouncement: i18n(I18nKey.codeCollapsibleCollapsed),
										}),
									]
								: []),
						],
						defaultProps: {
							wrap: false,
							overridesByLang: {
								shellsession: {
									showLineNumbers: false,
								},
							},
						},
						styleOverrides: {
							borderRadius: "0.75rem",
							codeFontSize: "0.875rem",
							codeFontFamily:
								"var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
							codeLineHeight: "1.5rem",
							frames: {},
							textMarkers: {
								delHue: 0,
								insHue: 180,
								markHue: 250,
							},
							languageBadge: {
								fontSize: "0.75rem",
								fontWeight: "bold",
								borderRadius: "0.25rem",
								opacity: "1",
								borderWidth: "0px",
								borderColor: "transparent",
							},
						},
						frames: {
							showCopyToClipboardButton: true,
						},
					},
				],
			],
		});
	}
	const processor = await remoteMarkdownProcessorPromise;
	const rendered = await processor.render(markdown);
	return {
		html: rendered.code,
		headings: extractMarkdownHeadings(markdown),
		remarkPluginFrontmatter: createRemarkMeta(markdown, post.data.description),
	};
}

export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(): Promise<Tag[]> {
	const allBlogPosts = await getSortedPostsList();

	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post) => {
		post.data.tags.forEach((tag: string) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});

	// sort tags
	const keys: string[] = Object.keys(countMap).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
};

export async function getCategoryList(): Promise<Category[]> {
	const allBlogPosts = await getSortedPostsList();
	const count: { [key: string]: number } = {};
	allBlogPosts.forEach((post) => {
		if (!post.data.category) {
			const ucKey = i18n(I18nKey.uncategorized);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
			return;
		}

		const categoryName =
			typeof post.data.category === "string"
				? post.data.category.trim()
				: String(post.data.category).trim();

		count[categoryName] = count[categoryName] ? count[categoryName] + 1 : 1;
	});

	const lst = Object.keys(count).sort((a, b) => {
		return (
			count[b] - count[a] || a.toLowerCase().localeCompare(b.toLowerCase())
		);
	});

	const ret: Category[] = [];
	for (const c of lst) {
		ret.push({
			name: c,
			count: count[c],
			url: getCategoryUrl(c),
		});
	}
	return ret;
}

/**
 * 对标题进行分词，支持中英文混合
 * 使用 Intl.Segmenter 对中文分词，英文按空格分词
 * 过滤标点和空白，英文统一小写
 */
function tokenizeTitle(title: string): Set<string> {
	const tokens = new Set<string>();
	const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
	for (const { segment, isWordLike } of segmenter.segment(title)) {
		if (!isWordLike) continue;
		tokens.add(segment.toLowerCase());
	}
	return tokens;
}

/**
 * 计算两个集合的 Jaccard 相似度
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * 获取相关文章推荐
 * 评分公式: totalScore = tagMatchScore + titleSimilarityScore + timeFreshnessScore + categoryBonus
 * - tagMatchScore (0-100): 标签 Jaccard 相似度 × 100
 * - titleSimilarityScore (0-100): 标题分词 Jaccard 相似度 × 100
 * - timeFreshnessScore (0-30): 6 个月半衰期指数衰减
 * - categoryBonus (0 or 10): 同分类加 10 分
 */
export async function getRelatedPosts(
	currentPost: PostForList,
	maxCount = 5,
): Promise<PostForList[]> {
	const allPosts = await getSortedPostsList();

	// 排除自身和加密文章
	const candidates = allPosts.filter(
		(p) => p.id !== currentPost.id && !p.data.password,
	);

	const currentTags = new Set(currentPost.data.tags || []);
	const currentTokens = tokenizeTitle(currentPost.data.title);
	const currentCategory = currentPost.data.category || "";
	const now = Date.now();

	const scored = candidates.map((post) => {
		const postTags = new Set(post.data.tags || []);

		// tagMatchScore (0-100)
		const tagMatchScore = jaccardSimilarity(currentTags, postTags) * 100;

		// titleSimilarityScore (0-100)
		const postTokens = tokenizeTitle(post.data.title);
		const titleSimilarityScore =
			jaccardSimilarity(currentTokens, postTokens) * 100;

		// timeFreshnessScore (0-30): 6 个月半衰期
		const daysSincePublished =
			(now - new Date(post.data.published).getTime()) / (1000 * 60 * 60 * 24);
		const timeFreshnessScore =
			30 * Math.exp((-Math.LN2 * daysSincePublished) / 180);

		// categoryBonus (0 or 10)
		const postCategory = post.data.category || "";
		const categoryBonus =
			currentCategory && postCategory && currentCategory === postCategory
				? 10
				: 0;

		const totalScore =
			tagMatchScore + titleSimilarityScore + timeFreshnessScore + categoryBonus;

		return {
			post,
			totalScore,
			tagMatchScore,
			timeFreshnessScore,
			categoryBonus,
		};
	});

	// 按总分降序排列
	scored.sort((a, b) => b.totalScore - a.totalScore);

	// 优先取有标签匹配的
	const withTagMatch = scored.filter((s) => s.tagMatchScore > 0);
	const withoutTagMatch = scored.filter((s) => s.tagMatchScore === 0);

	const result: PostForList[] = [];

	for (const s of withTagMatch) {
		if (result.length >= maxCount) break;
		result.push({
			id: s.post.id,
			collection: s.post.collection,
			source: s.post.source,
			data: s.post.data,
		});
	}

	// 不足时从剩余候选中按 timeFreshnessScore + categoryBonus 降序补充
	if (result.length < maxCount) {
		withoutTagMatch.sort(
			(a, b) =>
				b.timeFreshnessScore +
				b.categoryBonus -
				(a.timeFreshnessScore + a.categoryBonus),
		);
		for (const s of withoutTagMatch) {
			if (result.length >= maxCount) break;
			result.push({
				id: s.post.id,
				collection: s.post.collection,
				source: s.post.source,
				data: s.post.data,
			});
		}
	}

	return result;
}
