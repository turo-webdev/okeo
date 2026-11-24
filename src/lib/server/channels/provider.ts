import type { Platform } from '$lib/types/domain';

export interface ExternalChannelAccount {
	externalAccountId: string;
	platform: Platform;
	displayName: string;
	handleOrPhone: string;
	status: 'active' | 'disconnected' | 'error';
}

export interface SendMessageInput {
	externalAccountId: string;
	externalThreadId: string;
	platform: Platform;
	body: string;
	attachmentUrl?: string;
	attachmentType?: 'image' | 'audio' | 'file';
	attachmentName?: string;
	idempotencyKey?: string;
}

export interface NormalizedInboundAttachment {
	url?: string;
	mimeType?: string;
	fileName?: string;
	sizeBytes?: number;
	kind: 'image' | 'audio' | 'file';
}

export interface NormalizedWebhookEvent {
	eventId?: string;
	type: 'message.received' | 'message.echo' | 'message.status' | 'account.disconnected' | 'ignored';
	externalAccountId: string;
	profileId?: string;
	platform?: Platform;
	externalMessageId?: string;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
	body?: string;
	attachments?: NormalizedInboundAttachment[];
	status?: 'delivered' | 'read' | 'failed';
	errorCode?: string;
	errorDetail?: string;
	disconnectionType?: string;
	disconnectionReason?: string;
	gracePeriodEndsAt?: string;
}

export class WebhookSignatureError extends Error {
	constructor(message = 'Firma X-Zernio-Signature inválida') {
		super(message);
		this.name = 'WebhookSignatureError';
	}
}

/**
 * Contrato agnóstico de proveedor para mensajería omnicanal (AGENTS.md §4).
 * Ninguna ruta ni servicio fuera de `src/lib/server/channels/` importa `@zernio/node`.
 */
export interface ChannelProvider {
	createProfile(orgName: string): Promise<{ profileId: string }>;
	getConnectUrl(params: {
		profileId: string;
		platform: Platform;
		redirectUri: string;
		state: string;
		reconnectAccountId?: string;
	}): Promise<{ authUrl: string }>;
	listAccounts(profileId: string): Promise<ExternalChannelAccount[]>;
	disconnectAccount(externalAccountId: string): Promise<void>;
	sendMessage(params: SendMessageInput): Promise<{ externalMessageId: string; sentAt: string }>;
	verifyAndParseWebhook(
		request: Request,
		rawBody: string,
		secret: string
	): Promise<NormalizedWebhookEvent>;
}
