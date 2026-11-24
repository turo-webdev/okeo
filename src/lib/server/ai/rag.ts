import { getSupabaseAdminClient } from '$lib/server/supabase-admin';
import type { KnowledgeDocument } from '$lib/types/domain';
import { generateTextEmbedding } from './client';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validación anti-SSRF antes de descargar URLs de Base de Conocimiento o media externa (AGENTS.md §5).
 */
export function validateSafeExternalUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
	} catch {
		return { ok: false, reason: 'La URL no tiene un formato válido.' };
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return { ok: false, reason: 'Solo se permiten URLs http o https públicas.' };
	}

	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		BLOCKED_HOSTS.has(host) ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^127\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^fc00:/i.test(host) ||
		/^fd[0-9a-f]{2}:/i.test(host) ||
		/^fe80:/i.test(host)
	) {
		return { ok: false, reason: 'Por seguridad no se permiten direcciones privadas o locales.' };
	}

	return { ok: true, url: parsed };
}

const MAX_KB_URL_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_KB_EXTRACTED_CHARS = 24_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_match, dec) => {
			const code = Number(dec);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: ' ';
		})
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
			const code = Number.parseInt(hex, 16);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: ' ';
		});
}

/**
 * Convierte HTML público en texto plano limpio para chunking/embeddings, sin dependencias de Node (CF Workers).
 */
export function extractTextFromHtml(html: string): { title: string | null; text: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const rawTitle = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')).trim() : '';
	const title = rawTitle.replace(/\s+/g, ' ').slice(0, 140) || null;

	const withoutNoise = html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|svg|iframe|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

	const withBreaks = withoutNoise
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|header)>/gi, '\n')
		.replace(/<td\b[^>]*>/gi, ' · ');

	const plain = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ' '))
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
		.slice(0, MAX_KB_EXTRACTED_CHARS);

	return { title, text: plain };
}

/**
 * Descarga una URL pública validando cada salto de redirección contra SSRF (AGENTS.md §5).
 */
export async function fetchAndExtractPublicUrl(
	rawUrl: string,
	customFetch: typeof fetch = fetch
): Promise<{ finalUrl: string; title: string | null; text: string }> {
	const initialCheck = validateSafeExternalUrl(rawUrl);
	if (!initialCheck.ok) {
		throw new Error(initialCheck.reason);
	}

	let currentUrl = initialCheck.url;
	let response: Response | null = null;

	for (let hop = 0; hop <= 3; hop++) {
		const res = await customFetch(currentUrl.toString(), {
			method: 'GET',
			redirect: 'manual',
			headers: {
				'User-Agent': 'OkeoKnowledgeBot/1.0 (+https://okeo.ai)',
				Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5'
			},
			signal: AbortSignal.timeout(10_000)
		});

		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get('location')?.trim();
			if (!location) {
				throw new Error('La URL devolvió una redirección sin destino válido.');
			}
			let nextTarget: URL;
			try {
				nextTarget = new URL(location, currentUrl);
			} catch {
				throw new Error('La URL redirigió a una dirección inválida.');
			}
			const nextCheck = validateSafeExternalUrl(nextTarget.toString());
			if (!nextCheck.ok) {
				throw new Error(nextCheck.reason);
			}
			currentUrl = nextCheck.url;
			continue;
		}

		response = res;
		break;
	}

	if (!response) {
		throw new Error('La URL excedió el máximo de redirecciones permitidas.');
	}
	if (!response.ok) {
		throw new Error(`No pudimos leer la URL (HTTP ${response.status}).`);
	}

	const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'text/html';
	const isHtml = contentType === '' || contentType.includes('html') || contentType.includes('xhtml');
	const isPlain = contentType.startsWith('text/plain') || contentType.startsWith('text/markdown');
	if (!isHtml && !isPlain) {
		throw new Error(`Tipo de contenido no soportado para URL (${contentType}). Sube un PDF si es un documento.`);
	}

	const contentLen = Number(response.headers.get('content-length') ?? 0);
	if (Number.isFinite(contentLen) && contentLen > MAX_KB_URL_BYTES) {
		throw new Error('La página excede el tamaño máximo permitido (2 MB).');
	}

	const buf = await response.arrayBuffer();
	if (buf.byteLength > MAX_KB_URL_BYTES) {
		throw new Error('La página excede el tamaño máximo permitido (2 MB).');
	}

	const rawText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf));
	const extracted = isHtml
		? extractTextFromHtml(rawText)
		: { title: null, text: rawText.trim().slice(0, MAX_KB_EXTRACTED_CHARS) };

	if (extracted.text.length < 20) {
		throw new Error('No se encontró texto legible suficiente en la URL proporcionada.');
	}

	return {
		finalUrl: currentUrl.toString(),
		title: extracted.title,
		text: extracted.text
	};
}

