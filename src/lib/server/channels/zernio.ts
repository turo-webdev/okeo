import Zernio, { ZernioApiError } from '@zernio/node';
import { env } from '$env/dynamic/private';
import type { Platform } from '$lib/types/domain';
import { MockChannelProvider } from './mock';
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
	toSupportedPlatform,
	verifyZernioHmacSignature
} from './webhook';

export { verifyZernioHmacSignature, normalizeZernioWebhookPayload } from './webhook';

function defaultPlatformLabel(platform: Platform): string {
	if (platform === 'whatsapp') return 'WhatsApp';
	if (platform === 'instagram') return 'Instagram';
	return 'Messenger';
}

export function isZernioConfigured(): boolean {
	return Boolean(env.ZERNIO_API_KEY?.trim());
}

export function getZernioWebhookSecret(): string | null {
	return env.ZERNIO_WEBHOOK_SECRET?.trim() || null;
}

export class ZernioChannelProvider implements ChannelProvider {
	private client: Zernio;

	constructor(apiKey: string) {
		this.client = new Zernio({ apiKey });
	}

	async createProfile(orgName: string): Promise<{ profileId: string }> {
		const res = await this.client.profiles.createProfile({
			body: {
				name: orgName.trim().slice(0, 80) || 'Okeo Workspace'
			}
		});
		const profileId = res.data?.profile?._id;
		if (!profileId) {
			throw new Error('Zernio no devolvió un profileId válido al crear el perfil');
		}
		return { profileId };
	}

	async getConnectUrl(params: {
		profileId: string;
		platform: Platform;
		redirectUri: string;
		state: string;
		reconnectAccountId?: string;
	}): Promise<{ authUrl: string }> {
		const redirectUrl = new URL(params.redirectUri);
		if (!redirectUrl.searchParams.has('state')) {
			redirectUrl.searchParams.set('state', params.state);
		}

		const isRealZernioAccountId =
			Boolean(params.reconnectAccountId) &&
			!params.reconnectAccountId!.startsWith('acc_mock_') &&
			!params.reconnectAccountId!.startsWith('acc_ws_') &&
			!params.reconnectAccountId!.startsWith('acc_ct_');

		const res = await this.client.connect.getConnectUrl({
			path: { platform: params.platform },
			query: {
				profileId: params.profileId,
				redirect_url: redirectUrl.toString(),
				...(isRealZernioAccountId ? { reconnectAccountId: params.reconnectAccountId } : {})
			}
		});

		if (res.data?.authUrl) {
			return { authUrl: res.data.authUrl };
		}

		// Zernio may re-enable a previously disconnected WhatsApp account directly instead of returning authUrl.
		const directAccount = (res.data as { account?: { _id?: string } } | undefined)?.account;
		if (directAccount?._id) {
			redirectUrl.searchParams.set('accountId', directAccount._id);
			redirectUrl.searchParams.set('platform', params.platform);
			return { authUrl: redirectUrl.toString() };
		}

		throw new Error('Zernio no devolvió authUrl para conectar el canal');
	}

	async listAccounts(profileId: string): Promise<ExternalChannelAccount[]> {
		const res = await this.client.accounts.listAccounts({
			query: { profileId }
		});
		const accounts = res.data?.accounts ?? [];
		const out: ExternalChannelAccount[] = [];

		for (const acc of accounts) {
			const platform = toSupportedPlatform(acc.platform);
			if (!platform) continue;
			out.push({
				externalAccountId: acc._id,
				platform,
				displayName: acc.displayName?.trim() || defaultPlatformLabel(platform),
				handleOrPhone: acc.username?.trim() || acc.displayName?.trim() || acc._id,
				status: acc.needsReconnection ? 'disconnected' : acc.isActive ? 'active' : 'disconnected'
			});
		}

		return out;
	}

	async disconnectAccount(externalAccountId: string): Promise<void> {
		if (
			!externalAccountId ||
			externalAccountId.startsWith('acc_mock_') ||
			externalAccountId.startsWith('acc_ws_') ||
			externalAccountId.startsWith('acc_ct_')
		) {
			return;
		}
		try {
			await this.client.accounts.deleteAccount({
				path: { accountId: externalAccountId }
			});
		} catch (err) {
			if (err instanceof ZernioApiError && err.isNotFound()) {
				return;
			}
			throw err;
		}
	}

	async sendMessage(params: SendMessageInput): Promise<{ externalMessageId: string; sentAt: string }> {
		const trimmedBody = params.body.trim();
		const res = await this.client.messages.sendInboxMessage({
			path: {
				conversationId: params.externalThreadId
			},
			headers: params.idempotencyKey
				? { 'Idempotency-Key': params.idempotencyKey }
				: undefined,
			body: {
				accountId: params.externalAccountId,
				...(trimmedBody ? { message: trimmedBody } : {}),
				...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
				...(params.attachmentType ? { attachmentType: params.attachmentType } : {}),
				...(params.attachmentName ? { attachmentName: params.attachmentName } : {})
			}
		});

		const externalMessageId =
			res.data?.data?.messageId ?? `zernio_${params.platform}_${Date.now()}`;
		return {
			externalMessageId,
			sentAt: new Date().toISOString()
		};
	}

	async verifyAndParseWebhook(
		request: Request,
		rawBody: string,
		secret: string
	): Promise<NormalizedWebhookEvent> {
		const signature = request.headers.get('x-zernio-signature');
		const valid = await verifyZernioHmacSignature(rawBody, signature, secret);
		if (!valid) {
			throw new WebhookSignatureError('Firma X-Zernio-Signature inválida');
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			throw new Error('Payload JSON de webhook inválido');
		}
		if (!isRecord(parsed)) {
			throw new Error('Payload de webhook debe ser un objeto JSON');
		}

		return normalizeZernioWebhookPayload(
			request.headers.get('x-zernio-event'),
			request.headers.get('x-zernio-event-id'),
			parsed
		);
	}
}

/**
 * Punto único de acceso al proveedor de canales (AGENTS.md §4).
 * Retorna ZernioChannelProvider cuando ZERNIO_API_KEY está configurado, o MockChannelProvider en pruebas locales.
 */
export function getChannelProvider(): ChannelProvider {
	const apiKey = env.ZERNIO_API_KEY?.trim();
	if (apiKey) {
		return new ZernioChannelProvider(apiKey);
	}
	return new MockChannelProvider();
}
