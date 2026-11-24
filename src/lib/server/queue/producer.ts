import { processAiDebounceJob, type AiDebounceJob } from '$lib/server/ai/processor';

export type { AiDebounceJob } from '$lib/server/ai/processor';

const pendingLocalTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Cola de debounce asíncrona (4s).
 * En Cloudflare Workers envía al binding `AI_JOBS` con `delaySeconds: 4`;
 * en desarrollo local (`vite dev`) ejecuta un debounce real de 4s por conversación.
 */
export async function enqueueAiDebounceJob(
	job: AiDebounceJob,
	options?: { platform?: App.Platform }
): Promise<{
	enqueued: true;
	delaySeconds: number;
	mode: 'cloudflare_queue' | 'local_debounce' | 'local_test';
}> {
	const queue = options?.platform?.env?.AI_JOBS;
	if (queue) {
		await queue.send(job, { delaySeconds: 4 });
		return { enqueued: true, delaySeconds: 4, mode: 'cloudflare_queue' };
	}

	if (process.env.VITEST) {
		return { enqueued: true, delaySeconds: 4, mode: 'local_test' };
	}

	const prevTimer = pendingLocalTimers.get(job.conversationId);
	if (prevTimer) {
		clearTimeout(prevTimer);
	}

	const timer = setTimeout(() => {
		pendingLocalTimers.delete(job.conversationId);
		void processAiDebounceJob(job).catch((err) => {
			console.error('[queue/local] Error procesando job de auto-respuesta IA:', err);
		});
	}, 4000);

	pendingLocalTimers.set(job.conversationId, timer);
	return { enqueued: true, delaySeconds: 4, mode: 'local_debounce' };
}
