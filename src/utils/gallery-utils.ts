import fs from "node:fs";
import path from "node:path";
import { galleryConfig } from "@/config/galleryConfig";
import type { GalleryAlbum } from "@/types/config";
import { url } from "@/utils/url-utils";

type ApiResult<T> = {
	code?: number;
	message?: string;
	data?: T;
};

type QawkhPhotoWallCategory = {
	id?: number | string;
	name?: string;
	previewImages?: string[];
	photoCount?: number | string;
	updatedAt?: string;
};

type QawkhPhotoWallPhoto = {
	id?: number | string;
	imageUrl?: string;
	sortOrder?: number;
};

type QawkhPhotoWallCategoryDetail = {
	id?: number | string;
	name?: string;
	photoCount?: number | string;
	updatedAt?: string;
	photos?: QawkhPhotoWallPhoto[];
};

export type GalleryAlbumForPage = GalleryAlbum & {
	cover: string;
	photoCount: number;
	source: "local" | "remote";
	remoteId?: string;
};

export type GalleryAlbumDetail = GalleryAlbumForPage & {
	photos: string[];
};

const remotePhotoWallEnabled =
	import.meta.env.PUBLIC_QAWKH_PHOTO_WALL_ENABLED !== "false";
const remoteApiBase =
	import.meta.env.QAWKH_API_BASE ||
	import.meta.env.PUBLIC_QAWKH_API_BASE ||
	"http://localhost:8090";
const remotePhotoWallEndpoint =
	import.meta.env.QAWKH_PHOTO_WALL_ENDPOINT ||
	import.meta.env.PUBLIC_QAWKH_PHOTO_WALL_ENDPOINT ||
	"/api/user/photo-wall-categories";

let remotePhotoWallAlbumsPromise: Promise<GalleryAlbumForPage[] | null> | null =
	null;
const remotePhotoWallDetailCache = new Map<
	string,
	Promise<QawkhPhotoWallCategoryDetail | null>
>();

