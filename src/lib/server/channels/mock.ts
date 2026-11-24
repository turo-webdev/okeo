import type { Platform } from '$lib/types/domain';
import {
	WebhookSignatureError,
	type ChannelProvider,
	type ExternalChannelAccount,
	type NormalizedWebhookEvent,
	type SendMessageInput
} from './provider';
import {
	isRecord,
	normalizeZernioWebhookPayload,
	verifyZernioHmacSignature
} from './webhook';

export class MockChannelProvider implements ChannelProvider {
	async createProfile(orgName: string): Promise<{ profileId: string }> {
		const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
		return { profileId: `zernio_prof_mock_${slug}_${Date.now()}` };
	}

	async getConnectUrl(params: {
		profileId: string;
		platform: Platform;
		redirectUri: string;
		state: string;
		reconnectAccountId?: string;
	}): Promise<{ authUrl: string }> {
		const url = new URL(params.redirectUri);
		if (!url.searchParams.has('state')) {
			url.searchParams.set('state', params.state);
		}
		url.searchParams.set(
			'accountId',
			params.reconnectAccountId ?? `acc_mock_${params.platform}_${Date.now()}`
		);
		url.searchParams.set('platform', params.platform);
		return { authUrl: url.toString() };
	}

	async listAccounts(_profileId: string): Promise<ExternalChannelAccount[]> {
		return [];
	}

	async disconnectAccount(_externalAccountId: string): Promise<void> {
		return;
	}

	async sendMessage(params: SendMessageInput): Promise<{ externalMessageId: string; sentAt: string }> {
		return {
			externalMessageId: `msg_mock_${params.platform}_${Date.now()}`,
			sentAt: new Date().toISOString()
		};
	}

	async verifyAndParseWebhook(
		request: Request,
		rawBody: string,
		secret: string
	): Promise<NormalizedWebhookEvent> {
		if (secret) {
			const valid = await verifyZernioHmacSignature(
				rawBody,
				request.headers.get('x-zernio-signature'),
				secret
			);
			if (!valid) {
				throw new WebhookSignatureError('Firma X-Zernio-Signature inválida');
			}
		}

		const parsed = JSON.parse(rawBody || '{}') as unknown;
		if (!isRecord(parsed)) {
			throw new Error('Payload JSON de webhook inválido');
		}

		const normalized = normalizeZernioWebhookPayload(
			request.headers.get('x-zernio-event'),
			request.headers.get('x-zernio-event-id'),
			parsed
		);
		return {
			...normalized,
			externalAccountId: normalized.externalAccountId || 'acc_ws_wa'
		};
	}
}
