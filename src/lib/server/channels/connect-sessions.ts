import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '$lib/server/supabase-admin';
import type { Database } from '$lib/types/database.types';
import type { Platform } from '$lib/types/domain';

export type ChannelConnectSessionStatus =
	| 'initiated'
	| 'pending_selection'
	| 'completing'
	| 'completed'
	| 'cancelled'
	| 'failed'
	| 'expired';

export interface HeadlessUserProfile {
	id?: string;
	name?: string;
	profilePicture?: string;
}

export interface EncryptedProviderPayload {
	tempToken: string;
	connectToken?: string;
	scopes?: string;
	userProfile?: HeadlessUserProfile;
}

export interface ChannelConnectSessionRecord {
	id: string;
	organizationId: string;
	userId: string;
	platform: Platform;
	targetChannelId: string | null;
	status: ChannelConnectSessionStatus;
	encryptedProviderPayload: string | null;
	connectedChannelId: string | null;
	errorCode: string | null;
	expiresAt: string;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

type DbSessionRow = Database['public']['Tables']['channel_connect_sessions']['Row'];

const DEFAULT_SESSION_TTL_MS = 10 * 60_000;
const KEY_DOMAIN_PREFIX = 'okeo-channel-connect-session-v1:';
const PAYLOAD_VERSION_PREFIX = 'v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const memorySessions = new Map<string, ChannelConnectSessionRecord>();

function isUuid(value: string | null | undefined): boolean {
	return Boolean(value && UUID_RE.test(value));
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

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(`${KEY_DOMAIN_PREFIX}${secret}`)
	);
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
}

