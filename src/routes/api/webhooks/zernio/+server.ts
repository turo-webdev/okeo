import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	WebhookSignatureError,
	type NormalizedWebhookEvent
} from '$lib/server/channels/provider';
import {
	getChannelProvider,
	getZernioWebhookSecret,
	isZernioConfigured
} from '$lib/server/channels/zernio';
import {
	ingestExternalEchoMessage,
	ingestInboundWebhookMessage,
	markChannelDisconnectedByExternalId,
	tryClaimZernioWebhookEvent,
	updateMessageDeliveryStatus
} from '$lib/server/crm/repository';
import { enqueueAiDebounceJob } from '$lib/server/queue/producer';

export const POST: RequestHandler = async ({ request, platform }) => {
	// Leer raw body ANTES de cualquier parseo JSON para verificar HMAC sobre bytes exactos (AGENTS.md §2).
	const rawBody = await request.text();
	const signature = request.headers.get('x-zernio-signature');
	const webhookSecret = getZernioWebhookSecret();
	const liveMode = isZernioConfigured();

	if (liveMode && !webhookSecret) {
		return json(
			{ error: 'ZERNIO_WEBHOOK_SECRET no configurado en el servidor' },
			{ status: 503 }
		);
	}

	if (!webhookSecret && !signature && !rawBody) {
		return json({ error: 'Firma X-Zernio-Signature requerida' }, { status: 401 });
	}

	let event: NormalizedWebhookEvent;
	try {
		event = await getChannelProvider().verifyAndParseWebhook(
			request,
			rawBody || '{}',
			webhookSecret ?? ''
		);
	} catch (err) {
		if (err instanceof WebhookSignatureError) {
			return json({ error: err.message }, { status: 401 });
		}
		return json(
			{ error: err instanceof Error ? err.message : 'Payload de webhook inválido' },
			{ status: 400 }
		);
	}

	const eventId = event.eventId || request.headers.get('x-zernio-event-id') || '';
	if (eventId) {
		const claimed = await tryClaimZernioWebhookEvent(
			eventId,
			event.type,
			event.externalAccountId
		);
		if (!claimed) {
			return json({ received: true, deduplicated: true, type: event.type });
		}
	}

	if (event.type === 'message.received') {
		const ingested = await ingestInboundWebhookMessage({
			externalAccountId: event.externalAccountId,
			externalMessageId: event.externalMessageId,
			externalThreadId: event.externalThreadId,
			senderExternalId: event.senderExternalId,
			senderName: event.senderName,
			senderHandle: event.senderHandle,
			body: event.body ?? ''
		});

		if (ingested && !ingested.deduplicated) {
			await enqueueAiDebounceJob(
				{
					organizationId: ingested.organizationId,
					conversationId: ingested.conversationId,
					messageId: ingested.messageId,
					...(event.attachments && event.attachments.length > 0
						? { rawAttachments: event.attachments }
						: {})
				},
				{ platform }
			);
		}
	} else if (event.type === 'message.echo') {
		await ingestExternalEchoMessage({
			externalAccountId: event.externalAccountId,
			externalMessageId: event.externalMessageId,
			externalThreadId: event.externalThreadId,
			senderExternalId: event.senderExternalId,
			senderName: event.senderName,
			senderHandle: event.senderHandle,
			body: event.body ?? ''
		});
	} else if (event.type === 'message.status' && event.externalMessageId && event.status) {
		await updateMessageDeliveryStatus({
			externalAccountId: event.externalAccountId,
			externalMessageId: event.externalMessageId,
			status: event.status,
			errorCode: event.errorCode,
			errorDetail: event.errorDetail
		});
	} else if (event.type === 'account.disconnected') {
		await markChannelDisconnectedByExternalId({
			externalAccountId: event.externalAccountId,
			reason: event.disconnectionReason,
			disconnectionType: event.disconnectionType,
			gracePeriodEndsAt: event.gracePeriodEndsAt
		});
	}

	return json({
		received: true,
		type: event.type,
		mode: liveMode ? 'zernio' : 'mock'
	});
};
