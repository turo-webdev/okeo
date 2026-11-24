import { extractDocumentTextWithGemini, GEMINI_EMBEDDING_MODEL } from '$lib/server/ai/client';
import {
	fetchAndExtractPublicUrl,
	validateSafeExternalUrl
} from '$lib/server/ai/rag';
import { recordAiUsageLedger } from '$lib/server/ai/usage';
import {
	downloadPrivateMediaAsBase64,
	MAX_UPLOAD_BYTES,
	uint8ToBase64,
	uploadPrivateStorageFile
} from '$lib/server/storage';
import type { KnowledgeDocument, KnowledgeSourceType } from '$lib/types/domain';

export const MAX_KB_INGEST_CHARS = 24_000;
export const MAX_KB_PREVIEW_CHARS = 6_000;

export const ALLOWED_KB_MIME_TYPES = new Set([
	'application/pdf',
	'text/plain',
	'text/markdown',
	'text/x-markdown',
	'text/csv',
	'application/csv'
]);

const ALLOWED_KB_EXTS = new Set(['pdf', 'txt', 'md', 'csv']);

export interface KnowledgeUploadedFile {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
}

export interface KnowledgeIngestResult {
	title: string;
	subtitle: string;
	sourceUrl: string | null;
	storagePath: string | null;
	fullText: string;
	contentPreview: string;
}

export interface KnowledgeIngestDeps {
	uploadFile: typeof uploadPrivateStorageFile;
	downloadBase64: typeof downloadPrivateMediaAsBase64;
	fetchUrl: (rawUrl: string) => Promise<{ finalUrl: string; title: string | null; text: string }>;
	extractPdf: typeof extractDocumentTextWithGemini;
	recordLedger: typeof recordAiUsageLedger;
}

function createDefaultDeps(): KnowledgeIngestDeps {
	return {
		uploadFile: uploadPrivateStorageFile,
		downloadBase64: downloadPrivateMediaAsBase64,
		fetchUrl: (rawUrl) => fetchAndExtractPublicUrl(rawUrl),
		extractPdf: extractDocumentTextWithGemini,
		recordLedger: recordAiUsageLedger
	};
}

function resolveKbFileKind(fileName: string, mimeType: string): { isPdf: boolean; canonicalMime: string } {
	const ext = fileName.split('.').pop()?.trim().toLowerCase() ?? '';
	const cleanMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

	if (cleanMime === 'application/pdf' || ext === 'pdf') {
		return { isPdf: true, canonicalMime: 'application/pdf' };
	}
	if (ALLOWED_KB_MIME_TYPES.has(cleanMime) || ALLOWED_KB_EXTS.has(ext)) {
		if (ext === 'csv' || cleanMime.includes('csv')) {
			return { isPdf: false, canonicalMime: 'text/csv' };
		}
		if (ext === 'md' || cleanMime.includes('markdown')) {
			return { isPdf: false, canonicalMime: 'text/markdown' };
		}
		return { isPdf: false, canonicalMime: 'text/plain' };
	}

	throw new Error('Formato no compatible. Sube archivos PDF, TXT, MD o CSV.');
}

/**
 * Orquesta la ingesta real de fuentes de Base de Conocimiento (PDF vía bucket privado + Gemini multimodal,
 * URL pública con anti-SSRF, FAQ y texto libre).
 */
