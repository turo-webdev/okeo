import {
	WebhookSignatureError,
	type ChannelProvider,
	type ExternalChannelAccount,
	type ExternalFacebookPage,
	type GetConnectUrlInput,
	type NormalizedWebhookEvent,
	type SelectedChannelAccount,
	type SendMessageInput
} from './provider';
import {
	isRecord,
	normalizeZernioWebhookPayload,
	verifyZernioHmacSignature
} from './webhook';

const MOCK_FACEBOOK_PAGES: ExternalFacebookPage[] = [
	{
		pageId: 'page_mock_okeo_studio',
		name: 'Okeo Studio',
		username: 'okeostudio',
		category: 'Agencia de Marketing'
	},
	{
		pageId: 'page_mock_okeo_soporte',
		name: 'Okeo Atención al Cliente',
		username: 'okeosoporte',
		category: 'Software Empresarial'
	}
];

export class MockChannelProvider implements ChannelProvider {
	async createProfile(orgName: string): Promise<{ profileId: string }> {
		const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
		return { profileId: `zernio_prof_mock_${slug}_${Date.now()}` };
	}

	async getConnectUrl(params: GetConnectUrlInput): Promise<{ authUrl: string }> {
		const url = new URL(params.redirectUri);
		if (params.state && !url.searchParams.has('state')) {
			url.searchParams.set('state', params.state);
		}

		if (params.headless && params.platform === 'facebook') {
			url.searchParams.set('step', 'select_page');
			url.searchParams.set('platform', 'facebook');
			url.searchParams.set('profileId', params.profileId);
			url.searchParams.set('tempToken', 'mock_temp_fb_token');
			url.searchParams.set(
				'userProfile',
				encodeURIComponent(JSON.stringify({ id: 'fb_user_mock_1', name: 'Equipo Okeo' }))
			);
			return { authUrl: url.toString() };
		}

		url.searchParams.set(
			'accountId',
			params.reconnectAccountId ?? `acc_mock_${params.platform}_${Date.now()}`
		);
		url.searchParams.set('platform', params.platform);
		return { authUrl: url.toString() };
	}

	async listPendingFacebookPages(params: {
		profileId: string;
		tempToken: string;
	}): Promise<{ pages: ExternalFacebookPage[]; truncated: boolean }> {
		if (!params.tempToken) {
			throw new Error('Token temporal faltante');
		}
		return {
			pages: MOCK_FACEBOOK_PAGES,
			truncated: false
		};
	}

	async selectPendingFacebookPage(params: {
		profileId: string;
		pageId: string;
		tempToken: string;
		userProfile: { id?: string; name?: string; profilePicture?: string };
		scopes?: string;
	}): Promise<SelectedChannelAccount> {
		const matched = MOCK_FACEBOOK_PAGES.find((p) => p.pageId === params.pageId);
		const displayName = matched?.name ?? 'Página Messenger';
		const handleOrPhone = matched?.username ?? params.pageId;
		return {
			externalAccountId: `acc_mock_facebook_${params.pageId}`,
			displayName,
			handleOrPhone
		};
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
