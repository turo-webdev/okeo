import type { PipelineStage } from '$lib/types/domain';

function normalizeStageText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim();
}

export function scoreForDemoStage(stageSlug: string): number {
	if (stageSlug === 'qualified') return 90;
	if (stageSlug === 'disqualified') return 15;
	return 60;
}

export function matchOpenStage<
	T extends Pick<PipelineStage, 'id' | 'name' | 'slug' | 'position' | 'is_terminal'>
>(stages: T[], recommendedStageName: string, fallbackStageId?: string): T {
	const openStages = [...stages]
		.filter((s) => !s.is_terminal)
		.sort((a, b) => a.position - b.position);

	if (openStages.length === 0) {
		throw new Error('No hay etapas activas en el pipeline para este workspace');
	}

	const norm = normalizeStageText(recommendedStageName);
	if (norm) {
		const exact = openStages.find(
			(s) => normalizeStageText(s.name) === norm || normalizeStageText(s.slug) === norm
		);
		if (exact) return exact;

		const longestFirst = [...openStages].sort((a, b) => b.name.length - a.name.length);
		const partial = longestFirst.find((s) => {
			const stageNorm = normalizeStageText(s.name);
			return norm.includes(stageNorm) || stageNorm.includes(norm);
		});
		if (partial) return partial;
	}

	if (fallbackStageId) {
		const existing = openStages.find((s) => s.id === fallbackStageId);
		if (existing) return existing;
	}

	return openStages[0];
}
