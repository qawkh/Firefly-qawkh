<script lang="ts">
import { onMount, tick } from "svelte";
import ClientPagination from "@/components/common/ClientPagination.svelte";
import { formatTimezoneOffset } from "@/utils/date-utils";
import { registerDynamicGallery } from "./dynamic-gallery";
import { registerDynamicInlineComments } from "./dynamic-inline-comments";

type DynamicImage = {
	alt: string;
	src: string;
	title?: string;
};

type DynamicData = {
	id: string;
	published: number;
	text: string;
	html: string;
	images: DynamicImage[];
	searchText: string;
	authorName?: string;
};

interface Props {
	source: string;
	fallbackSource?: string;
	itemsPerPage: number;
	showComments: boolean;
	emptyText: string;
	noResultsText: string;
	loadingText: string;
	allYearsText: string;
	timezone: string;
}

const {
	source,
	fallbackSource,
	itemsPerPage,
	showComments,
	emptyText,
	noResultsText,
	loadingText,
	allYearsText,
	timezone,
}: Props = $props();

let entries = $state<DynamicData[]>([]);
let filtered = $state<DynamicData[]>([]);
let currentPage = $state(1);
let loading = $state(true);
let failed = $state(false);
let templateReady = $state(false);
let list: HTMLElement;
let template: HTMLTemplateElement | null = null;
let searchInput: HTMLInputElement | null = null;
let yearSelect: HTMLSelectElement | null = null;
let restoreAnchorAfterRender = false;

type QawkhMoment = {
	id?: number | string;
	contentText?: string;
	imageUrls?: string[];
	authorName?: string;
	publishedAt?: string;
};

const pageEntries = $derived(
	filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
);

function pageFromUrl() {
	return Math.max(
		1,
		Number(new URL(window.location.href).searchParams.get("page")) || 1,
	);
}

function updateUrl(clearHash = false) {
	const current = new URL(window.location.href);
	if (currentPage > 1) current.searchParams.set("page", String(currentPage));
	else current.searchParams.delete("page");
	if (clearHash) current.hash = "";
	history.replaceState(history.state, "", current);
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function normalizeText(value: unknown) {
	return typeof value === "string" ? value.trim() : "";
}

function textToHtml(markdown: string) {
	return escapeHtml(markdown)
		.replace(/\r\n/g, "\n")
		.replace(/\n{2,}/g, "</p><p>")
		.replace(/\n/g, "<br>")
		.replace(/^(.+)$/s, "<p>$1</p>");
}

function toPublishedTimestamp(value: unknown) {
	const text = normalizeText(value);
	if (!text) return Date.now();
	const localDateTime = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text);
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
	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? Date.now() : timestamp;
}

function mapRemoteMoment(moment: QawkhMoment): DynamicData | null {
	const id = normalizeText(String(moment.id ?? ""));
	if (!id) return null;
	const text = normalizeText(moment.contentText);
	const authorName = normalizeText(moment.authorName);
	const images = Array.isArray(moment.imageUrls)
		? moment.imageUrls
			.map(normalizeText)
			.filter(Boolean)
			.map((src, index) => ({ alt: `Moment image ${index + 1}`, src }))
		: [];
	return {
		id,
		published: toPublishedTimestamp(moment.publishedAt),
		text,
		html: textToHtml(text),
		images,
		searchText: `${text} ${authorName}`.trim().toLocaleLowerCase(),
		...(authorName ? { authorName } : {}),
	};
}

