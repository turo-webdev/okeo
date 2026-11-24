import { getSupabaseAdminClient } from '$lib/server/supabase-admin';
import type { AiUsageLedger } from '$lib/types/domain';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AiQuotaAction = 'auto_reply' | 'draft' | 'test_chat';

export interface ConsumeAiQuotaResult {
	allowed: boolean;
	reason: string;
	usagePeriodId: number | null;
	usedAiReplies: number;
	includedAiReplies: number;
	overageAiReplies: number;
	draftCount: number;
	testChatCount: number;
}

interface LocalDemoQuotaState {
	usedAiReplies: number;
	includedAiReplies: number;
	overageAiReplies: number;
	draftCount: number;
	testChatCount: number;
}

const localDemoUsage = new Map<string, LocalDemoQuotaState>();

function isUuid(value: string | null | undefined): boolean {
	return Boolean(value && UUID_REGEX.test(value.trim()));
}

/**
 * Estima el costo de ejecución en micro-dólares ($1 USD = 1,000,000 micros).
 * Tarifas base del contrato (docs/design-document.md §2):
 * - Input texto/imagen: $0.30 / 1M tokens
 * - Input con audio entrante: $1.00 / 1M tokens
 * - Output JSON: $2.50 / 1M tokens
 * - Embeddings (`gemini-embedding-001`): $0.15 / 1M tokens
 */
export function estimateGeminiCostMicros(
	model: string,
	inputTokens: number,
	outputTokens: number,
	hasAudio = false
): number {
	const safeIn = Math.max(0, Number.isFinite(inputTokens) ? inputTokens : 0);
	const safeOut = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);

	if (model.includes('embedding')) {
		return Math.max(0, Math.round(safeIn * 0.15));
	}

	const inputRatePerMillion = hasAudio ? 1.0 : 0.3;
	const outputRatePerMillion = 2.5;
	return Math.max(0, Math.round(safeIn * inputRatePerMillion + safeOut * outputRatePerMillion));
}

/**
 * Consume atómicamente una unidad de cuota (auto_reply / draft / test_chat) en `org_usage_periods`
 * mediante el RPC transaccional `consume_ai_quota_rpc` (`service_role` only).
 * Fuente única de escrituras a `org_usage_periods` en tiempo de ejecución (AGENTS.md §4).
 */
export async function consumeAiQuota(params: {
	organizationId: string;
	action: AiQuotaAction;
}): Promise<ConsumeAiQuotaResult> {
	const admin = isUuid(params.organizationId) ? getSupabaseAdminClient() : null;

	if (admin) {
		const { data, error } = await admin.rpc('consume_ai_quota_rpc', {
			p_org_id: params.organizationId,
			p_action: params.action
		});
		if (error) {
			throw new Error(`No se pudo verificar o consumir la cuota de IA: ${error.message}`);
		}
		const row = Array.isArray(data) ? data[0] : data;
		if (!row) {
			return {
				allowed: false,
				reason: 'usage_period_missing',
				usagePeriodId: null,
				usedAiReplies: 0,
				includedAiReplies: 0,
				overageAiReplies: 0,
				draftCount: 0,
				testChatCount: 0
			};
		}

		return {
			allowed: Boolean(row.allowed),
			reason: row.reason ?? 'unknown',
			usagePeriodId: row.usage_period_id ?? null,
			usedAiReplies: Number(row.used_ai_replies ?? 0),
			includedAiReplies: Number(row.included_ai_replies ?? 0),
			overageAiReplies: Number(row.overage_ai_replies ?? 0),
			draftCount: Number(row.draft_count ?? 0),
			testChatCount: Number(row.test_chat_count ?? 0)
		};
	}

	// Fallback determinista para entorno demo/tests sin UUID ni Supabase
	const existing = localDemoUsage.get(params.organizationId) ?? {
		usedAiReplies: 0,
		includedAiReplies: 1000,
		overageAiReplies: 0,
		draftCount: 0,
		testChatCount: 0
	};

	if (params.action === 'test_chat') {
		if (existing.testChatCount >= 200) {
			return {
				allowed: false,
				reason: 'test_chat_limit_reached',
				usagePeriodId: 1,
				...existing
			};
		}
		existing.testChatCount += 1;
	} else {
		if (existing.usedAiReplies >= existing.includedAiReplies) {
			return {
				allowed: false,
				reason: 'quota_exhausted',
				usagePeriodId: 1,
				...existing
			};
		}
		existing.usedAiReplies += 1;
		if (params.action === 'draft') existing.draftCount += 1;
	}

	localDemoUsage.set(params.organizationId, existing);
	return {
		allowed: true,
		reason: 'ok',
		usagePeriodId: 1,
		...existing
	};
}

