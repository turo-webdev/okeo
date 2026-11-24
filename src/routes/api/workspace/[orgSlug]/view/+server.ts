import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getConfiguredGeminiModel, isGeminiConfigured } from '$lib/server/ai/client';
import { isWithinMeta24hWindow } from '$lib/server/ai/processor';
import { isStripeConfigured } from '$lib/server/billing/stripe';
import { isZernioConfigured } from '$lib/server/channels/zernio';
import { isEmailDeliveryConfigured } from '$lib/server/email/invitations';
import {
	getAiPageData,
	getContactDetailPageData,
	getContactsPageData,
	getInboxPageData,
	getPipelinePageData,
	getSettingsPageData,
	listUserOrganizations,
	resolveWorkspaceAccess
} from '$lib/server/crm/repository';

const NO_STORE_HEADERS = { 'cache-control': 'private, no-store' } as const;

const viewQuerySchema = z.object({
	name: z.enum(['inbox', 'pipeline', 'contacts', 'contact', 'ai', 'settings']),
	id: z.string().min(1).optional()
});

export const GET: RequestHandler = async ({ url, params, locals }) => {
	const parsed = viewQuerySchema.safeParse({
		name: url.searchParams.get('name'),
		id: url.searchParams.get('id') || undefined
	});
	if (!parsed.success) {
		return json({ error: 'Vista inválida' }, { status: 400, headers: NO_STORE_HEADERS });
	}

	const access = await resolveWorkspaceAccess(params.orgSlug, locals);
	if (!access.authorized) {
		return json({ error: 'Acceso denegado' }, { status: 403, headers: NO_STORE_HEADERS });
	}

	const { name, id } = parsed.data;
	const orgId = access.org.id;

	switch (name) {
		case 'inbox': {
			const inboxData = await getInboxPageData(orgId, locals);
			if (!inboxData) {
				return json({ error: 'Workspace no encontrado' }, { status: 404, headers: NO_STORE_HEADERS });
			}
			return json(
				{
					ok: true,
					data: {
						conversations: inboxData.conversations.map((conv) => ({
							...conv,
							within24h: isWithinMeta24hWindow(conv.last_inbound_at)
						})),
						contacts: inboxData.contacts,
						identities: inboxData.identities,
						messages: inboxData.messages,
						notes: inboxData.notes,
						deals: inboxData.deals,
						stages: inboxData.stages,
						timelineEvents: inboxData.timelineEvents,
						channels: inboxData.channels,
						members: inboxData.members
					}
				},
				{ headers: NO_STORE_HEADERS }
			);
		}
		case 'pipeline': {
			const pipelineData = await getPipelinePageData(orgId, locals);
			if (!pipelineData) {
				return json({ error: 'Workspace no encontrado' }, { status: 404, headers: NO_STORE_HEADERS });
			}
			return json({ ok: true, data: pipelineData }, { headers: NO_STORE_HEADERS });
		}
		case 'contacts': {
			const contactsData = await getContactsPageData(orgId, locals);
			if (!contactsData) {
				return json({ error: 'Workspace no encontrado' }, { status: 404, headers: NO_STORE_HEADERS });
			}
			return json({ ok: true, data: contactsData }, { headers: NO_STORE_HEADERS });
		}
		case 'contact': {
			if (!id) {
				return json({ error: 'Contacto requerido' }, { status: 400, headers: NO_STORE_HEADERS });
			}
			const detail = await getContactDetailPageData(orgId, id, locals);
			if (!detail) {
				return json({ error: 'Contacto no encontrado' }, { status: 404, headers: NO_STORE_HEADERS });
			}
			return json({ ok: true, data: detail }, { headers: NO_STORE_HEADERS });
		}
		case 'ai': {
			const aiData = await getAiPageData(orgId, locals);
			if (!aiData || !aiData.aiSettings) {
				return json({ error: 'Ajustes de IA no encontrados' }, { status: 404, headers: NO_STORE_HEADERS });
			}
			return json(
				{
					ok: true,
					data: {
						geminiConfigured: isGeminiConfigured(),
						geminiModel: getConfiguredGeminiModel(),
						initialDemoLead: aiData.initialDemoLead,
						aiSettings: aiData.aiSettings,
						knowledgeDocuments: aiData.knowledgeDocuments,
						stages: aiData.stages
					}
				},
				{ headers: NO_STORE_HEADERS }
			);
		}
		case 'settings': {
			const [settingsData, organizations] = await Promise.all([
				getSettingsPageData(access.org, locals),
				listUserOrganizations(access.userId, locals)
			]);
			return json(
				{
					ok: true,
					data: {
						organizations,
						zernioConfigured: isZernioConfigured(),
						stripeConfigured: isStripeConfigured(),
						emailConfigured: isEmailDeliveryConfigured(),
						channels: settingsData.channels,
						members: settingsData.members,
						invitations: settingsData.invitations,
						roleChangeRequests: settingsData.roleChangeRequests,
						usageSummary: settingsData.usageSummary
					}
				},
				{ headers: NO_STORE_HEADERS }
			);
		}
	}
};