function mapDbRow(row: DbSessionRow): ChannelConnectSessionRecord {
	return {
		id: row.id,
		organizationId: row.organization_id,
		userId: row.user_id,
		platform: row.platform as Platform,
		targetChannelId: row.target_channel_id,
		status: row.status as ChannelConnectSessionStatus,
		encryptedProviderPayload: row.encrypted_provider_payload,
		connectedChannelId: row.connected_channel_id,
		errorCode: row.error_code,
		expiresAt: row.expires_at,
		completedAt: row.completed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function generateConnectSessionId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `cs_${toBase64Url(bytes)}`;
}

export async function encryptProviderPayload(
	payload: EncryptedProviderPayload,
	secret: string
): Promise<string> {
	const key = await deriveAesGcmKey(secret);
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const plaintext = textEncoder.encode(JSON.stringify(payload));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
		key,
		plaintext
	);
	return `${PAYLOAD_VERSION_PREFIX}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptProviderPayload(
	token: string,
	secret: string
): Promise<EncryptedProviderPayload | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [version, ivB64, cipherB64] = parts;
	if (version !== PAYLOAD_VERSION_PREFIX || !ivB64 || !cipherB64) return null;

	try {
		const iv = fromBase64Url(ivB64);
		const ciphertext = fromBase64Url(cipherB64);
		if (iv.length !== 12 || ciphertext.length === 0) return null;

		const key = await deriveAesGcmKey(secret);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
			key,
			ciphertext.buffer as ArrayBuffer
		);
		const parsed = JSON.parse(textDecoder.decode(decrypted)) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record.tempToken !== 'string' || !record.tempToken.trim()) {
			return null;
		}
		const userProfile =
			record.userProfile && typeof record.userProfile === 'object' && !Array.isArray(record.userProfile)
				? sanitizeUserProfile(record.userProfile as Record<string, unknown>)
				: undefined;
		return {
			tempToken: record.tempToken,
			...(typeof record.connectToken === 'string' && record.connectToken
				? { connectToken: record.connectToken }
				: {}),
			...(typeof record.scopes === 'string' && record.scopes ? { scopes: record.scopes } : {}),
			...(userProfile ? { userProfile } : {})
		};
	} catch {
		return null;
	}
}

function sanitizeUserProfile(obj: Record<string, unknown>): HeadlessUserProfile {
	const out: HeadlessUserProfile = {};
	if (typeof obj.id === 'string' && obj.id.trim()) out.id = obj.id.trim();
	if (typeof obj.name === 'string' && obj.name.trim()) out.name = obj.name.trim();
	if (typeof obj.profilePicture === 'string' && obj.profilePicture.trim()) {
		out.profilePicture = obj.profilePicture.trim();
	}
	return out;
}

/**
 * Zernio codifica userProfile como JSON percent-encoded una vez antes de asignarlo como query param,
 * lo que produce doble percent-encoding en el cable. Soporta doble, simple y JSON directo.
 */
export function parseHeadlessUserProfile(raw: string | null | undefined): HeadlessUserProfile {
	if (!raw) return {};
	let candidate = raw.trim();
	if (!candidate) return {};

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return sanitizeUserProfile(parsed as Record<string, unknown>);
			}
			if (typeof parsed === 'string') {
				candidate = parsed;
				continue;
			}
			return {};
		} catch {
			try {
				const decoded = decodeURIComponent(candidate);
				if (decoded === candidate) break;
				candidate = decoded;
			} catch {
				break;
			}
		}
	}

	return {};
}

export function isConnectSessionExpired(
	session: Pick<ChannelConnectSessionRecord, 'status' | 'expiresAt'>,
	nowMs = Date.now()
): boolean {
	if (session.status === 'expired') return true;
	const expMs = Date.parse(session.expiresAt);
	if (!Number.isFinite(expMs)) return true;
	return nowMs > expMs;
}

function usePostgresStorage(organizationId: string, userId: string): boolean {
	return isSupabaseAdminConfigured() && isUuid(organizationId) && isUuid(userId);
}

export async function createChannelConnectSession(params: {
	organizationId: string;
	userId: string;
	platform: Platform;
	targetChannelId?: string;
	ttlMs?: number;
}): Promise<ChannelConnectSessionRecord> {
	const id = generateConnectSessionId();
	const now = new Date();
	const nowIso = now.toISOString();
	const expiresAtIso = new Date(now.getTime() + (params.ttlMs ?? DEFAULT_SESSION_TTL_MS)).toISOString();

	if (usePostgresStorage(params.organizationId, params.userId)) {
		const admin = getSupabaseAdminClient();
		if (admin) {
			const { data, error } = await admin
				.from('channel_connect_sessions')
				.insert({
					id,
					organization_id: params.organizationId,
					user_id: params.userId,
					platform: params.platform,
					target_channel_id: isUuid(params.targetChannelId) ? params.targetChannelId! : null,
					status: 'initiated',
					expires_at: expiresAtIso
				})
				.select('*')
				.single();

			if (error || !data) {
				throw new Error(error?.message ?? 'No se pudo crear la sesión de conexión');
			}
			return mapDbRow(data);
		}
	}

	const record: ChannelConnectSessionRecord = {
		id,
		organizationId: params.organizationId,
		userId: params.userId,
		platform: params.platform,
		targetChannelId: params.targetChannelId ?? null,
		status: 'initiated',
		encryptedProviderPayload: null,
		connectedChannelId: null,
		errorCode: null,
		expiresAt: expiresAtIso,
		completedAt: null,
		createdAt: nowIso,
		updatedAt: nowIso
	};
	memorySessions.set(id, record);
	return { ...record };
}

export async function getChannelConnectSession(
	sessionId: string
): Promise<ChannelConnectSessionRecord | null> {
	const mem = memorySessions.get(sessionId);
	if (mem) return { ...mem };

	if (!isSupabaseAdminConfigured()) return null;
	const admin = getSupabaseAdminClient();
	if (!admin) return null;

	const { data, error } = await admin
		.from('channel_connect_sessions')
		.select('*')
		.eq('id', sessionId)
		.maybeSingle();

	if (error || !data) return null;
	return mapDbRow(data);
}

export async function transitionSessionToPendingSelection(params: {
	sessionId: string;
	encryptedProviderPayload: string;
}): Promise<ChannelConnectSessionRecord | null> {
	const mem = memorySessions.get(params.sessionId);
	if (mem) {
		if (mem.status !== 'initiated') return null;
		const updated: ChannelConnectSessionRecord = {
			...mem,
			status: 'pending_selection',
			encryptedProviderPayload: params.encryptedProviderPayload,
			updatedAt: new Date().toISOString()
		};
		memorySessions.set(params.sessionId, updated);
		return { ...updated };
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return null;

	const { data, error } = await admin
		.from('channel_connect_sessions')
		.update({
			status: 'pending_selection',
			encrypted_provider_payload: params.encryptedProviderPayload
		})
		.eq('id', params.sessionId)
		.eq('status', 'initiated')
		.select('*')
		.maybeSingle();

	if (error || !data) return null;
	return mapDbRow(data);
}

export async function claimConnectSessionForCompletion(params: {
	sessionId: string;
	expectedStatus: 'initiated' | 'pending_selection';
}): Promise<ChannelConnectSessionRecord | null> {
	const mem = memorySessions.get(params.sessionId);
	if (mem) {
		if (mem.status !== params.expectedStatus) return null;
		const updated: ChannelConnectSessionRecord = {
			...mem,
			status: 'completing',
			updatedAt: new Date().toISOString()
		};
		memorySessions.set(params.sessionId, updated);
		return { ...updated };
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return null;

	const { data, error } = await admin
		.from('channel_connect_sessions')
		.update({
			status: 'completing'
		})
		.eq('id', params.sessionId)
		.eq('status', params.expectedStatus)
		.select('*')
		.maybeSingle();

	if (error || !data) return null;
	return mapDbRow(data);
}

export async function revertConnectSessionToPendingSelection(sessionId: string): Promise<void> {
	const mem = memorySessions.get(sessionId);
	if (mem) {
		if (mem.status === 'completing') {
			memorySessions.set(sessionId, {
				...mem,
				status: 'pending_selection',
				updatedAt: new Date().toISOString()
			});
		}
		return;
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return;

	await admin
		.from('channel_connect_sessions')
		.update({ status: 'pending_selection' })
		.eq('id', sessionId)
		.eq('status', 'completing');
}

export async function completeChannelConnectSession(params: {
	sessionId: string;
	connectedChannelId: string;
}): Promise<ChannelConnectSessionRecord | null> {
	const nowIso = new Date().toISOString();
	const mem = memorySessions.get(params.sessionId);
	if (mem) {
		if (mem.status !== 'completing' && mem.status !== 'initiated' && mem.status !== 'pending_selection') {
			return null;
		}
		const updated: ChannelConnectSessionRecord = {
			...mem,
			status: 'completed',
			connectedChannelId: params.connectedChannelId,
			encryptedProviderPayload: null,
			completedAt: nowIso,
			updatedAt: nowIso
		};
		memorySessions.set(params.sessionId, updated);
		return { ...updated };
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return null;

	const { data, error } = await admin
		.from('channel_connect_sessions')
		.update({
			status: 'completed',
			connected_channel_id: isUuid(params.connectedChannelId) ? params.connectedChannelId : null,
			encrypted_provider_payload: null,
			completed_at: nowIso
		})
		.eq('id', params.sessionId)
		.in('status', ['completing', 'initiated', 'pending_selection'])
		.select('*')
		.maybeSingle();

	if (error || !data) return null;
	return mapDbRow(data);
}

export async function failChannelConnectSession(params: {
	sessionId: string;
	errorCode: string;
}): Promise<void> {
	const mem = memorySessions.get(params.sessionId);
	if (mem) {
		if (mem.status === 'completed') return;
		memorySessions.set(params.sessionId, {
			...mem,
			status: 'failed',
			errorCode: params.errorCode,
			encryptedProviderPayload: null,
			updatedAt: new Date().toISOString()
		});
		return;
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return;

	await admin
		.from('channel_connect_sessions')
		.update({
			status: 'failed',
			error_code: params.errorCode,
			encrypted_provider_payload: null
		})
		.eq('id', params.sessionId)
		.neq('status', 'completed');
}

export async function cancelChannelConnectSession(sessionId: string): Promise<void> {
	const mem = memorySessions.get(sessionId);
	if (mem) {
		if (mem.status === 'completed') return;
		memorySessions.set(sessionId, {
			...mem,
			status: 'cancelled',
			errorCode: 'oauth_cancelled',
			encryptedProviderPayload: null,
			updatedAt: new Date().toISOString()
		});
		return;
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return;

	await admin
		.from('channel_connect_sessions')
		.update({
			status: 'cancelled',
			error_code: 'oauth_cancelled',
			encrypted_provider_payload: null
		})
		.eq('id', sessionId)
		.neq('status', 'completed');
}

export async function expireChannelConnectSession(sessionId: string): Promise<void> {
	const mem = memorySessions.get(sessionId);
	if (mem) {
		if (mem.status === 'completed') return;
		memorySessions.set(sessionId, {
			...mem,
			status: 'expired',
			errorCode: 'session_expired',
			encryptedProviderPayload: null,
			updatedAt: new Date().toISOString()
		});
		return;
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return;

	await admin
		.from('channel_connect_sessions')
		.update({
			status: 'expired',
			error_code: 'session_expired',
			encrypted_provider_payload: null
		})
		.eq('id', sessionId)
		.neq('status', 'completed');
}

export function clearMemoryConnectSessionsForTests(): void {
	memorySessions.clear();
}
