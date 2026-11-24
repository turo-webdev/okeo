import { describe, expect, it } from 'vitest';
import { MockChannelProvider } from '../mock';
import { signOAuthState, verifyOAuthState } from '../state';
import {
	normalizeZernioWebhookPayload,
	verifyZernioHmacSignature
} from '../webhook';
import { sendMessageSchema } from '$lib/validation/schemas';
import {
	getWorkspaceSnapshot,
	ingestExternalEchoMessage,
	ingestInboundWebhookMessage,
	updateMessageDeliveryStatus,
	upsertConnectedChannel
} from '$lib/server/crm/repository';

async function computeHmacHex(rawBody: string, secret: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('Zernio webhook HMAC verification', () => {
	const secret = 'whsec_test_secret_12345';
	const body = JSON.stringify({ id: 'evt_1', event: 'message.received', test: true });

	it('accepts valid HMAC-SHA256 hex digest and sha256= prefixed digest', async () => {
		const digest = await computeHmacHex(body, secret);
		expect(await verifyZernioHmacSignature(body, digest, secret)).toBe(true);
		expect(await verifyZernioHmacSignature(body, `sha256=${digest}`, secret)).toBe(true);
	});

	it('rejects altered body, wrong secret, and missing or malformed signatures', async () => {
		const digest = await computeHmacHex(body, secret);
		expect(await verifyZernioHmacSignature(`${body} `, digest, secret)).toBe(false);
		expect(await verifyZernioHmacSignature(body, digest, 'wrong_secret')).toBe(false);
		expect(await verifyZernioHmacSignature(body, null, secret)).toBe(false);
		expect(await verifyZernioHmacSignature(body, 'not-hex', secret)).toBe(false);
	});
});

describe('OAuth state signing and verification', () => {
	const secret = 'oauth_state_secret_test';

	it('round-trips a signed payload with channelId', async () => {
		const token = await signOAuthState(
			{
				organizationId: 'org_wunderside',
				userId: 'usr_arturo',
				platform: 'facebook',
				channelId: 'ch_ws_fb',
				nonce: 'nonce-1',
				exp: Date.now() + 60_000
			},
			secret
		);
		const verified = await verifyOAuthState(token, secret);
		expect(verified).not.toBeNull();
		expect(verified?.organizationId).toBe('org_wunderside');
		expect(verified?.channelId).toBe('ch_ws_fb');
		expect(verified?.platform).toBe('facebook');
	});

	it('returns null for expired or tampered state tokens', async () => {
		const expired = await signOAuthState(
			{
				organizationId: 'org_wunderside',
				userId: 'usr_arturo',
				platform: 'whatsapp',
				nonce: 'nonce-2',
				exp: Date.now() - 1000
			},
			secret
		);
		expect(await verifyOAuthState(expired, secret)).toBeNull();

		const valid = await signOAuthState(
			{
				organizationId: 'org_wunderside',
				userId: 'usr_arturo',
				platform: 'whatsapp',
				nonce: 'nonce-3',
				exp: Date.now() + 60_000
			},
			secret
		);
		const [data, sig] = valid.split('.');
		expect(await verifyOAuthState(`${data}x.${sig}`, secret)).toBeNull();
		expect(await verifyOAuthState(valid, 'different-secret')).toBeNull();
	});
});

describe('Zernio webhook payload normalization', () => {
	it('normalizes message.received payload using Zernio SDK shape', () => {
		const normalized = normalizeZernioWebhookPayload('message.received', 'evt_hdr_1', {
			id: 'evt_msg_1',
			event: 'message.received',
			account: {
				id: 'acc_ws_wa',
				accountId: 'acc_ws_wa',
				profileId: 'prof_1',
				platform: 'whatsapp',
				username: '+525512345678'
			},
			conversation: {
				id: 'thr_zernio_99',
				platformConversationId: 'wa_thread_99',
				participantId: 'bsuid_123',
				participantName: 'Carla Gómez',
				status: 'active'
			},
			message: {
				id: 'zmsg_1',
				conversationId: 'thr_zernio_99',
				platform: 'whatsapp',
				platformMessageId: 'wamid.123',
				direction: 'incoming',
				text: 'Hola, ¿tienen disponibilidad?',
				attachments: [],
				sender: {
					id: '525599998888',
					businessScopedUserId: 'bsuid_123',
					name: 'Carla Gómez',
					phoneNumber: '+525599998888'
				}
			}
		});

		expect(normalized).toMatchObject({
			eventId: 'evt_msg_1',
			type: 'message.received',
			externalAccountId: 'acc_ws_wa',
			profileId: 'prof_1',
			platform: 'whatsapp',
			externalMessageId: 'wamid.123',
			externalThreadId: 'thr_zernio_99',
			senderExternalId: 'bsuid_123',
			senderName: 'Carla Gómez',
			senderHandle: '+525599998888',
			body: 'Hola, ¿tienen disponibilidad?'
		});
	});

	it('normalizes message.sent into message.echo reading customer identity from conversation', () => {
		const normalized = normalizeZernioWebhookPayload('message.sent', 'evt_echo_1', {
			id: 'evt_echo_1',
			event: 'message.sent',
			account: {
				id: 'acc_ws_wa',
				platform: 'whatsapp',
				username: 'Business'
			},
			conversation: {
				id: 'thr_ana_wa',
				platformConversationId: 'wa_ana',
				participantId: 'wa_525522018810',
				participantName: 'Ana Torres',
				participantUsername: '+52 55 2201 8810'
			},
			message: {
				id: 'zmsg_echo_1',
				conversationId: 'thr_ana_wa',
				platform: 'whatsapp',
				platformMessageId: 'wamid.echo.1',
				direction: 'outgoing',
				text: 'Te atiendo directo desde el teléfono',
				sender: {
					id: 'acc_ws_wa',
					name: 'Mi Negocio'
				}
			}
		});

		expect(normalized).toMatchObject({
			type: 'message.echo',
			externalAccountId: 'acc_ws_wa',
			externalThreadId: 'thr_ana_wa',
			externalMessageId: 'wamid.echo.1',
			senderExternalId: 'wa_525522018810',
			senderName: 'Ana Torres',
			body: 'Te atiendo directo desde el teléfono'
		});
	});

	it('normalizes delivery status and account.disconnected events', () => {
		const statusEvt = normalizeZernioWebhookPayload('message.failed', null, {
			id: 'evt_fail_1',
			event: 'message.failed',
			account: { id: 'acc_ws_wa', platform: 'whatsapp' },
			conversation: { id: 'thr_ana_wa' },
			message: { id: 'm1', platformMessageId: 'wamid.999' },
			error: { code: 131026, explanation: 'Recipient opted out' }
		});
		expect(statusEvt).toMatchObject({
			type: 'message.status',
			status: 'failed',
			externalMessageId: 'wamid.999',
			errorCode: '131026',
			errorDetail: 'Recipient opted out'
		});

		const discEvt = normalizeZernioWebhookPayload('account.disconnected', null, {
			id: 'evt_disc_1',
			event: 'account.disconnected',
			account: {
				accountId: 'acc_ws_ig',
				profileId: 'prof_ws',
				platform: 'instagram',
				disconnectionType: 'unintentional',
				reason: 'Token expired'
			}
		});
		expect(discEvt).toMatchObject({
			type: 'account.disconnected',
			externalAccountId: 'acc_ws_ig',
			disconnectionType: 'unintentional',
			disconnectionReason: 'Token expired'
		});

		const unknownEvt = normalizeZernioWebhookPayload('comment.received', null, {
			id: 'evt_other',
			event: 'comment.received',
			account: { id: 'acc_ws_ig' }
		});
		expect(unknownEvt.type).toBe('ignored');
	});

	it('normalizes audio, image, and file attachments on inbound messages', () => {
		const mediaEvt = normalizeZernioWebhookPayload('message.received', 'evt_media_1', {
			id: 'evt_media_1',
			event: 'message.received',
			account: { id: 'acc_ws_wa', platform: 'whatsapp' },
			conversation: { id: 'thr_ana_wa', participantId: 'wa_525522018810' },
			message: {
				id: 'zmsg_media_1',
				direction: 'incoming',
				attachments: [
					{
						type: 'voice',
						url: 'https://cdn.example.com/audio.ogg',
						mimeType: 'audio/ogg',
						size: 4096
					},
					{
						type: 'photo',
						mediaUrl: 'https://cdn.example.com/pic.jpg',
						mimeType: 'image/jpeg'
					}
				]
			}
		});

		expect(mediaEvt.body).toBe('[Archivo adjunto]');
		expect(mediaEvt.attachments).toEqual([
			{
				url: 'https://cdn.example.com/audio.ogg',
				mimeType: 'audio/ogg',
				sizeBytes: 4096,
				kind: 'audio'
			},
			{
				url: 'https://cdn.example.com/pic.jpg',
				mimeType: 'image/jpeg',
				kind: 'image'
			}
		]);
	});
});

describe('Multi-tenant Zernio repository behaviors', () => {
	it('deduplicates inbound webhook messages with identical externalMessageId', async () => {
		const first = await ingestInboundWebhookMessage({
			externalAccountId: 'acc_ws_wa',
			externalMessageId: 'wamid_unique_test_1',
			externalThreadId: 'thr_ana_wa',
			body: 'Primer mensaje de prueba'
		});
		expect(first).not.toBeNull();
		expect(first?.deduplicated).toBe(false);

		const second = await ingestInboundWebhookMessage({
			externalAccountId: 'acc_ws_wa',
			externalMessageId: 'wamid_unique_test_1',
			externalThreadId: 'thr_ana_wa',
			body: 'Primer mensaje de prueba'
		});
		expect(second?.deduplicated).toBe(true);
		expect(second?.messageId).toBe(first?.messageId);

		const updated = await updateMessageDeliveryStatus({
			externalAccountId: 'acc_ws_wa',
			externalMessageId: 'wamid_unique_test_1',
			status: 'read'
		});
		expect(updated).toBe(true);
	});

	it('pauses AI immediately when an external human echo arrives', async () => {
		const beforeSnapshot = await getWorkspaceSnapshot('org_wunderside');
		const before = beforeSnapshot?.conversations.find((c) => c.id === 'conv_ana');
		expect(before?.ai_paused).toBe(false);

		const ok = await ingestExternalEchoMessage({
			externalAccountId: 'acc_ws_wa',
			externalMessageId: 'wamid_ext_echo_1',
			externalThreadId: 'thr_ana_wa',
			body: 'Hola Ana, te escribo desde WhatsApp Business'
		});
		expect(ok).toBe(true);

		const afterSnapshot = await getWorkspaceSnapshot('org_wunderside');
		const after = afterSnapshot?.conversations.find((c) => c.id === 'conv_ana');
		expect(after?.ai_paused).toBe(true);
		expect(after?.ai_handoff_reason).toContain('app externa');
	});

	it('prevents attaching an externalAccountId already owned by another workspace', async () => {
		const collision = await upsertConnectedChannel({
			organizationId: 'org_cafe_terral',
			platform: 'whatsapp',
			externalAccountId: 'acc_ws_wa',
			displayName: 'WhatsApp',
			handleOrPhone: '+52 55 1234 5678'
		});

		expect(collision).toMatchObject({
			ok: false,
			code: 'ACCOUNT_IN_OTHER_ORG'
		});
	});

	it('validates outbound text-only, attachment-only, and rejects empty messages without attachment', async () => {
		expect(
			sendMessageSchema.safeParse({
				organizationId: 'org_wunderside',
				conversationId: 'conv_ana',
				body: '   '
			}).success
		).toBe(false);

		expect(
			sendMessageSchema.safeParse({
				organizationId: 'org_wunderside',
				conversationId: 'conv_ana',
				body: 'Hola Ana'
			}).success
		).toBe(true);

		const attOnly = sendMessageSchema.safeParse({
			organizationId: 'org_wunderside',
			conversationId: 'conv_ana',
			body: '',
			attachment: {
				storage_path: 'org_wunderside/conv_ana/catalogo.pdf',
				mime_type: 'application/pdf',
				file_name: 'catalogo.pdf',
				size_bytes: 2048,
				kind: 'file'
			}
		});
		expect(attOnly.success).toBe(true);

		const provider = new MockChannelProvider();
		const sent = await provider.sendMessage({
			externalAccountId: 'acc_ws_wa',
			externalThreadId: 'thr_ana_wa',
			platform: 'whatsapp',
			body: '',
			attachmentUrl: 'https://storage.example.com/signed.pdf',
			attachmentType: 'file',
			attachmentName: 'catalogo.pdf',
			idempotencyKey: 'idem_1'
		});
		expect(sent.externalMessageId).toContain('msg_mock_whatsapp_');
	});
});
