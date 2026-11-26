import { env } from '$env/dynamic/private';
import type { Platform } from '$lib/types/domain';

export const OKEO_CONNECT_BRANDING = {
	brandName: 'Okeo',
	primaryColor: '#20211e',
	accentColor: '#3b6342',
	pageColor: '#f8f8f5',
	cardColor: '#ffffff',
	textColor: '#1c1c1a',
	cornerRadius: 12,
	language: 'es'
} as const;

export interface ChannelConnectOptions {
	headless: boolean;
	oauthAppId?: string;
	signupHosted: boolean;
	brandName?: string;
	primaryColor?: string;
	language?: 'es' | 'en' | 'pt-BR';
}

function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return defaultValue;
	if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
	if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
	return defaultValue;
}

export function isFacebookHeadlessEnabled(): boolean {
	return parseBoolEnv(env.CHANNEL_HEADLESS_FACEBOOK, true);
}

export function isWhatsAppHostedSignupEnabled(): boolean {
	return parseBoolEnv(env.CHANNEL_WHATSAPP_HOSTED_SIGNUP, true);
}

export function getConfiguredOAuthAppId(platform: Platform): string | undefined {
	if (platform === 'facebook') {
		return env.ZERNIO_FACEBOOK_OAUTH_APP_ID?.trim() || undefined;
	}
	if (platform === 'instagram') {
		return env.ZERNIO_INSTAGRAM_OAUTH_APP_ID?.trim() || undefined;
	}
	return undefined;
}

/**
 * Configuracion por canal mantenida exclusivamente dentro de src/lib/server/channels/ (AGENTS.md §4).
 * Respeta las restricciones del proveedor: nunca mezcla brandName/signupHosted con headless=true.
 */
export function getChannelConnectOptions(platform: Platform): ChannelConnectOptions {
	if (platform === 'facebook') {
		return {
			headless: isFacebookHeadlessEnabled(),
			oauthAppId: getConfiguredOAuthAppId('facebook'),
			signupHosted: false
		};
	}

	if (platform === 'instagram') {
		return {
			headless: false,
			oauthAppId: getConfiguredOAuthAppId('instagram'),
			signupHosted: false
		};
	}

	const signupHosted = isWhatsAppHostedSignupEnabled();
	if (signupHosted) {
		return {
			headless: false,
			oauthAppId: undefined,
			signupHosted: true,
			brandName: OKEO_CONNECT_BRANDING.brandName,
			primaryColor: OKEO_CONNECT_BRANDING.primaryColor,
			language: OKEO_CONNECT_BRANDING.language
		};
	}

	return {
		headless: false,
		oauthAppId: undefined,
		signupHosted: false
	};
}
