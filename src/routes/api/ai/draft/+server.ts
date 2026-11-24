import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { generateAiSimulationTurn } from '$lib/server/ai/client';
import { searchWorkspaceKnowledge } from '$lib/server/ai/rag';
import { consumeAiQuota, recordAiUsageLedger } from '$lib/server/ai/usage';
import { isOrganizationSubscriptionBlocked } from '$lib/server/billing/plans';
import { getAiDraftContext } from '$lib/server/crm/repository';
import { aiDraftSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, aiDraftSchema);
	const { org } = await assertApiOrgMember(event, body.organizationId, user.id, 'agent');

	if (isOrganizationSubscriptionBlocked(org)) {
		return json(
			{
				error: 'Tu trial o suscripción requiere regularización para usar el copiloto de IA.',
				code: 'SUBSCRIPTION_INACTIVE'
			},
			{ status: 402 }
		);
	}

	const ctx = await getAiDraftContext(org, body.conversationId, event.locals);
	if (!ctx.conv) {
		return json({ error: 'Conversación no encontrada' }, { status: 404 });
	}

	if (
		ctx.usageSummary &&
		!org.ai_overage_enabled &&
		ctx.usageSummary.usedAiReplies >= ctx.usageSummary.includedAiReplies
	) {
		return json(
			{ error: 'Cuota mensual de respuestas IA agotada.', code: 'AI_QUOTA_EXHAUSTED' },
			{ status: 429 }
		);
	}

	const lastInboundIdx = ctx.recentMessages.findLastIndex((m) => m.direction === 'inbound');
	const lastInbound = lastInboundIdx >= 0 ? ctx.recentMessages[lastInboundIdx] : null;
	const priorMessages =
		lastInboundIdx >= 0 ? ctx.recentMessages.slice(0, lastInboundIdx) : ctx.recentMessages;

	const firstName = ctx.contact?.name.split(' ')[0] ?? '';
	const userMessage =
		lastInbound?.body ??
		(firstName
			? `Saluda cordialmente a ${firstName} y retoma su consulta.`
			: 'Hola, me gustaría recibir más información.');

	const kbHits = await searchWorkspaceKnowledge({
		organizationId: org.id,
		query: userMessage,
		fallbackDocs: ctx.readyDocs,
		limit: 5
	});

	try {
		const { result, provider, model, usage } = await generateAiSimulationTurn({
			organizationName: org.name,
			businessContext: ctx.aiSettings?.business_context ?? '',
			handoffRules: ctx.aiSettings?.handoff_rules ?? '',
			tone: ctx.aiSettings?.tone ?? 'professional',
			userMessage,
			history: priorMessages.map((m) => ({
				role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
				text: m.body
			})),
			knowledgeDocs: kbHits.map((d) => ({
				title: d.title,
				content: d.content
			})),
			stages: ctx.openStages.map((s) => ({
				name: s.name,
				slug: s.slug,
				hint: s.ai_qualification_hint
			}))
		});

		const quota = await consumeAiQuota({
			organizationId: org.id,
			action: 'draft'
		});
		if (!quota.allowed) {
			return json(
				{
					error:
						quota.reason === 'subscription_inactive'
							? 'Tu trial o suscripción requiere regularización para generar borradores.'
							: 'Cuota mensual de respuestas IA agotada.',
					code: quota.reason === 'subscription_inactive' ? 'SUBSCRIPTION_INACTIVE' : 'AI_QUOTA_EXHAUSTED'
				},
				{ status: quota.reason === 'subscription_inactive' ? 402 : 429 }
			);
		}

		await recordAiUsageLedger({
			organizationId: org.id,
			usagePeriodId: quota.usagePeriodId,
			conversationId: body.conversationId,
			action: 'draft',
			billableUnits: 1,
			model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens
		});

		return json({ ok: true, draft: result.reply_text, provider, model });
	} catch (err) {
		return json(
			{
				error:
					err instanceof Error
						? err.message
						: 'No se pudo generar un borrador de respuesta en este momento.'
			},
			{ status: 502 }
		);
	}
};