/**
 * Registra un evento auditable en `ai_usage_ledger`.
 * Fuente única de escritura en `ai_usage_ledger` (AGENTS.md §4).
 */
export async function recordAiUsageLedger(params: {
	organizationId: string;
	usagePeriodId?: number | null;
	conversationId?: string | null;
	action: AiUsageLedger['action'];
	billableUnits: number;
	model: string;
	inputTokens: number;
	outputTokens: number;
	hasAudio?: boolean;
}): Promise<void> {
	if (!isUuid(params.organizationId)) return;
	const admin = getSupabaseAdminClient();
	if (!admin) return;

	const safeConvId = isUuid(params.conversationId) ? params.conversationId! : null;
	const inputTokens = Math.max(0, Math.round(params.inputTokens || 0));
	const outputTokens = Math.max(0, Math.round(params.outputTokens || 0));
	const estimatedCostMicros = estimateGeminiCostMicros(
		params.model,
		inputTokens,
		outputTokens,
		Boolean(params.hasAudio)
	);

	try {
		const { error } = await admin.from('ai_usage_ledger').insert({
			organization_id: params.organizationId,
			usage_period_id: params.usagePeriodId ?? null,
			conversation_id: safeConvId,
			action: params.action,
			billable_units: Math.max(0, Math.round(params.billableUnits)),
			model: params.model,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			estimated_cost_micros: estimatedCostMicros
		});
		if (error) {
			console.error('[ai/usage] Error insertando en ai_usage_ledger:', error.message);
		}
	} catch (err) {
		console.error('[ai/usage] Fallo al registrar ai_usage_ledger:', err);
	}
}

/**
 * Sincroniza la cuota mensual en `org_usage_periods` al activar o prorrogar/modificar suscripción
 * sin sobreescribir `used_ai_replies` acumulado en el ciclo actual (AGENTS.md §4).
 */
export async function syncUsagePeriodQuota(params: {
	organizationId: string;
	periodStart: string;
	periodEnd: string;
	includedAiReplies: number;
}): Promise<void> {
	const safeIncluded = Math.max(0, Math.round(params.includedAiReplies));

	if (!isUuid(params.organizationId)) {
		const existing = localDemoUsage.get(params.organizationId);
		localDemoUsage.set(params.organizationId, {
			usedAiReplies: existing?.usedAiReplies ?? 0,
			includedAiReplies: safeIncluded,
			overageAiReplies: existing?.overageAiReplies ?? 0,
			draftCount: existing?.draftCount ?? 0,
			testChatCount: existing?.testChatCount ?? 0
		});
		return;
	}

	const admin = getSupabaseAdminClient();
	if (!admin) return;

	const { data: existing } = await admin
		.from('org_usage_periods')
		.select('id')
		.eq('organization_id', params.organizationId)
		.eq('period_start', params.periodStart)
		.maybeSingle();

	if (existing) {
		const { error } = await admin
			.from('org_usage_periods')
			.update({
				period_end: params.periodEnd,
				included_ai_replies: safeIncluded
			})
			.eq('id', existing.id);
		if (error) {
			throw new Error(`No se pudo actualizar org_usage_periods: ${error.message}`);
		}
		return;
	}

	const { error: insertErr } = await admin.from('org_usage_periods').insert({
		organization_id: params.organizationId,
		period_start: params.periodStart,
		period_end: params.periodEnd,
		included_ai_replies: safeIncluded,
		used_ai_replies: 0,
		overage_ai_replies: 0,
		draft_count: 0,
		test_chat_count: 0
	});

	if (insertErr) {
		if (insertErr.code === '23505') {
			await admin
				.from('org_usage_periods')
				.update({
					period_end: params.periodEnd,
					included_ai_replies: safeIncluded
				})
				.eq('organization_id', params.organizationId)
				.eq('period_start', params.periodStart);
			return;
		}
		throw new Error(`No se pudo crear org_usage_periods: ${insertErr.message}`);
	}
}
