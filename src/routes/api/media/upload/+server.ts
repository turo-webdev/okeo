import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, requireApiSession } from '$lib/server/auth';
import { getConversationAndChannel } from '$lib/server/crm/repository';
import {
	createSignedStorageUrl,
	MAX_UPLOAD_BYTES,
	uploadPrivateStorageFile
} from '$lib/server/storage';
import type { MessageAttachment } from '$lib/types/domain';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const AUDIO_MIMES = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm']);
const FILE_MIMES = new Set([
	'application/pdf',
	'text/plain',
	'text/csv',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const EXT_FALLBACK_MIMES: Record<string, { kind: MessageAttachment['kind']; mime: string }> = {
	jpg: { kind: 'image', mime: 'image/jpeg' },
	jpeg: { kind: 'image', mime: 'image/jpeg' },
	png: { kind: 'image', mime: 'image/png' },
	webp: { kind: 'image', mime: 'image/webp' },
	gif: { kind: 'image', mime: 'image/gif' },
	ogg: { kind: 'audio', mime: 'audio/ogg' },
	mp3: { kind: 'audio', mime: 'audio/mpeg' },
	m4a: { kind: 'audio', mime: 'audio/mp4' },
	wav: { kind: 'audio', mime: 'audio/wav' },
	webm: { kind: 'audio', mime: 'audio/webm' },
	pdf: { kind: 'file', mime: 'application/pdf' },
	txt: { kind: 'file', mime: 'text/plain' },
	csv: { kind: 'file', mime: 'text/csv' },
	docx: {
		kind: 'file',
		mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
	},
	xlsx: {
		kind: 'file',
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	}
};

function classifyUploadedMedia(
	fileName: string,
	rawMime: string
): { kind: MessageAttachment['kind']; mimeType: string } | null {
	const cleanMime = rawMime.split(';')[0]?.trim().toLowerCase() ?? '';
	if (IMAGE_MIMES.has(cleanMime)) return { kind: 'image', mimeType: cleanMime };
	if (AUDIO_MIMES.has(cleanMime)) return { kind: 'audio', mimeType: cleanMime };
	if (FILE_MIMES.has(cleanMime)) return { kind: 'file', mimeType: cleanMime };

	const ext = fileName.split('.').pop()?.trim().toLowerCase() ?? '';
	const fallback = EXT_FALLBACK_MIMES[ext];
	return fallback ? { kind: fallback.kind, mimeType: fallback.mime } : null;
}

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);

	let fd: FormData;
	try {
		fd = await event.request.formData();
	} catch {
		return json({ error: 'Solicitud multipart inválida.' }, { status: 400 });
	}

	const organizationId = String(fd.get('organizationId') ?? '').trim();
	const conversationId = String(fd.get('conversationId') ?? '').trim();
	const rawFile = fd.get('file');

	if (!organizationId || !conversationId) {
		return json({ error: 'organizationId y conversationId son requeridos.' }, { status: 400 });
	}

	await assertApiOrgMember(event, organizationId, user.id, 'agent');

	const { conv } = await getConversationAndChannel(organizationId, conversationId, event.locals);
	if (!conv) {
		return json({ error: 'Conversación no encontrada en este workspace.' }, { status: 404 });
	}

	if (!(rawFile instanceof File) || rawFile.size === 0) {
		return json({ error: 'Selecciona un archivo válido para adjuntar.' }, { status: 400 });
	}

	if (rawFile.size > MAX_UPLOAD_BYTES) {
		return json({ error: 'El archivo excede el límite máximo de 10 MB.' }, { status: 413 });
	}

	const classified = classifyUploadedMedia(rawFile.name, rawFile.type);
	if (!classified) {
		return json(
			{
				error: 'Tipo de archivo no permitido. Usa imagen, audio, PDF, TXT, CSV, DOCX o XLSX.'
			},
			{ status: 415 }
		);
	}

	const bytes = new Uint8Array(await rawFile.arrayBuffer());
	const uniqueName = `${crypto.randomUUID().slice(0, 8)}-${rawFile.name}`;

	const uploaded = await uploadPrivateStorageFile({
		organizationId,
		resourceId: conversationId,
		fileName: uniqueName,
		bytes,
		mimeType: classified.mimeType,
		bucket: 'dm-media'
	});

	const attachment: MessageAttachment = {
		storage_path: uploaded.storagePath,
		mime_type: classified.mimeType,
		file_name: rawFile.name.slice(0, 140) || uploaded.fileName,
		size_bytes: uploaded.sizeBytes,
		kind: classified.kind
	};

	const signed = await createSignedStorageUrl({
		organizationId,
		storagePath: uploaded.storagePath,
		bucket: 'dm-media',
		expiresInSeconds: 300
	});

	return json({
		ok: true,
		attachment,
		previewUrl: signed?.signedUrl ?? null
	});
};
