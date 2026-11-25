import svelteWorker from '../.svelte-kit/cloudflare/_worker.js';

interface WorkerEnv extends Record<string, unknown> {
	QUEUE_INTERNAL_SECRET?: string;
	OAUTH_STATE_SECRET?: string;
}

interface WorkerExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

interface QueueMessage<T = unknown> {
	id: string;
	body: T;
	ack(): void;
	retry(): void;
}

interface QueueBatch<T = unknown> {
	queue: string;
	messages: QueueMessage<T>[];
}

interface ScheduledController {
	cron: string;
	scheduledTime: number;
}

function getInternalSecret(env: WorkerEnv): string {
	return (
		(typeof env.QUEUE_INTERNAL_SECRET === 'string' && env.QUEUE_INTERNAL_SECRET.trim()) ||
		(typeof env.OAUTH_STATE_SECRET === 'string' && env.OAUTH_STATE_SECRET.trim()) ||
		''
	);
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
		return svelteWorker.fetch(request, env, ctx);
	},

	async queue(batch: QueueBatch, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<void> {
		const secret = getInternalSecret(env);

		for (const message of batch.messages) {
			try {
				const internalRequest = new Request('https://okeo.internal/api/internal/ai/process-job', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(secret ? { 'x-okeo-queue-secret': secret } : {})
					},
					body: JSON.stringify(message.body)
				});

				const res = await svelteWorker.fetch(internalRequest, env, ctx);
				if (res.ok || (res.status >= 400 && res.status < 500)) {
					if (!res.ok) {
						console.warn(
							`[workers/entry] Job ${message.id} rechazado con HTTP ${res.status}; marcando ack.`
						);
					}
					message.ack();
				} else {
					console.error(
						`[workers/entry] Job ${message.id} falló con HTTP ${res.status}; reintentando.`
					);
					message.retry();
				}
			} catch (err) {
				console.error(`[workers/entry] Excepción procesando job ${message.id}:`, err);
				message.retry();
			}
		}
	},

	async scheduled(
		controller: ScheduledController,
		env: WorkerEnv,
		ctx: WorkerExecutionContext
	): Promise<void> {
		const secret = getInternalSecret(env);
		ctx.waitUntil(
			(async () => {
				try {
					const internalRequest = new Request(
						'https://okeo.internal/api/internal/billing/lifecycle-sweep',
						{
							method: 'POST',
							headers: {
								...(secret ? { 'x-okeo-queue-secret': secret } : {})
							}
						}
					);
					const res = await svelteWorker.fetch(internalRequest, env, ctx);
					if (!res.ok) {
						const bodyText = await res.text().catch(() => '');
						console.error(
							`[workers/entry] Cron ${controller.cron} falló con HTTP ${res.status}: ${bodyText}`
						);
					}
				} catch (err) {
					console.error(`[workers/entry] Excepción en cron ${controller.cron}:`, err);
				}
			})()
		);
	}
};