function getRuntimeEndpoints(endpoint: string) {
	if (/^https?:\/\//i.test(endpoint)) return [endpoint];
	const hostname = window.location.hostname;
	if (hostname === "localhost" || hostname === "127.0.0.1") {
		const localBackendEndpoint = "http://localhost:8090/api/user/moments";
		return [withMomentParams(localBackendEndpoint)];
	}
	return [withMomentParams(endpoint)];
}

function withMomentParams(endpoint: string) {
	const url = new URL(endpoint, window.location.origin);
	if (!url.searchParams.has("pageNum")) url.searchParams.set("pageNum", "1");
	if (!url.searchParams.has("pageSize")) url.searchParams.set("pageSize", "100");
	return url.toString();
}

async function fetchDynamicSource(endpoint: string) {
	const response = await fetch(endpoint, { headers: { Accept: "application/json" }, cache: "no-store" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = await response.json();
	if (Array.isArray(data)) return data as DynamicData[];
	if (data?.code === 200 && Array.isArray(data.data?.records)) {
		return data.data.records
			.map(mapRemoteMoment)
			.filter((entry: DynamicData | null): entry is DynamicData => Boolean(entry));
	}
	throw new Error("Invalid dynamics payload");
}

async function loadDynamicEntries() {
	const errors: unknown[] = [];
	for (const endpoint of getRuntimeEndpoints(source)) {
		try {
			return await fetchDynamicSource(endpoint);
		} catch (error) {
			errors.push(error);
		}
	}
	if (fallbackSource) {
		try {
			return await fetchDynamicSource(fallbackSource);
		} catch (error) {
			errors.push(error);
		}
	}
	throw errors[0] ?? new Error("Failed to load dynamics");
}

function applyFilters(resetPage = true) {
	const query = searchInput?.value.toLocaleLowerCase().trim() || "";
	const year = yearSelect?.value || "all";
	filtered = entries.filter(
		(entry) =>
			(year === "all" ||
				String(new Date(entry.published).getUTCFullYear()) === year) &&
			(!query || entry.searchText.includes(query)),
	);
	if (resetPage) currentPage = 1;
	const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
	currentPage = Math.min(currentPage, totalPages);
	updateUrl(resetPage);
}

function populateYears() {
	if (!yearSelect) return;
	yearSelect.replaceChildren();
	const all = document.createElement("option");
	all.value = "all";
	all.textContent = allYearsText;
	yearSelect.append(all);
	const years = [
		...new Set(
			entries.map((entry) => new Date(entry.published).getUTCFullYear()),
		),
	];
	for (const year of years) {
		const option = document.createElement("option");
		option.value = String(year);
		option.textContent = String(year);
		yearSelect.append(option);
	}
}

function createItem(entry: DynamicData) {
	if (!template) return null;
	const fragment = template.content.cloneNode(true) as DocumentFragment;
	const root = fragment.querySelector<HTMLElement>("[data-dynamic-entry]");
	if (!root) return null;
	const anchorId = `dynamic-${entry.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
	const permalinkUrl = new URL(window.location.href);
	permalinkUrl.hash = anchorId;
	const permalink = `${permalinkUrl.pathname}${permalinkUrl.search}${permalinkUrl.hash}`;
	root.id = anchorId;
	root.dataset.year = String(new Date(entry.published).getUTCFullYear());

	const author = root.querySelector<HTMLElement>("[data-dynamic-author]");
	if (author) {
		author.id = `${anchorId}-author`;
		if (entry.authorName) author.textContent = entry.authorName;
		root.querySelector("article")?.setAttribute("aria-labelledby", author.id);
	}
	root
		.querySelectorAll<HTMLAnchorElement>("[data-dynamic-permalink]")
		.forEach((link) => {
			link.href = permalink;
			link.dataset.noSwup = "";
			link.addEventListener("click", (event) => {
				if (
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				history.replaceState(history.state, "", permalink);
			});
		});
	const time = root.querySelector<HTMLTimeElement>("[data-dynamic-time]");
	if (time) {
		const date = new Date(entry.published);
		time.dateTime = date.toISOString();
		time.textContent = new Intl.DateTimeFormat(
			document.documentElement.lang || undefined,
			{
				timeZone: "UTC",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			},
		).format(date);
		time.textContent += ` ${formatTimezoneOffset(timezone, date)}`;
	}

	const content = root.querySelector<HTMLElement>("[data-dynamic-content]");
	if (content) {
		content.id = `${anchorId}-content`;
		content.innerHTML = entry.html;
		for (const image of entry.images) {
			const element = document.createElement("img");
			element.src = image.src;
			element.alt = image.alt;
			element.loading = "lazy";
			if (image.title) element.title = image.title;
			content.append(element);
		}
		const gallery = root.querySelector<HTMLElement>("dynamic-gallery");
		if (gallery) gallery.dataset.sourceId = content.id;
	}

	const comments = root.querySelector<HTMLElement>("dynamic-inline-comments");
	if (comments) {
		if (showComments) {
			comments.dataset.src = `/dynamic/comments/?path=${encodeURIComponent(
				`/dynamic/${entry.id}/`,
			)}`;
		} else {
			comments.remove();
		}
	}
	return fragment;
}

async function renderItems(items: DynamicData[]) {
	await tick();
	if (!list || !template) return;
	list.replaceChildren();
	for (const entry of items) {
		const item = createItem(entry);
		if (item) list.append(item);
	}
	if (restoreAnchorAfterRender) {
		restoreAnchorAfterRender = false;
		const target = document.getElementById(
			decodeURIComponent(window.location.hash.slice(1)),
		);
		target?.scrollIntoView({ behavior: "auto", block: "start" });
	}
}

function goToPage(page: number) {
	currentPage = page;
	updateUrl(true);
	document
		.querySelector(".dynamic-page")
		?.scrollIntoView({ behavior: "smooth", block: "start" });
}

$effect(() => {
	if (!templateReady) return;
	renderItems(pageEntries);
});

onMount(() => {
	registerDynamicGallery();
	registerDynamicInlineComments();
	const page = list.closest(".dynamic-page");
	template =
		page?.querySelector<HTMLTemplateElement>("[data-dynamic-item-template]") ??
		null;
	templateReady = template !== null;
	searchInput =
		page?.querySelector<HTMLInputElement>("[data-dynamic-search]") ?? null;
	yearSelect =
		page?.querySelector<HTMLSelectElement>("[data-year-select]") ?? null;
	const filter = () => applyFilters();
	searchInput?.addEventListener("input", filter);
	yearSelect?.addEventListener("change", filter);

	const load = async () => {
		try {
			entries = await loadDynamicEntries();
			document.querySelector("[data-dynamic-count-value]")?.replaceChildren(String(entries.length));
			populateYears();
			currentPage = pageFromUrl();
			applyFilters(false);
			const anchorId = decodeURIComponent(window.location.hash.slice(1));
			if (anchorId) {
				const anchorIndex = filtered.findIndex(
					(entry) =>
						`dynamic-${entry.id.replace(/[^a-zA-Z0-9_-]/g, "-")}` === anchorId,
				);
				if (anchorIndex >= 0) {
					currentPage = Math.floor(anchorIndex / itemsPerPage) + 1;
					updateUrl();
					restoreAnchorAfterRender = true;
				}
			}
		} catch (error) {
			console.error("Failed to load dynamics", error);
			failed = true;
		} finally {
			loading = false;
		}
	};
	void load();

	return () => {
		searchInput?.removeEventListener("input", filter);
		yearSelect?.removeEventListener("change", filter);
	};
});
</script>

{#if loading}
	<div class="dynamic-loading card-base" role="status">
		<span class="dynamic-loading-spinner" aria-hidden="true"></span>
		<p>{loadingText}</p>
	</div>
{:else if failed || entries.length === 0}
	<div class="dynamic-empty card-base">
		<p>{emptyText}</p>
	</div>
{:else if filtered.length === 0}
	<div class="dynamic-no-results card-base">
		<p>{noResultsText}</p>
	</div>
{/if}

<div class="dynamic-feed" bind:this={list}></div>

{#if !loading && !failed}
	<ClientPagination
		totalItems={filtered.length}
		{itemsPerPage}
		{currentPage}
		onPageChange={goToPage}
	/>
{/if}
