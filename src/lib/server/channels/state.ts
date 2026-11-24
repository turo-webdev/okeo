import { env } from '$env/dynamic/private';

export interface OAuthStatePayload {
	organizationId: string;
	userId: string;
	platform: 'whatsapp' | 'instagram' | 'facebook';
	channelId?: string;
	nonce: string;
	exp: number;
}

const encoder = new TextEncoder();
const DEV_FALLBACK_STATE_SECRET = 'okeo-dev-oauth-secret';

export function getOAuthStateSecret(): string {
	const configured = env.OAUTH_STATE_SECRET?.trim();
	if (configured) return configured;
	if (env.ZERNIO_API_KEY?.trim()) {
		throw new Error('OAUTH_STATE_SECRET debe estar configurado en .env cuando ZERNIO_API_KEY está activo');
	}
	return DEV_FALLBACK_STATE_SECRET;
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padLen = (4 - (normalized.length % 4)) % 4;
	const padded = normalized + '='.repeat(padLen);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
}

export async function signOAuthState(payload: OAuthStatePayload, secret: string): Promise<string> {
	const data = toBase64Url(encoder.encode(JSON.stringify(payload)));
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
	return `${data}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyOAuthState(
	token: string,
	secret: string
): Promise<OAuthStatePayload | null> {
	const parts = token.split('.');
	if (parts.length !== 2) return null;
	const [data, signature] = parts;
	if (!data || !signature) return null;

	try {
		const key = await importHmacKey(secret);
		const sigBytes = fromBase64Url(signature);
		const valid = await crypto.subtle.verify(
			'HMAC',
			key,
			sigBytes.buffer as ArrayBuffer,
			encoder.encode(data)
		);
		if (!valid) return null;

		const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(data))) as OAuthStatePayload;
		if (Date.now() > parsed.exp) return null;
		return parsed;
	} catch {
		return null;
	}
}
