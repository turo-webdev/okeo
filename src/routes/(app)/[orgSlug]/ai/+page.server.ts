import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import type { KnowledgeUploadedFile } from '$lib/server/ai/knowledge-ingest';
import { requireMemberForAction } from '$lib/server/crm/actions';
import {
	addKnowledgeDocument,
	deleteKnowledgeDocument,
	retryKnowledgeDocument,
	updateAiMode,
	updateAiPreferences,
	updateKnowledgeDocument,
	updatePipelineQualificationRules
} from '$lib/server/crm/repository';
import { MAX_UPLOAD_BYTES } from '$lib/server/storage';
import {
	addKnowledgeSchema,
	deleteKnowledgeSchema,
	updateAiModeSchema,
	updateAiPreferencesSchema,
	updateKnowledgeSchema,
	updatePipelineRulesSchema
} from '$lib/validation/schemas';

export const actions: Actions = {
	updateMode: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = updateAiModeSchema.safeParse({
			organizationId: fd.get('organizationId'),
			autoReplyEnabled: fd.get('autoReplyEnabled') === 'true'
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { action: 'updateMode', error: 'Modo inválido' });
		}
		await updateAiMode(org.id, parsed.data.autoReplyEnabled, locals);
		return { ok: true, action: 'updateMode' };
	},

	updatePreferences: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = updateAiPreferencesSchema.safeParse({
			organizationId: fd.get('organizationId'),
			tone: fd.get('tone'),
			autoQualifyEnabled: fd.get('autoQualifyEnabled') === 'on' || fd.get('autoQualifyEnabled') === 'true',
			maxAiRepliesPerThread: fd.get('maxAiRepliesPerThread'),
			handoffRules: fd.get('handoffRules') ?? '',
			businessContext: String(fd.get('businessContext') ?? '')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { action: 'updatePreferences', error: 'Preferencias inválidas' });
		}
		await updateAiPreferences(parsed.data, locals);
		return { ok: true, action: 'updatePreferences' };
	},

	updateRules: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const orgId = String(fd.get('organizationId') ?? '');
		const rules: Record<string, string> = {};
		for (const [k, v] of fd.entries()) {
			if (k.startsWith('rule_')) {
				rules[k.slice(5)] = String(v);
			}
		}
		const parsed = updatePipelineRulesSchema.safeParse({ organizationId: orgId, rules });
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { action: 'updateRules', error: 'Reglas inválidas' });
		}
		await updatePipelineQualificationRules(org.id, parsed.data.rules, locals);
		return { ok: true, action: 'updateRules' };
	},

	addKnowledge: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = addKnowledgeSchema.safeParse({
			organizationId: fd.get('organizationId'),
			sourceType: fd.get('sourceType'),
			title: fd.get('title') ?? '',
			question: fd.get('question') ?? '',
			answer: fd.get('answer') ?? '',
			content: fd.get('content') ?? '',
			url: fd.get('url') ?? ''
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { action: 'addKnowledge', error: 'Completa los campos del documento' });
		}

		let uploadedFile: KnowledgeUploadedFile | null = null;
		const rawFile = fd.get('file');
		if (rawFile instanceof File && rawFile.size > 0) {
			if (rawFile.size > MAX_UPLOAD_BYTES) {
				return fail(400, {
					action: 'addKnowledge',
					error: 'El archivo excede el límite máximo de 10 MB.'
				});
			}
			uploadedFile = {
				name: rawFile.name,
				mimeType: rawFile.type,
				bytes: new Uint8Array(await rawFile.arrayBuffer())
			};
		}

		try {
			await addKnowledgeDocument(
				{
					...parsed.data,
					file: uploadedFile
				},
				locals
			);
			return { ok: true, action: 'addKnowledge' };
		} catch (err) {
			return fail(400, {
				action: 'addKnowledge',
				error: err instanceof Error ? err.message : 'Error al guardar fuente'
			});
		}
	},

	updateKnowledge: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = updateKnowledgeSchema.safeParse({
			organizationId: fd.get('organizationId'),
			documentId: fd.get('documentId'),
			title: fd.get('title') ?? '',
			content: fd.get('content') ?? '',
			url: fd.has('url') ? String(fd.get('url') ?? '') : undefined
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, {
				action: 'updateKnowledge',
				error: parsed.success
					? 'Organización inválida'
					: (parsed.error.issues[0]?.message ?? 'Completa título y contenido')
			});
		}
		try {
			await updateKnowledgeDocument(parsed.data, locals);
			return { ok: true, action: 'updateKnowledge' };
		} catch (err) {
			return fail(400, {
				action: 'updateKnowledge',
				error: err instanceof Error ? err.message : 'No se pudo actualizar la fuente'
			});
		}
	},

	deleteKnowledge: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = deleteKnowledgeSchema.safeParse({
			organizationId: fd.get('organizationId'),
			documentId: fd.get('documentId')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { action: 'deleteKnowledge', error: 'Documento inválido' });
		}
		try {
			await deleteKnowledgeDocument(org.id, parsed.data.documentId, locals);
			return { ok: true, action: 'deleteKnowledge' };
		} catch (err) {
			return fail(400, {
				action: 'deleteKnowledge',
				error: err instanceof Error ? err.message : 'No se pudo eliminar la fuente'
			});
		}
	},

	retryKnowledge: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const docId = String(fd.get('documentId') ?? '');
		if (!docId) return fail(400, { action: 'retryKnowledge', error: 'Documento inválido' });
		try {
			await retryKnowledgeDocument(org.id, docId, locals);
			return { ok: true, action: 'retryKnowledge' };
		} catch (err) {
			return fail(400, {
				action: 'retryKnowledge',
				error: err instanceof Error ? err.message : 'No se pudo reintentar la indexación'
			});
		}
	}
};
