import { isWithinMeta24hWindow } from '$lib/server/ai/processor';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { getConversationAndChannel, sendManualMessage } from '$lib/server/crm/repository';
import { createSignedStorageUrl, isPathOwnedByOrganization } from '$lib/server/storage';
import type { Message, MessageAttachment } from '$lib/types/domain';

export class OutboundDeliveryError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'OutboundDeliveryError';
	}
}

/**
 * Entrega unificada de mensajes manuales del Inbox (texto y/o adjunto privado en `dm-media`)
 * a través de `ChannelProvider`, validando ventana de 24h y canal activo.
 */
export async function deliverManualMessage(
	params: {
		organizationId: string;
		conversationId: string;
		userId: string;
		body: string;
		retryMessageId?: number;
		attachment?: MessageAttachment;
	},
	locals: App.Locals
): Promise<Message> {
	const { conv, channel } = await getConversationAndChannel(
		params.organizationId,
		params.conversationId,
		locals
	);
	if (!conv) {
		throw new OutboundDeliveryError(404, 'CONVERSATION_NOT_FOUND', 'Conversación no encontrada');
	}
	if (conv.last_inbound_at && !isWithinMeta24hWindow(conv.last_inbound_at)) {
		throw new OutboundDeliveryError(
			422,
			'META_24H_EXPIRED',
			'La ventana de 24 horas de Meta expiró para esta conversación.'
		);
	}
	if (!channel || channel.status !== 'active') {
		throw new OutboundDeliveryError(
			422,
			'CHANNEL_DISCONNECTED',
			'El canal de esta conversación está desconectado o pausado. Revísalo en Ajustes > Canales.'
		);
	}

	let signedAttachmentUrl: string | undefined;
	if (params.attachment) {
		if (!isPathOwnedByOrganization(params.attachment.storage_path, params.organizationId)) {
			throw new OutboundDeliveryError(
				403,
				'ATTACHMENT_FORBIDDEN',
				'El adjunto no pertenece a este workspace.'
			);
		}
		const signed = await createSignedStorageUrl({
			organizationId: params.organizationId,
			storagePath: params.attachment.storage_path,
			bucket: 'dm-media',
			expiresInSeconds: 300
		});
		if (!signed) {
			throw new OutboundDeliveryError(
				403,
				'ATTACHMENT_FORBIDDEN',
				'El adjunto no pertenece a este workspace.'
			);
		}
		signedAttachmentUrl = signed.signedUrl;
	}

	let externalMessageId: string;
	try {
		const sent = await getChannelProvider().sendMessage({
			externalAccountId: channel.external_account_id,
			externalThreadId: conv.external_thread_id,
			platform: conv.platform,
			body: params.body,
			...(signedAttachmentUrl && params.attachment
				? {
						attachmentUrl: signedAttachmentUrl,
						attachmentType: params.attachment.kind,
						attachmentName: params.attachment.file_name
					}
				: {}),
			idempotencyKey: crypto.randomUUID()
		});
		externalMessageId = sent.externalMessageId;
	} catch (err) {
		const detail =
			err instanceof Error ? err.message : 'No se pudo entregar el mensaje por Zernio.';
		throw new OutboundDeliveryError(502, 'CHANNEL_SEND_FAILED', detail);
	}

	return sendManualMessage(
		{
			organizationId: params.organizationId,
			conversationId: params.conversationId,
			userId: params.userId,
			body: params.body,
			attachments: params.attachment ? [params.attachment] : [],
			retryMessageId: params.retryMessageId,
			externalMessageId
		},
		locals
	);
}
