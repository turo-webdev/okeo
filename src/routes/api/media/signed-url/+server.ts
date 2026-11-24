import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, requireApiSession } from '$lib/server/auth';
import { createSignedStorageUrl, type StorageBucket } from '$lib/server/storage';

export const GET: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const organizationId = event.url.searchParams.get('organizationId') ?? '';
	const path = event.url.searchParams.get('path') ?? '';
	const bucketParam = event.url.searchParams.get('bucket');
	const bucket: StorageBucket =
		bucketParam === 'knowledge-files' ? 'knowledge-files' : 'dm-media';

	if (!organizationId || !path) {
		return json({ error: 'organizationId y path son requeridos' }, { status: 400 });
	}

	await assertApiOrgMember(event, organizationId, user.id, 'viewer');

	try {
		const signed = await createSignedStorageUrl({
			organizationId,
			storagePath: path,
			bucket
		});
		if (!signed) {
			return json({ error: 'Ruta fuera del workspace autorizado' }, { status: 403 });
		}
		return json({ ok: true, ...signed });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Archivo no disponible en Storage';
		return json({ error: message }, { status: 404 });
	}
};
