import { commentConfig } from "@/config/commentConfig";
import type { CommentConfig } from "@/types/commentConfig";

type ApiResult<T> = {
	code?: number;
	message?: string;
	data?: T;
};

type QawkhGuestbookSettings = {
	serverUrl?: string | null;
	loginMode?: string | null;
};

const remoteCommentSettingsEnabled =
	import.meta.env.PUBLIC_QAWKH_COMMENT_SETTINGS_ENABLED !== "false";
const remoteApiBase =
	import.meta.env.QAWKH_API_BASE ||
	import.meta.env.PUBLIC_QAWKH_API_BASE ||
	"http://localhost:8090";
const remoteCommentSettingsEndpoint =
	import.meta.env.QAWKH_COMMENT_SETTINGS_ENDPOINT ||
	import.meta.env.PUBLIC_QAWKH_COMMENT_SETTINGS_ENDPOINT ||
	"/api/user/guestbook-settings";
const publicRemoteApiBase = import.meta.env.PUBLIC_QAWKH_API_BASE || "";

let resolvedCommentConfigPromise: Promise<CommentConfig> | null = null;

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeLoginMode(value: unknown): "enable" | "force" | "disable" {
	if (value === "force" || value === "disable") return value;
	return "enable";
}

function toAbsoluteApiUrl(endpoint: string): string {
	if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
		return endpoint;
	}
	return `${remoteApiBase.replace(/\/$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

export function isRemoteCommentSettingsEnabled(): boolean {
	return remoteCommentSettingsEnabled;
}

export function canResolveCommentAtRuntime(config: CommentConfig): boolean {
	return isCommentEnabled(config) || remoteCommentSettingsEnabled;
}

export function getBrowserCommentSettingsEndpoint(): string {
	if (
		remoteCommentSettingsEndpoint.startsWith("http://") ||
		remoteCommentSettingsEndpoint.startsWith("https://")
	) {
		return remoteCommentSettingsEndpoint;
	}
	if (publicRemoteApiBase) {
		return `${publicRemoteApiBase.replace(/\/$/, "")}/${remoteCommentSettingsEndpoint.replace(/^\/+/, "")}`;
	}
	return remoteCommentSettingsEndpoint;
}

export function shouldShowWalineVisitorCount(config: CommentConfig): boolean {
	return Boolean(
		(config.type === "waline" && config.waline?.visitorCount) ||
			(config.type === "none" &&
				remoteCommentSettingsEnabled &&
				commentConfig.waline?.visitorCount),
	);
}

async function fetchQawkhCommentConfig(): Promise<CommentConfig | null> {
	if (!remoteCommentSettingsEnabled) return null;
	try {
		const response = await fetch(toAbsoluteApiUrl(remoteCommentSettingsEndpoint), {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return null;

		const payload =
			(await response.json()) as ApiResult<QawkhGuestbookSettings>;
		if (payload.code !== 200 || !payload.data) return null;

		const serverURL = normalizeText(payload.data.serverUrl);
		if (!serverURL) return null;

		return {
			...commentConfig,
			type: "waline",
			waline: {
				...commentConfig.waline,
				serverURL,
				login: normalizeLoginMode(payload.data.loginMode),
				emoji: commentConfig.waline?.emoji || [],
			},
		};
	} catch (error) {
		console.warn("qawkh 评论配置加载失败，继续使用本地评论配置。", error);
		return null;
	}
}

export async function getResolvedCommentConfig(): Promise<CommentConfig> {
	if (!import.meta.env.PROD) {
		return (await fetchQawkhCommentConfig()) ?? commentConfig;
	}

	if (!resolvedCommentConfigPromise) {
		resolvedCommentConfigPromise = fetchQawkhCommentConfig().then(
			(remoteConfig) => remoteConfig ?? commentConfig,
		);
	}
	return resolvedCommentConfigPromise;
}

export function isCommentEnabled(config: CommentConfig): boolean {
	return Boolean(config.type && config.type !== "none");
}
