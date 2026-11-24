import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { processAiDebounceJob } from '$lib/server/ai/processor';
import { isAuthorizedInternalWorkerRequest } from '$lib/server/internal-auth';

const processJobSchema = z.object({
	organizationId: z.string().min(1),
	conversationId: z.string().min(1),
	messageId: z.coerce.number().int().positive(),
	rawAttachments: z
		.array(
			z.object({
				url: z.string().optional(),
				mimeType: z.string().optional(),
				fileName: z.string().optional(),
				sizeBytes: z.number().nonnegative().optional(),
				kind: z.enum(['image', 'audio', 'file'])
			})
		)
		.max(5)
		.optional()
});

export const POST: RequestHandler = async ({ request, platform }) => {
	const authorized = await isAuthorizedInternalWorkerRequest(request, platform);
	if (!authorized) {
		return json({ error: 'No autorizado para procesar cola interna' }, { status: 401 });
	}

	let rawPayload: unknown;
	try {
		rawPayload = await request.json();
	} catch {
		return json({ error: 'JSON inválido en job de cola' }, { status: 400 });
	}

	const parsed = processJobSchema.safeParse(rawPayload);
	if (!parsed.success) {
		return json(
			{ error: 'Payload de job inválido', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	try {
		const result = await processAiDebounceJob(parsed.data);
		return json({ ok: true, result });
	} catch (err) {
		console.error('[api/internal/ai/process-job] Error procesando job:', err);
		return json(
			{
				error: err instanceof Error ? err.message : 'Error procesando job de IA'
			},
			{ status: 500 }
		);
	}
};
