import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getConversationMessagesPage, resolveWorkspaceAccess } from '$lib/server/crm/repository';

const NO_STORE_HEADERS = { 'cache-control': 'private, no-store' } as const;

const messagesQuerySchema = z.object({
	conversationId: z.string().min(1),
	beforeId: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(40)
});

export const GET: RequestHandler = async ({ url, params, locals }) => {
	const parsed = messagesQuerySchema.safeParse({
		conversationId: url.searchParams.get('conversationId'),
		beforeId: url.searchParams.get('beforeId') || undefined,
		limit: url.searchParams.get('limit') || undefined
	});
	if (!parsed.success) {
		return json({ error: 'Parámetros de mensajes inválidos' }, { status: 400, headers: NO_STORE_HEADERS });
	}

	const access = await resolveWorkspaceAccess(params.orgSlug, locals);
	if (!access.authorized) {
		return json({ error: 'Acceso denegado' }, { status: 403, headers: NO_STORE_HEADERS });
	}

	const page = await getConversationMessagesPage(
		access.org.id,
		parsed.data.conversationId,
		{
			beforeId: parsed.data.beforeId,
			limit: parsed.data.limit
		},
		locals
	);

	return json({ ok: true, ...page }, { headers: NO_STORE_HEADERS });
};
