import { validateSafeExternalUrl } from '$lib/server/ai/rag';
import type { MessageAttachment } from '$lib/types/domain';
import { getSupabaseAdminClient } from './supabase-admin';

export type StorageBucket = 'dm-media' | 'knowledge-files';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function uint8ToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const slice = bytes.subarray(i, Math.min(bytes.length, i + CHUNK));
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

export function sanitizeStorageFileName(fileName: string, fallback = 'archivo.bin'): string {
	const base = fileName.split(/[\\/]/).pop()?.trim() ?? '';
	const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 80);
	return clean || fallback;
}

function defaultMimeForKind(kind: MessageAttachment['kind']): string {
	if (kind === 'audio') return 'audio/ogg';
	if (kind === 'image') return 'image/jpeg';
	return 'application/octet-stream';
}

function extensionForMime(mimeType: string, kind: MessageAttachment['kind']): string {
	const lower = mimeType.toLowerCase();
	if (lower.includes('ogg')) return 'ogg';
	if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
	if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a';
	if (lower.includes('wav')) return 'wav';
	if (lower.includes('png')) return 'png';
	if (lower.includes('webp')) return 'webp';
	if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
	if (lower.includes('pdf')) return 'pdf';
	if (kind === 'audio') return 'ogg';
	if (kind === 'image') return 'jpg';
	return 'bin';
}

/**
 * Capa de almacenamiento privado (buckets `dm-media` y `knowledge-files`).
 * Toda ruta debe comenzar con `{organizationId}/...` y servirse vía Signed URLs.
 */
export function isPathOwnedByOrganization(storagePath: string, organizationId: string): boolean {
	const normalized = storagePath.trim();
	return (
		Boolean(organizationId) &&
		normalized.startsWith(`${organizationId}/`) &&
		!normalized.includes('..') &&
		!normalized.includes('\\')
	);
}

export async function createSignedStorageUrl(params: {
	organizationId: string;
	storagePath: string;
	bucket?: StorageBucket;
	expiresInSeconds?: number;
}): Promise<{ signedUrl: string; expiresInSeconds: number; mode: 'supabase' | 'mock' } | null> {
	if (!isPathOwnedByOrganization(params.storagePath, params.organizationId)) {
		return null;
	}

	const expires = Math.min(Math.max(params.expiresInSeconds ?? 300, 60), 900);
	const bucket: StorageBucket = params.bucket ?? 'dm-media';
	const admin = getSupabaseAdminClient();

	if (admin) {
		const { data, error } = await admin.storage
			.from(bucket)
			.createSignedUrl(params.storagePath, expires);
		if (error || !data?.signedUrl) {
			throw new Error(error?.message ?? 'No se pudo generar la Signed URL en Storage');
		}
		return {
			signedUrl: data.signedUrl,
			expiresInSeconds: expires,
			mode: 'supabase'
		};
	}

	return {
		signedUrl: `/api/media/mock?path=${encodeURIComponent(params.storagePath)}`,
		expiresInSeconds: expires,
		mode: 'mock'
	};
}

/**
 * Descarga adjuntos entrantes desde URLs temporales externas (validadas contra SSRF)
 * y los espeja en el bucket privado `dm-media` bajo `{organization_id}/...`.
 */