export function selectRelevantKnowledge(
	docs: KnowledgeDocument[],
	query: string,
	limit = 5
): KnowledgeDocument[] {
	const ready = docs.filter((d) => d.status === 'ready');
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 2);

	return ready
		.map((doc) => {
			const hay = `${doc.title} ${doc.content_preview ?? ''}`.toLowerCase();
			const score = tokens.reduce((acc, tok) => (hay.includes(tok) ? acc + 1 : acc), 0);
			return { doc, score };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => x.doc);
}

/**
 * Divide un documento largo en chunks con solapamiento ligero para indexación híbrida (fts + pgvector).
 */
export function chunkKnowledgeText(text: string, maxChars = 1200, overlap = 150): string[] {
	const clean = text.replace(/\r\n/g, '\n').trim();
	if (!clean) return [];
	if (clean.length <= maxChars) return [clean];

	const safeOverlap = Math.min(Math.max(0, overlap), Math.floor(maxChars / 2));
	const chunks: string[] = [];
	let cursor = 0;

	while (cursor < clean.length) {
		const rawEnd = Math.min(clean.length, cursor + maxChars);
		let end = rawEnd;

		if (rawEnd < clean.length) {
			const breakWindow = clean.slice(cursor + Math.floor(maxChars * 0.6), rawEnd);
			const lastBreak = Math.max(
				breakWindow.lastIndexOf('\n'),
				breakWindow.lastIndexOf('. '),
				breakWindow.lastIndexOf(' ')
			);
			if (lastBreak > 0) {
				end = cursor + Math.floor(maxChars * 0.6) + lastBreak + 1;
			}
		}

		const slice = clean.slice(cursor, end).trim();
		if (slice) chunks.push(slice);
		if (end >= clean.length) break;

		const nextCursor = Math.max(cursor + 1, end - safeOverlap);
		cursor = nextCursor;
	}

	return chunks;
}

export function formatPgVector(values: number[]): string {
	return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

export interface KnowledgeSearchHit {
	documentId: string;
	title: string;
	content: string;
	score: number;
}

/**
 * Búsqueda híbrida (fts 'simple' + pgvector HNSW con iterative_scan) acotada al top 5 del workspace.
 * Degrada limpiamente a coincidencia por texto local si Supabase/embeddings no están disponibles.
 */
export async function searchWorkspaceKnowledge(params: {
	organizationId: string;
	query: string;
	fallbackDocs?: KnowledgeDocument[];
	limit?: number;
}): Promise<KnowledgeSearchHit[]> {
	const limit = Math.min(5, Math.max(1, params.limit ?? 5));
	const admin = UUID_REGEX.test(params.organizationId) ? getSupabaseAdminClient() : null;

	if (admin) {
		try {
			const embedding = await generateTextEmbedding(params.query);
			const { data, error } = await admin.rpc('search_knowledge_hybrid_rpc', {
				p_org_id: params.organizationId,
				p_query_text: params.query.slice(0, 500),
				p_query_embedding: embedding ? formatPgVector(embedding.values) : undefined,
				p_limit: limit
			});

			if (!error && Array.isArray(data) && data.length > 0) {
				return data.slice(0, limit).map((row) => ({
					documentId: row.document_id,
					title: row.document_title,
					content: row.content,
					score: Number(row.score ?? 0)
				}));
			}
		} catch (err) {
			console.warn(
				'[ai/rag] Fallback local tras fallo en búsqueda híbrida:',
				err instanceof Error ? err.message : err
			);
		}
	}

	const fallback = selectRelevantKnowledge(params.fallbackDocs ?? [], params.query, limit);
	return fallback.map((doc) => ({
		documentId: doc.id,
		title: doc.title,
		content: doc.content_preview ?? doc.title,
		score: 0
	}));
}
