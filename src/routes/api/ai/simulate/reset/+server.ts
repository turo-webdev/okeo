import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { ensureAndResetDemoLead } from '$lib/server/crm/repository';
import { aiSimulateResetSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, aiSimulateResetSchema);
	const { org } = await assertApiOrgMember(event, body.organizationId, user.id, 'admin');

	const demoLead = await ensureAndResetDemoLead(org.id, user.id, event.locals);
	return json({ ok: true, demoLead });
};
