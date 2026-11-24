import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfiguredGeminiModel, isGeminiConfigured } from '$lib/server/ai/client';
import { isWithinMeta24hWindow } from '$lib/server/ai/processor';
import { isStripeConfigured } from '$lib/server/billing/stripe';
import { isZernioConfigured } from '$lib/server/channels/zernio';
import { isEmailDeliveryConfigured } from '$lib/server/email/invitations';
import {
	getWorkspaceSnapshot,
	listUserOrganizations,
	resolveWorkspaceAccess
} from '$lib/server/crm/repository';
import { DEMO_SIM_CONTACT_EMAIL, type DemoLeadState } from '$lib/types/domain';
import type { WorkspaceBootstrapPayload } from '$lib/types/workspace-views';

const NO_STORE_HEADERS = { 'cache-control': 'private, no-store' } as const;

export const GET: RequestHandler = async ({ params, locals }) => {
	const access = await resolveWorkspaceAccess(params.orgSlug, locals);
	if (!access.authorized) {
		return json({ error: 'Acceso denegado' }, { status: 403, headers: NO_STORE_HEADERS });
	}

	const [snapshot, organizations] = await Promise.all([
		getWorkspaceSnapshot(access.org.id, locals, access.org),
		listUserOrganizations(access.userId, locals)
	]);
	if (!snapshot) {
		return json({ error: 'Workspace no encontrado' }, { status: 404, headers: NO_STORE_HEADERS });
	}

	const openStages = snapshot.stages.filter((s) => !s.is_terminal);
	const demoContact = snapshot.contacts.find((c) => c.email === DEMO_SIM_CONTACT_EMAIL);
	const demoDeal = demoContact
		? snapshot.deals.find((d) => d.contact_id === demoContact.id)
		: undefined;
	const demoStage = demoDeal ? openStages.find((s) => s.id === demoDeal.stage_id) : undefined;
	const initialDemoLead: DemoLeadState | null =
		demoContact && demoDeal && demoStage
			? {
					contactId: demoContact.id,
					dealId: demoDeal.id,
					stageId: demoStage.id,
					stageName: demoStage.name,
					stageSlug: demoStage.slug
				}
			: null;

	const data: WorkspaceBootstrapPayload = {
		inbox: {
			conversations: snapshot.conversations.map((conv) => ({
				...conv,
				within24h: isWithinMeta24hWindow(conv.last_inbound_at)
			})),
			contacts: snapshot.contacts,
			identities: snapshot.identities,
			messages: snapshot.messages,
			notes: snapshot.notes,
			deals: snapshot.deals,
			stages: snapshot.stages,
			timelineEvents: snapshot.timelineEvents,
			channels: snapshot.channels,
			members: snapshot.members
		},
		pipeline: {
			stages: snapshot.stages,
			deals: snapshot.deals,
			contacts: snapshot.contacts,
			notes: snapshot.notes,
			timelineEvents: snapshot.timelineEvents,
			members: snapshot.members
		},
		contacts: {
			contacts: snapshot.contacts,
			identities: snapshot.identities,
			members: snapshot.members
		},
		ai: snapshot.aiSettings
			? {
					geminiConfigured: isGeminiConfigured(),
					geminiModel: getConfiguredGeminiModel(),
					initialDemoLead,
					aiSettings: snapshot.aiSettings,
					knowledgeDocuments: snapshot.knowledgeDocuments,
					stages: openStages
				}
			: null,
		settings: {
			organizations,
			zernioConfigured: isZernioConfigured(),
			stripeConfigured: isStripeConfigured(),
			emailConfigured: isEmailDeliveryConfigured(),
			channels: snapshot.channels,
			members: snapshot.members,
			invitations: snapshot.invitations,
			roleChangeRequests: snapshot.roleChangeRequests,
			usageSummary: snapshot.usageSummary
		}
	};

	return json({ ok: true, data }, { headers: NO_STORE_HEADERS });
};