function withBase(assetPath: string): string {
	if (!assetPath) return "";
	if (/^(https?:)?\/\//i.test(assetPath) || /^(data|blob):/i.test(assetPath)) {
		return assetPath;
	}
	const normalizedPath = assetPath.startsWith("/")
		? assetPath
		: `/${assetPath}`;
	const base = import.meta.env.BASE_URL || "/";
	if (base !== "/" && normalizedPath.startsWith(base)) {
		return normalizedPath;
	}
	return url(normalizedPath);
}

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function toAbsoluteApiUrl(endpoint: string): string {
	if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
		return endpoint;
	}
	return `${remoteApiBase.replace(/\/$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function getRemotePhotoWallUrl(id?: string): string {
	const base = toAbsoluteApiUrl(remotePhotoWallEndpoint).replace(/\/$/, "");
	return id ? `${base}/${encodeURIComponent(id)}` : base;
}

function normalizeCount(value: unknown): number {
	const count = Number(value);
	return Number.isFinite(count) && count > 0 ? count : 0;
}

function toDateText(value: unknown): string | undefined {
	const text = normalizeText(value);
	if (!text) return undefined;
	const dateText = text.includes("T") ? text.split("T")[0] : text.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : undefined;
}

function getRemoteAlbumId(id: unknown): string {
	return `photo-wall-${String(id)}`;
}

function mapRemoteAlbum(
	category: QawkhPhotoWallCategory,
): GalleryAlbumForPage | null {
	const remoteId = normalizeText(String(category.id ?? ""));
	const name = normalizeText(category.name);
	if (!remoteId || !name) return null;

	const previewImages = Array.isArray(category.previewImages)
		? category.previewImages.map(normalizeText).filter(Boolean)
		: [];

	return {
		id: getRemoteAlbumId(remoteId),
		remoteId,
		source: "remote",
		name,
		cover: previewImages[0] || "",
		photoCount: normalizeCount(category.photoCount),
		date: toDateText(category.updatedAt),
		tags: ["照片墙"],
	};
}

function mapLocalAlbum(album: GalleryAlbum): GalleryAlbumForPage {
	const photos = scanAlbumPhotos(album.id);
	const cover = getAlbumCover(album, photos);
	return { ...album, cover, photoCount: photos.length, source: "local" };
}

async function fetchRemotePhotoWallAlbums(): Promise<
	GalleryAlbumForPage[] | null
> {
	if (!remotePhotoWallEnabled) return null;
	if (!remotePhotoWallAlbumsPromise) {
		remotePhotoWallAlbumsPromise = fetch(getRemotePhotoWallUrl(), {
			headers: { Accept: "application/json" },
		})
			.then(async (response) => {
				if (!response.ok) return null;
				const payload =
					(await response.json()) as ApiResult<QawkhPhotoWallCategory[]>;
				if (payload.code !== 200 || !Array.isArray(payload.data)) return null;
				return payload.data
					.map(mapRemoteAlbum)
					.filter((album): album is GalleryAlbumForPage => Boolean(album));
			})
			.catch((error) => {
				console.warn("qawkh 照片墙接口加载失败，继续使用本地相册。", error);
				return null;
			});
	}
	return remotePhotoWallAlbumsPromise;
}

async function fetchRemotePhotoWallDetail(
	remoteId: string,
): Promise<QawkhPhotoWallCategoryDetail | null> {
	if (!remotePhotoWallEnabled) return null;
	if (!remotePhotoWallDetailCache.has(remoteId)) {
		remotePhotoWallDetailCache.set(
			remoteId,
			fetch(getRemotePhotoWallUrl(remoteId), {
				headers: { Accept: "application/json" },
			})
				.then(async (response) => {
					if (!response.ok) return null;
					const payload =
						(await response.json()) as ApiResult<QawkhPhotoWallCategoryDetail>;
					if (payload.code !== 200 || !payload.data) return null;
					return payload.data;
				})
				.catch((error) => {
					console.warn(`qawkh 照片墙详情加载失败：${remoteId}`, error);
					return null;
				}),
		);
	}
	return remotePhotoWallDetailCache.get(remoteId) ?? null;
}

/**
 * 扫描相册目录中的所有图片文件
 */
export function scanAlbumPhotos(albumId: string): string[] {
	const dir = path.join(process.cwd(), "public", "gallery", albumId);
	if (!fs.existsSync(dir)) return [];
	const files = fs
		.readdirSync(dir)
		.filter((f) => /\.(jpe?g|png|webp|avif|gif)$/i.test(f))
		.sort();
	// 将 cover.* 排到第一位
	const coverIdx = files.findIndex((f) => /^cover\./i.test(f));
	if (coverIdx > 0) {
		const [coverFile] = files.splice(coverIdx, 1);
		files.unshift(coverFile);
	}
	const localPhotos = files.map((f) => withBase(`/gallery/${albumId}/${f}`));

	// 读取 urls.txt 中的远程图片 URL
	const urlsFile = path.join(dir, "urls.txt");
	let remotePhotos: string[] = [];
	if (fs.existsSync(urlsFile)) {
		remotePhotos = fs
			.readFileSync(urlsFile, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
	}

	return [...localPhotos, ...remotePhotos];
}

/**
 * 获取相册封面图
 * 优先级：手动指定 > cover.* 文件 > 第一张图片
 */
export function getAlbumCover(album: GalleryAlbum, photos: string[]): string {
	if (album.cover) return withBase(album.cover);
	const coverFile = photos.find((p) => /\/cover\./i.test(p));
	return coverFile || photos[0] || "";
}

export async function getGalleryAlbums(): Promise<GalleryAlbumForPage[]> {
	const remoteAlbums = await fetchRemotePhotoWallAlbums();
	if (remoteAlbums) return remoteAlbums;
	return galleryConfig.albums.map(mapLocalAlbum);
}

export async function getGalleryAlbumDetail(
	albumId: string | undefined,
): Promise<GalleryAlbumDetail | null> {
	if (!albumId) return null;
	const album = (await getGalleryAlbums()).find((item) => item.id === albumId);
	if (!album) return null;

	if (album.source === "remote" && album.remoteId) {
		const detail = await fetchRemotePhotoWallDetail(album.remoteId);
		const photos = detail?.photos
			? detail.photos
				.slice()
				.sort((a, b) => {
					const sortA = Number(a.sortOrder ?? 0);
					const sortB = Number(b.sortOrder ?? 0);
					if (sortA !== sortB) return sortA - sortB;
					return Number(b.id ?? 0) - Number(a.id ?? 0);
				})
				.map((photo) => normalizeText(photo.imageUrl))
				.filter(Boolean)
			: [];

		return {
			...album,
			name: normalizeText(detail?.name) || album.name,
			photoCount: detail ? normalizeCount(detail.photoCount) : album.photoCount,
			date: toDateText(detail?.updatedAt) || album.date,
			cover: photos[0] || album.cover,
			photos,
		};
	}

	const photos = scanAlbumPhotos(album.id);
	return {
		...album,
		cover: getAlbumCover(album, photos),
		photoCount: photos.length,
		photos,
	};
}
