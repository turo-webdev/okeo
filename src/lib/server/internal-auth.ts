import { env } from '$env/dynamic/private';

const encoder = new TextEncoder();

export async function timingSafeSecretMatch(expected: string, actual: string): Promise<boolean> {
	if (!expected || !actual) return false;
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
		crypto.subtle.digest('SHA-256', encoder.encode(actual))
	]);
	const bytesA = new Uint8Array(hashA);
	const bytesB = new Uint8Array(hashB);
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= bytesA[i] ^ bytesB[i];
	}
	return diff === 0;
}

export async function isAuthorizedInternalWorkerRequest(
	request: Request,
	platform?: App.Platform
): Promise<boolean> {
	const expectedSecret =
		platform?.env?.QUEUE_INTERNAL_SECRET?.trim() ||
		env.QUEUE_INTERNAL_SECRET?.trim() ||
		platform?.env?.OAUTH_STATE_SECRET?.trim() ||
		env.OAUTH_STATE_SECRET?.trim() ||
		'';

	const providedSecret = request.headers.get('x-okeo-queue-secret')?.trim() || '';
	return timingSafeSecretMatch(expectedSecret, providedSecret);
}
