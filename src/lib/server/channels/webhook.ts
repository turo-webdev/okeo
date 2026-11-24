import type { Platform } from '$lib/types/domain';
import type { NormalizedInboundAttachment, NormalizedWebhookEvent } from './provider';

const encoder = new TextEncoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(...values: unknown[]): string | undefined {
	for (const val of values) {
		if (typeof val === 'string' && val.trim().length > 0) {
			return val.trim();
		}
	}
	return undefined;
}

export function toSupportedPlatform(value: unknown): Platform | undefined {
	if (typeof value !== 'string') return undefined;
	const lower = value.toLowerCase();
	if (lower === 'whatsapp' || lower === 'instagram' || lower === 'facebook') {
		return lower;
	}
	return undefined;
}

/**
 * Verifies the X-Zernio-Signature HMAC-SHA256 hex digest using Web Crypto constant-time verify.
 */
export async function verifyZernioHmacSignature(
	rawBody: string,
	signatureHeader: string | null,
	secret: string
): Promise<boolean> {
	if (!secret || !signatureHeader) return false;
	const cleaned = signatureHeader.trim().replace(/^sha256=/i, '');
	if (!/^[0-9a-f]{64}$/i.test(cleaned)) return false;

	const sigBytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		sigBytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
	}

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);

	return crypto.subtle.verify(
		'HMAC',
		key,
		sigBytes.buffer as ArrayBuffer,
		encoder.encode(rawBody)
	);
}

/**
 * Normalizes raw Zernio webhook JSON into Okeo's domain event contract.
 */
