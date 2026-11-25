import { env as publicEnv } from '$env/dynamic/public';
import { resolveDomainContext } from '$lib/server/domains';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ url }) => {
	const domainCtx = resolveDomainContext(url, publicEnv);
	return {
		marketingHomeUrl: domainCtx.marketingHomeUrl,
		appOriginPrefix: domainCtx.appOriginPrefix
	};
};
