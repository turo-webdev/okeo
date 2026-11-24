import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { generateAiSimulationTurn } from '$lib/server/ai/client';
import { searchWorkspaceKnowledge } from '$lib/server/ai/rag';
import { consumeAiQuota, recordAiUsageLedger } from '$lib/server/ai/usage';
import { getAiPageData, syncDemoLeadStageFromAi } from '$lib/server/crm/repository';
import { aiSimulateSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, aiSimulateSchema);
	const { org } = await assertApiOrgMember(event, body.organizationId, user.id, 'admin');

	const quota = await consumeAiQuota({
		organizationId: org.id,
		action: 'test_chat'
	});
	if (!quota.allowed) {
		const isInactive = quota.reason === 'subscription_inactive';
		return json(
			{
				error: isInactive
					? 'Tu trial o suscripción requiere regularización para usar el chat de prueba.'
					: 'Límite de mensajes de prueba alcanzado para este período.',
				code: isInactive ? 'SUBSCRIPTION_INACTIVE' : 'TEST_CHAT_LIMIT_REACHED'
			},
			{ status: isInactive ? 402 : 429 }
		);
	}

	const aiData = await getAiPageData(org.id, event.locals);
	const kbHits = await searchWorkspaceKnowledge({
		organizationId: org.id,
		query: body.message,
		fallbackDocs: aiData?.knowledgeDocuments ?? [],
		limit: 5
	});

	const openStages = (aiData?.stages ?? []).map((s) => ({
		name: s.name,
		slug: s.slug,
		hint: s.ai_qualification_hint
	}));

	try {
		const { result, provider, model, usage } = await generateAiSimulationTurn({
			organizationName: org.name,
			businessContext: aiData?.aiSettings?.business_context ?? '',
			handoffRules: aiData?.aiSettings?.handoff_rules ?? '',
			tone: aiData?.aiSettings?.tone ?? 'professional',
			userMessage: body.message,
			history: body.history,
			knowledgeDocs: kbHits.map((d) => ({
				title: d.title,
				content: d.content
			})),
			stages: openStages
		});

		await recordAiUsageLedger({
			organizationId: org.id,
			usagePeriodId: quota.usagePeriodId,
			action: 'test_chat',
			billableUnits: 0,
			model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens
		});

		const demoLead = body.syncDemoLead
			? await syncDemoLeadStageFromAi(
					{
						organizationId: org.id,
						ownerUserId: user.id,
						recommendedStageName: result.recommended_stage_name,
						intentSummary: result.intent_summary,
						followUpAction: result.follow_up_action,
						needsHumanHandoff: result.needs_human_handoff
					},
					event.locals
				)
			: null;

		return json({ ok: true, result, provider, model, demoLead });
	} catch (err) {
		return json(
			{
				error:
					err instanceof Error
						? err.message
						: 'No se pudo generar la respuesta de prueba del asistente.'
			},
			{ status: 502 }
		);
	}
};