export function normalizeZernioWebhookPayload(
	eventHeader: string | null,
	eventIdHeader: string | null,
	rawPayload: Record<string, unknown>
): NormalizedWebhookEvent {
	const eventName =
		pickString(rawPayload.event, rawPayload.type, eventHeader) ?? 'ignored';
	const eventId = pickString(rawPayload.id, eventIdHeader);

	const accountObj = isRecord(rawPayload.account) ? rawPayload.account : null;
	const msgObj = isRecord(rawPayload.message) ? rawPayload.message : null;
	const convObj = isRecord(rawPayload.conversation) ? rawPayload.conversation : null;
	const senderObj = msgObj && isRecord(msgObj.sender) ? msgObj.sender : null;
	const errorObj = isRecord(rawPayload.error) ? rawPayload.error : null;

	const externalAccountId =
		pickString(
			accountObj?.accountId,
			accountObj?.id,
			rawPayload.accountId,
			rawPayload.externalAccountId
		) ?? '';
	const profileId = pickString(accountObj?.profileId, rawPayload.profileId);
	const platform = toSupportedPlatform(
		pickString(accountObj?.platform, msgObj?.platform, rawPayload.platform)
	);
	const externalMessageId = pickString(
		msgObj?.platformMessageId,
		msgObj?.id,
		rawPayload.externalMessageId
	);
	const externalThreadId = pickString(
		convObj?.id,
		msgObj?.conversationId,
		convObj?.platformConversationId,
		rawPayload.externalThreadId
	);

	if (eventName === 'account.disconnected') {
		return {
			eventId,
			type: 'account.disconnected',
			externalAccountId,
			profileId,
			platform,
			disconnectionType: pickString(accountObj?.disconnectionType, rawPayload.disconnectionType),
			disconnectionReason: pickString(accountObj?.reason, rawPayload.reason),
			gracePeriodEndsAt: pickString(rawPayload.gracePeriodEndsAt)
		};
	}

	if (
		eventName === 'message.delivered' ||
		eventName === 'message.read' ||
		eventName === 'message.played' ||
		eventName === 'message.failed' ||
		eventName === 'message.status'
	) {
		const rawStatus = pickString(rawPayload.status);
		const status: NormalizedWebhookEvent['status'] =
			eventName === 'message.read' || eventName === 'message.played'
				? 'read'
				: eventName === 'message.failed'
					? 'failed'
					: eventName === 'message.delivered'
						? 'delivered'
						: rawStatus === 'read' || rawStatus === 'failed' || rawStatus === 'delivered'
							? rawStatus
							: 'delivered';

		const rawCode = errorObj?.code;
		return {
			eventId,
			type: 'message.status',
			externalAccountId,
			profileId,
			platform,
			externalMessageId,
			externalThreadId,
			status,
			errorCode:
				typeof rawCode === 'number'
					? String(rawCode)
					: pickString(rawCode, rawPayload.errorCode),
			errorDetail: pickString(
				errorObj?.explanation,
				errorObj?.details,
				errorObj?.message,
				errorObj?.title,
				rawPayload.errorDetail
			)
		};
	}

	const direction = pickString(msgObj?.direction);
	const isEcho =
		eventName === 'message.echo' ||
		eventName === 'message.sent' ||
		direction === 'outgoing' ||
		direction === 'outbound' ||
		msgObj?.isFromMe === true;

	if (eventName === 'message.received' || isEcho) {
		const rawAttachments = Array.isArray(msgObj?.attachments) ? msgObj.attachments : [];
		const attachments: NormalizedInboundAttachment[] = rawAttachments
			.filter((item): item is Record<string, unknown> => isRecord(item))
			.map((item) => {
				const url = pickString(
					item.url,
					item.mediaUrl,
					item.media_url,
					item.href,
					item.fileUrl,
					item.downloadUrl
				);
				const mimeType = pickString(
					item.mimeType,
					item.mime_type,
					item.contentType,
					item.content_type
				);
				const rawKind = pickString(item.type, item.kind)?.toLowerCase() ?? '';
				const fileName = pickString(
					item.fileName,
					item.file_name,
					item.filename,
					item.name
				);
				const rawSize =
					typeof item.sizeBytes === 'number'
						? item.sizeBytes
						: typeof item.size === 'number'
							? item.size
							: undefined;

				const kind: NormalizedInboundAttachment['kind'] =
					rawKind.includes('audio') ||
					rawKind === 'voice' ||
					rawKind === 'ptt' ||
					mimeType?.toLowerCase().startsWith('audio/')
						? 'audio'
						: rawKind.includes('image') ||
							  rawKind === 'photo' ||
							  mimeType?.toLowerCase().startsWith('image/')
							? 'image'
							: 'file';

				return {
					...(url ? { url } : {}),
					...(mimeType ? { mimeType } : {}),
					...(fileName ? { fileName } : {}),
					...(rawSize !== undefined ? { sizeBytes: rawSize } : {}),
					kind
				};
			});

		const fallbackBody = attachments.length > 0 ? '[Archivo adjunto]' : '';
		const body = pickString(msgObj?.text, msgObj?.body, rawPayload.body) ?? fallbackBody;

		// On Zernio `message.sent`, `message.sender` is the business account; customer identity lives on `conversation`.
		const senderExternalId = isEcho
			? pickString(convObj?.participantId)
			: pickString(senderObj?.businessScopedUserId, senderObj?.id, convObj?.participantId);
		const senderName = isEcho
			? pickString(convObj?.participantName)
			: pickString(senderObj?.name, convObj?.participantName);
		const senderHandle = isEcho
			? pickString(convObj?.participantUsername)
			: pickString(
					senderObj?.phoneNumber,
					senderObj?.username,
					senderObj?.whatsappUsername,
					convObj?.participantUsername
				);

		return {
			eventId,
			type: isEcho ? 'message.echo' : 'message.received',
			externalAccountId,
			profileId,
			platform,
			externalMessageId,
			externalThreadId,
			senderExternalId,
			senderName,
			senderHandle,
			body,
			...(attachments.length > 0 ? { attachments } : {})
		};
	}

	return {
		eventId,
		type: 'ignored',
		externalAccountId,
		profileId,
		platform
	};
}