export async function ingestKnowledgeSource(
	params: {
		organizationId: string;
		sourceType: KnowledgeSourceType;
		title: string;
		question: string;
		answer: string;
		content: string;
		url: string;
		file?: KnowledgeUploadedFile | null;
	},
	overrides?: Partial<KnowledgeIngestDeps>
): Promise<KnowledgeIngestResult> {
	const deps: KnowledgeIngestDeps = { ...createDefaultDeps(), ...overrides };
	const rawTitle = params.title.trim();

	if (params.sourceType === 'url') {
		const check = validateSafeExternalUrl(params.url);
		if (!check.ok) throw new Error(check.reason);

		const fetched = await deps.fetchUrl(check.url.toString());
		const extraNotes = params.content.trim();
		const combined = extraNotes ? `${fetched.text}\n\n${extraNotes}` : fetched.text;
		const fullText = combined.trim().slice(0, MAX_KB_INGEST_CHARS);

		return {
			title: (rawTitle || fetched.title || `${check.url.hostname}${check.url.pathname}`).slice(0, 140),
			subtitle: 'URL indexada',
			sourceUrl: fetched.finalUrl,
			storagePath: null,
			fullText,
			contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS)
		};
	}

	if (params.sourceType === 'faq') {
		const q = params.question.trim();
		const a = params.answer.trim();
		if (!q || !a) {
			throw new Error('Escribe tanto la pregunta como la respuesta para guardar la FAQ.');
		}
		const fullText = `${q} — ${a}`.slice(0, MAX_KB_INGEST_CHARS);
		return {
			title: (rawTitle || q || 'Pregunta frecuente').slice(0, 140),
			subtitle: 'FAQ',
			sourceUrl: null,
			storagePath: null,
			fullText,
			contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS)
		};
	}

	if (params.sourceType === 'file') {
		const file = params.file;
		if (!file || file.bytes.byteLength === 0) {
			const fallbackContent = params.content.trim();
			if (!fallbackContent) {
				throw new Error('Selecciona un archivo PDF, TXT, MD o CSV para subir.');
			}
			const fullText = fallbackContent.slice(0, MAX_KB_INGEST_CHARS);
			const fallbackTitle = rawTitle || 'Documento.txt';
			return {
				title: fallbackTitle.slice(0, 140),
				subtitle: 'Archivo',
				sourceUrl: null,
				storagePath: null,
				fullText,
				contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS)
			};
		}

		if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
			throw new Error('El archivo excede el límite máximo de 10 MB.');
		}

		const { isPdf, canonicalMime } = resolveKbFileKind(file.name, file.mimeType);
		const uploaded = await deps.uploadFile({
			organizationId: params.organizationId,
			resourceId: crypto.randomUUID(),
			fileName: file.name,
			bytes: file.bytes,
			mimeType: canonicalMime,
			bucket: 'knowledge-files'
		});

		let extractedText = '';
		if (isPdf) {
			const extracted = await deps.extractPdf({
				base64Data: uint8ToBase64(file.bytes),
				mimeType: canonicalMime,
				fileName: uploaded.fileName
			});
			extractedText = extracted.text;

			await deps.recordLedger({
				organizationId: params.organizationId,
				action: 'embed',
				billableUnits: 0,
				model: extracted.model,
				inputTokens: extracted.usage.inputTokens,
				outputTokens: extracted.usage.outputTokens
			});
		} else {
			extractedText = new TextDecoder('utf-8', { fatal: false }).decode(file.bytes).trim();
		}

		if (extractedText.trim().length < 10) {
			throw new Error(
				'No encontramos suficiente texto legible en este archivo. Si es un PDF escaneado sin texto claro, intenta exportarlo con mejor resolución o pega el texto directo.'
			);
		}

		const fullText = extractedText.trim().slice(0, MAX_KB_INGEST_CHARS);
		return {
			title: (rawTitle || uploaded.fileName).slice(0, 140),
			subtitle: isPdf ? 'PDF' : 'Archivo',
			sourceUrl: null,
			storagePath: uploaded.storagePath,
			fullText,
			contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS)
		};
	}

	const textContent = params.content.trim();
	if (!textContent) {
		throw new Error('Escribe el contenido de la fuente antes de guardar.');
	}
	const fullText = textContent.slice(0, MAX_KB_INGEST_CHARS);
	return {
		title: (rawTitle || 'Fuente de conocimiento').slice(0, 140),
		subtitle: 'Texto',
		sourceUrl: null,
		storagePath: null,
		fullText,
		contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS)
	};
}

/**
 * Re-procesa una fuente existente (para acción "Reintentar" sobre URLs o archivos privados).
 */
export async function reingestKnowledgeFileOrUrl(
	params: {
		organizationId: string;
		sourceType: KnowledgeDocument['source_type'];
		sourceUrl: string | null;
		storagePath: string | null;
		title: string;
		existingContent: string | null;
	},
	overrides?: Partial<KnowledgeIngestDeps>
): Promise<{ fullText: string; contentPreview: string; embeddingModel: string }> {
	const deps: KnowledgeIngestDeps = { ...createDefaultDeps(), ...overrides };

	if (params.sourceType === 'url' && params.sourceUrl) {
		const fetched = await deps.fetchUrl(params.sourceUrl);
		const fullText = fetched.text.slice(0, MAX_KB_INGEST_CHARS);
		return {
			fullText,
			contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS),
			embeddingModel: GEMINI_EMBEDDING_MODEL
		};
	}

	if (params.sourceType === 'file' && params.storagePath) {
		const b64 = await deps.downloadBase64(
			params.organizationId,
			params.storagePath,
			'knowledge-files'
		);
		if (!b64) {
			throw new Error('No se encontró el archivo original en el almacenamiento privado.');
		}

		const isPdf = params.storagePath.toLowerCase().endsWith('.pdf');
		let text = '';
		if (isPdf) {
			const extracted = await deps.extractPdf({
				base64Data: b64,
				mimeType: 'application/pdf',
				fileName: params.title
			});
			text = extracted.text;
			await deps.recordLedger({
				organizationId: params.organizationId,
				action: 'embed',
				billableUnits: 0,
				model: extracted.model,
				inputTokens: extracted.usage.inputTokens,
				outputTokens: extracted.usage.outputTokens
			});
		} else {
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
		}

		if (text.length < 10) {
			throw new Error('El archivo no contiene suficiente texto legible.');
		}

		const fullText = text.slice(0, MAX_KB_INGEST_CHARS);
		return {
			fullText,
			contentPreview: fullText.slice(0, MAX_KB_PREVIEW_CHARS),
			embeddingModel: GEMINI_EMBEDDING_MODEL
		};
	}

	const existing = (params.existingContent ?? params.title).trim().slice(0, MAX_KB_INGEST_CHARS);
	return {
		fullText: existing,
		contentPreview: existing.slice(0, MAX_KB_PREVIEW_CHARS),
		embeddingModel: GEMINI_EMBEDDING_MODEL
	};
}
