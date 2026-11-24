import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runBillingLifecycleSweep } from '$lib/server/billing/lifecycle';
import { isAuthorizedInternalWorkerRequest } from '$lib/server/internal-auth';

export const POST: RequestHandler = async ({ request, platform }) => {
	const authorized = await isAuthorizedInternalWorkerRequest(request, platform);
	if (!authorized) {
		return json({ error: 'No autorizado para ejecutar limpieza de billing' }, { status: 401 });
	}

	try {
		const summary = await runBillingLifecycleSweep();
		return json({ ok: true, summary });
	} catch (err) {
		console.error('[api/internal/billing/lifecycle-sweep] Error ejecutando barrido:', err);
		return json(
			{
				error:
					err instanceof Error ? err.message : 'Error ejecutando limpieza de ciclos y Zernio'
			},
			{ status: 500 }
		);
	}
};