export async function mirrorExternalMediaToPrivateStorage(params: {
	organizationId: string;
	conversationId: string;
	messageId: number;
	sourceUrl: string;
	mimeType?: string;
	fileName?: string;
	kind: MessageAttachment['kind'];
}): Promise<{ attachment: MessageAttachment; base64Data: string } | null> {
	const urlCheck = validateSafeExternalUrl(params.sourceUrl);
	if (!urlCheck.ok) {
		console.warn('[storage] URL externa rechazada por anti-SSRF:', urlCheck.reason);
		return null;
	}

	try {
		const res = await fetch(urlCheck.url.toString(), {
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) {
			console.warn('[storage] Error HTTP al descargar adjunto entrante:', res.status);
			return null;
		}

		const contentLen = Number(res.headers.get('content-length') ?? 0);
		if (Number.isFinite(contentLen) && contentLen > MAX_UPLOAD_BYTES) {
			console.warn('[storage] Adjunto entrante excede el límite de 10 MB');
			return null;
		}

		const buf = await res.arrayBuffer();
		if (buf.byteLength === 0 || buf.byteLength > MAX_UPLOAD_BYTES) {
			return null;
		}

		const bytes = new Uint8Array(buf);
		const mimeType =
			params.mimeType?.trim() ||
			res.headers.get('content-type')?.split(';')[0]?.trim() ||
			defaultMimeForKind(params.kind);

		const ext = extensionForMime(mimeType, params.kind);
		const rawName = params.fileName?.trim() || `media-${params.messageId}.${ext}`;
		const safeName = sanitizeStorageFileName(rawName, `file.${ext}`);
		const storagePath = `${params.organizationId}/${params.conversationId}/${params.messageId}-${safeName}`;

		const admin = getSupabaseAdminClient();
		if (admin) {
			const { error } = await admin.storage
				.from('dm-media')
				.upload(storagePath, bytes, { contentType: mimeType, upsert: true });
			if (error) {
				console.warn('[storage] Error subiendo adjunto a dm-media:', error.message);
				return null;
			}
		}

		return {
			attachment: {
				storage_path: storagePath,
				mime_type: mimeType,
				file_name: safeName,
				size_bytes: bytes.byteLength,
				kind: params.kind
			},
			base64Data: uint8ToBase64(bytes)
		};
	} catch (err) {
		console.warn(
			'[storage] No se pudo espejar media entrante a Storage privado:',
			err instanceof Error ? err.message : err
		);
		return null;
	}
}

export async function uploadPrivateStorageFile(params: {
	organizationId: string;
	resourceId: string;
	fileName: string;
	bytes: Uint8Array;
	mimeType: string;
	bucket: StorageBucket;
}): Promise<{ storagePath: string; fileName: string; sizeBytes: number }> {
	if (params.bytes.byteLength === 0) {
		throw new Error('El archivo seleccionado está vacío.');
	}
	if (params.bytes.byteLength > MAX_UPLOAD_BYTES) {
		throw new Error('El archivo excede el límite máximo de 10 MB.');
	}

	const safeName = sanitizeStorageFileName(params.fileName);
	const cleanResource = params.resourceId.replace(/[^a-zA-Z0-9._-]+/g, '') || crypto.randomUUID();
	const storagePath = `${params.organizationId}/${cleanResource}/${safeName}`;

	const admin = getSupabaseAdminClient();
	if (admin) {
		const { error } = await admin.storage
			.from(params.bucket)
			.upload(storagePath, params.bytes, {
				contentType: params.mimeType || 'application/octet-stream',
				upsert: true
			});
		if (error) {
			throw new Error(`No se pudo guardar el archivo en Storage: ${error.message}`);
		}
	}

	return {
		storagePath,
		fileName: safeName,
		sizeBytes: params.bytes.byteLength
	};
}

export async function deletePrivateStorageFile(
	organizationId: string,
	storagePath: string,
	bucket: StorageBucket
): Promise<void> {
	if (!isPathOwnedByOrganization(storagePath, organizationId)) return;
	const admin = getSupabaseAdminClient();
	if (!admin) return;

	try {
		const { error } = await admin.storage.from(bucket).remove([storagePath]);
		if (error) {
			console.warn('[storage] Error eliminando archivo en Storage:', error.message);
		}
	} catch (err) {
		console.warn('[storage] Fallo eliminando archivo en Storage:', err);
	}
}

export async function downloadPrivateMediaAsBase64(
	organizationId: string,
	storagePath: string,
	bucket: StorageBucket = 'dm-media'
): Promise<string | null> {
	if (!isPathOwnedByOrganization(storagePath, organizationId)) return null;
	const admin = getSupabaseAdminClient();
	if (!admin) return null;

	try {
		const { data, error } = await admin.storage.from(bucket).download(storagePath);
		if (error || !data) return null;
		const buf = await data.arrayBuffer();
		if (buf.byteLength === 0 || buf.byteLength > MAX_UPLOAD_BYTES) return null;
		return uint8ToBase64(new Uint8Array(buf));
	} catch {
		return null;
	}
}
