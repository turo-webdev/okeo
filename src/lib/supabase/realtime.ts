const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubscribeOrgRealtimeOptions {
	organizationId: string;
	tables: string[];
	onChange: () => void;
	debounceMs?: number;
}

/**
 * Suscribe a cambios en Supabase Realtime filtrados explícitamente por organization_id (AGENTS.md §3.7).
 * Carga `@supabase/supabase-js` de forma diferida para no bloquear el bundle inicial.
 */
export function subscribeOrgRealtime({
	organizationId,
	tables,
	onChange,
	debounceMs = 300
}: SubscribeOrgRealtimeOptions): () => void {
	if (!UUID_REGEX.test(organizationId) || tables.length === 0) {
		return () => {};
	}

	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let cleanupChannel: (() => void) | null = null;

	const trigger = () => {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			if (!disposed) onChange();
		}, debounceMs);
	};

	void import('./client').then(({ createSupabaseBrowserClient }) => {
		if (disposed) return;
		const supabase = createSupabaseBrowserClient();
		if (!supabase) return;

		const channel = supabase.channel(`okeo-org-${organizationId}-${tables.join('-')}`);
		for (const table of tables) {
			channel.on(
				'postgres_changes',
				{
					event: '*',
					schema: 'public',
					table,
					filter: `organization_id=eq.${organizationId}`
				},
				trigger
			);
		}
		channel.subscribe();

		cleanupChannel = () => {
			void supabase.removeChannel(channel);
		};
	});

	return () => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		cleanupChannel?.();
	};
}
