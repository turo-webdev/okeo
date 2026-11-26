import type { Platform } from '$lib/types/domain';

export interface ExternalChannelAccount {
	externalAccountId: string;
	platform: Platform;
	displayName: string;
	handleOrPhone: string;
	status: 'active' | 'disconnected' | 'error';
}

export interface ExternalFacebookPage {
	pageId: string;
	name: string;
	username?: string;
	category?: string;
}

export interface GetConnectUrlInput {
	profileId: string;
	platform: Platform;
	redirectUri: string;
	state?: string;
	reconnectAccountId?: string;
	headless?: boolean;
	oauthAppId?: string;
	signupHosted?: boolean;
	brandName?: string;
	primaryColor?: string;
	language?: 'es' | 'en' | 'pt-BR';
}

export interface SelectedChannelAccount {
	externalAccountId: string;
	displayName: string;
	handleOrPhone: string;
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
	getConnectUrl(params: GetConnectUrlInput): Promise<{ authUrl: string }>;
	listPendingFacebookPages(params: {
		profileId: string;
		tempToken: string;
	}): Promise<{ pages: ExternalFacebookPage[]; truncated: boolean }>;
	selectPendingFacebookPage(params: {
		profileId: string;
		pageId: string;
		tempToken: string;
		userProfile: { id?: string; name?: string; profilePicture?: string };
		scopes?: string;
	}): Promise<SelectedChannelAccount>;
	listAccounts(profileId: string): Promise<ExternalChannelAccount[]>;
	disconnectAccount(externalAccountId: string): Promise<void>;
	sendMessage(params: SendMessageInput): Promise<{ externalMessageId: string; sentAt: string }>;
	verifyAndParseWebhook(
		request: Request,
		rawBody: string,
		secret: string
	): Promise<NormalizedWebhookEvent>;
}
