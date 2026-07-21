import {
	createMarkdownProcessor,
	type MarkdownRenderer,
} from "@astrojs/markdown-remark";
import { getCollection } from "astro:content";
import {
	dynamicPlainTextFromMarkdown,
	dynamicSearchText,
	dynamicSlug,
	sortDynamics,
} from "@/utils/dynamic-utils";

export type DynamicImage = {
	alt: string;
	src: string;
	title?: string;
};

export type DynamicData = {
	id: string;
	published: number;
	text: string;
	html: string;
	images: DynamicImage[];
	searchText: string;
	authorName?: string;
};

type ApiResult<T> = {
	code?: number;
	message?: string;
	data?: T;
};

type PageResult<T> = {
	total?: number;
	pageNum?: number;
	pageSize?: number;
	records?: T[];
};

type QawkhMoment = {
	id?: number | string;
	contentText?: string;
	imageUrls?: string[];
	imageCount?: number;
	authorName?: string;
	publishedAt?: string;
};

const markdownImagePattern = /!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g;
const remoteMomentEnabled =
	import.meta.env.PUBLIC_QAWKH_MOMENTS_ENABLED !== "false";
const remoteApiBase =
	import.meta.env.QAWKH_API_BASE ||
	import.meta.env.PUBLIC_QAWKH_API_BASE ||
	"http://localhost:8090";
const remoteMomentsEndpoint =
	import.meta.env.QAWKH_MOMENTS_ENDPOINT ||
	import.meta.env.PUBLIC_QAWKH_MOMENTS_ENDPOINT ||
	"/api/user/moments";
const remoteMomentPageSize = 100;

let dynamicDataPromise: Promise<DynamicData[]> | null = null;
let markdownProcessorPromise: Promise<MarkdownRenderer> | null = null;

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function toAbsoluteApiUrl(endpoint: string): string {
	if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
		return endpoint;
	}
	return `${remoteApiBase.replace(/\/$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function getRemoteMomentsUrl(pageNum: number): string {
	const url = new URL(toAbsoluteApiUrl(remoteMomentsEndpoint));
	url.searchParams.set("pageNum", String(pageNum));
	url.searchParams.set("pageSize", String(remoteMomentPageSize));
	return url.toString();
}

function toPublishedTimestamp(value: string | undefined): number {
	if (!value) return Date.now();
	const localDateTime = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
		value,
	);
	if (localDateTime) {
		const [, year, month, day, hour, minute, second = "0"] = localDateTime;
		return Date.UTC(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
		);
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? Date.now() : timestamp;
}

function extractMarkdownImages(markdown: string): {
	markdown: string;
	images: DynamicImage[];
} {
	const images: DynamicImage[] = [];
	const content = markdown.replace(
		markdownImagePattern,
		(_match, alt: string, src: string, title?: string) => {
			images.push({ alt, src, ...(title ? { title } : {}) });
			return "";
		},
	);
	return { markdown: content, images };
}

async function mapMarkdownDynamic(
	id: string,
	markdown: string,
	published: number,
	text: string,
	searchText: string,
	authorName?: string,
): Promise<DynamicData> {
	if (!markdownProcessorPromise) {
		markdownProcessorPromise = createMarkdownProcessor();
	}
	const processor = await markdownProcessorPromise;
	const { markdown: content, images } = extractMarkdownImages(markdown);
	const rendered = await processor.render(content);
	return {
		id,
		published,
		text,
		html: rendered.code,
		images,
		searchText,
		...(authorName ? { authorName } : {}),
	};
}

async function getLocalDynamicData(): Promise<DynamicData[]> {
	const dynamics = sortDynamics(await getCollection("dynamic"));
	return Promise.all(
		dynamics.map((entry) => {
			const text = dynamicPlainTextFromMarkdown(entry.body || "");
			return mapMarkdownDynamic(
				dynamicSlug(entry.id),
				entry.body || "",
				entry.data.published.getTime(),
				text,
				dynamicSearchText(entry),
			);
		}),
	);
}

async function fetchMomentPage(
	pageNum: number,
): Promise<PageResult<QawkhMoment> | null> {
	const response = await fetch(getRemoteMomentsUrl(pageNum), {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) return null;
	const payload = (await response.json()) as ApiResult<PageResult<QawkhMoment>>;
	if (payload.code !== 200 || !payload.data) return null;
	return payload.data;
}

async function fetchRemoteMoments(): Promise<DynamicData[] | null> {
	if (!remoteMomentEnabled) return null;
	try {
		const firstPage = await fetchMomentPage(1);
		if (!firstPage || !Array.isArray(firstPage.records)) return null;

		const records = [...firstPage.records];
		const total = Math.max(Number(firstPage.total) || records.length, records.length);
		const totalPages = Math.ceil(total / remoteMomentPageSize);
		for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
			const page = await fetchMomentPage(pageNum);
			if (!page || !Array.isArray(page.records)) break;
			records.push(...page.records);
		}

		const moments = await Promise.all(records.map(mapRemoteMoment));
		return moments.filter((moment): moment is DynamicData => Boolean(moment));
	} catch (error) {
		console.warn("qawkh 说说接口加载失败，继续使用本地动态。", error);
		return null;
	}
}

async function mapRemoteMoment(
	moment: QawkhMoment,
): Promise<DynamicData | null> {
	const id = normalizeText(String(moment.id ?? ""));
	if (!id) return null;

	const markdown = normalizeText(moment.contentText);
	const authorName = normalizeText(moment.authorName);
	const text = dynamicPlainTextFromMarkdown(markdown);
	const dynamic = await mapMarkdownDynamic(
		id,
		markdown,
		toPublishedTimestamp(moment.publishedAt),
		text,
		`${text} ${authorName}`.trim().toLocaleLowerCase(),
		authorName,
	);
	const apiImages = Array.isArray(moment.imageUrls)
		? moment.imageUrls.map(normalizeText).filter(Boolean)
		: [];
	dynamic.images.push(
		...apiImages.map((src, index) => ({
			alt: `Moment image ${index + 1}`,
			src,
		})),
	);
	return dynamic;
}

export async function getDynamicData(): Promise<DynamicData[]> {
	if (!import.meta.env.PROD) {
		const remoteMoments = await fetchRemoteMoments();
		return remoteMoments ?? getLocalDynamicData();
	}

	if (!dynamicDataPromise) {
		dynamicDataPromise = fetchRemoteMoments().then(
			(remoteMoments) => remoteMoments ?? getLocalDynamicData(),
		);
	}
	return dynamicDataPromise;
}
