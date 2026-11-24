import { describe, expect, it, vi } from 'vitest';
import { generateAiSimulationTurn } from '$lib/server/ai/client';

vi.mock('$env/dynamic/private', () => ({
	env: { GEMINI_API_KEY: '' }
}));

describe('AI simulator per-workspace context and guardrails', () => {
	const sampleStages = [
		{ name: 'Nuevos', slug: 'new', hint: 'Primer contacto' },
		{ name: 'En conversación', slug: 'in_conversation', hint: 'Consulta precios o clases' },
		{ name: 'Clase muestra / Visita', slug: 'proposal_sent', hint: 'Quiere agendar visita' }
	];

	const sportikaStages = [
		{ name: 'Nuevos', slug: 'new', hint: 'Al escribir por primera vez.' },
		{ name: 'En conversación', slug: 'in_conversation', hint: 'Pregunta sin agendar cita.' },
		{ name: 'Calificado', slug: 'qualified', hint: 'Cuando agenda una cita para visitar.' },
		{
			name: 'Descalificado',
			slug: 'disqualified',
			hint: 'Cuando dice que no le alcanza o se le hace caro.'
		}
	];

	const sportikaDocs = [
		{
			title: 'Horarios de Sportika Metepec',
			content:
				'Horarios oficiales de Sportika Metepec: los lunes está cerrado. De martes a viernes abre de 9:00 a.m. a 10:00 p.m. Los fines de semana (sábados y domingos) el horario para actividades es de 9:00 a.m. a 7:00 p.m.'
		},
		{
			title: '¿Tienen clases individuales?',
			content:
				'¿Tienen clases individuales o sueltas? — No ofrecemos clases individuales. Todas las actividades y clases están incluidas dentro de la membresía de Sportika Metepec.'
		},
		{
			title: 'Membresías de Pareja y Familia (regla comercial)',
			content:
				'En Sportika Metepec manejamos membresía de pareja y membresía familiar. Misión del asistente: identificar siempre si busca para pareja o familia. Nunca ofrecer suscripción individual salvo que pregunte explícitamente por ella.'
		},
		{
			title: 'Objetivo de cita y descuentos semestrales/anuales',
			content:
				'El objetivo principal es agendar una cita para visitar Sportika Metepec. Contamos con descuentos al pagar semestral o anualmente, pero NO ofrecerlos al instante salvo como empuje estratégico hacia la visita.'
		}
	];

	it('uses workspace name and knowledge docs instead of hardcoded demo copy when Gemini key is absent', async () => {
		const { result, provider } = await generateAiSimulationTurn({
			organizationName: 'Sportika Metepec',
			businessContext: 'Club deportivo en Metepec, Edo. de México.',
			handoffRules: 'Pida hablar con recepción o solicite descuento.',
			tone: 'friendly',
			userMessage: 'Hola, quiero saber horarios y clases de natación',
			history: [],
			knowledgeDocs: [
				{
					title: 'Horarios Natación Sportika',
					content: 'Natación infantil y adultos de lunes a sábado de 7:00 a 21:00 hrs.'
				}
			],
			stages: sampleStages
		});

		expect(provider).toBe('mock');
		expect(result.reply_text).toContain('Sportika Metepec');
		expect(result.reply_text).toContain('7:00 a 21:00');
		expect(result.reply_text.toLowerCase()).not.toContain('identidad visual');
		expect(result.source_title).toBe('Horarios Natación Sportika');
		expect(sampleStages.map((s) => s.name)).toContain(result.recommended_stage_name);
		expect(result.needs_human_handoff).toBe(false);
	});

	it('flags needs_human_handoff on discount in generic org or explicit human request', async () => {
		const genericDiscount = await generateAiSimulationTurn({
			organizationName: 'Club Ejemplo',
			businessContext: 'Club deportivo.',
			handoffRules: 'Pida descuento o hablar con recepción.',
			tone: 'professional',
			userMessage: '¿Me pueden aplicar un descuento familiar?',
			knowledgeDocs: [{ title: 'Membresías', content: 'Mensualidad familiar.' }],
			stages: sampleStages
		});
		expect(genericDiscount.result.needs_human_handoff).toBe(true);

		const humanRequest = await generateAiSimulationTurn({
			organizationName: 'Sportika Metepec',
			businessContext: 'Sportika Metepec',
			handoffRules: 'Pasar con recepción si pide hablar con una persona.',
			tone: 'friendly',
			userMessage: 'Quiero hablar con recepción por favor',
			knowledgeDocs: sportikaDocs,
			stages: sportikaStages
		});
		expect(humanRequest.result.needs_human_handoff).toBe(true);
	});

	it('mentions Sportika schedule, Pareja/Familia only (never individual or immediate promo)', async () => {
		const { result } = await generateAiSimulationTurn({
			organizationName: 'Sportika Metepec',
			businessContext: 'Sportika Metepec — pareja y familia.',
			handoffRules: '',
			tone: 'friendly',
			userMessage: 'Hola, ¿qué horarios y membresías tienen?',
			knowledgeDocs: sportikaDocs,
			stages: sportikaStages
		});

		const lower = result.reply_text.toLowerCase();
		expect(lower).toContain('lunes está cerrado');
		expect(lower).toContain('martes a viernes');
		expect(lower).toContain('fines de semana');
		expect(lower).toContain('pareja');
		expect(lower).toContain('familiar');
		expect(lower).not.toContain('individual');
		expect(lower).not.toContain('semestral');
		expect(lower).not.toContain('anual');
		expect(lower).not.toContain('descuento');
	});

	it('clarifies there are no individual classes when asked directly', async () => {
		const { result } = await generateAiSimulationTurn({
			organizationName: 'Sportika Metepec',
			businessContext: 'Sportika Metepec',
			handoffRules: '',
			tone: 'friendly',
			userMessage: '¿Tienen clases individuales?',
			knowledgeDocs: sportikaDocs,
			stages: sportikaStages
		});

		expect(result.reply_text.toLowerCase()).toContain('no manejamos clases individuales');
		expect(result.reply_text.toLowerCase()).toContain('incluidas');
	});

	it('classifies budget objections into Descalificado and appointments into Calificado', async () => {
		const disq = await generateAiSimulationTurn({
			organizationName: 'Sportika Metepec',
			businessContext: 'Sportika Metepec',
			handoffRules: '',
			tone: 'friendly',
			userMessage: 'La verdad se me hace muy caro, no me alcanza',
			knowledgeDocs: sportikaDocs,
			stages: sportikaStages
		});
		expect(disq.result.recommended_stage_name).toBe('Descalificado');
		expect(disq.result.needs_human_handoff).toBe(false);

		const qual = await generateAiSimulationTurn({
			organizationName: 'Sportika Metepec',
			businessContext: 'Sportika Metepec',
			handoffRules: '',
			tone: 'friendly',
			userMessage: 'Me interesa conocer, ¿agendamos una cita el martes a las 5 pm?',
			knowledgeDocs: sportikaDocs,
			stages: sportikaStages
		});
		expect(qual.result.recommended_stage_name).toBe('Calificado');
		expect(qual.result.needs_human_handoff).toBe(false);
	});
});

describe('Demo Lead repository sync and reset', () => {
	it('creates/resets Prospecto Demo (IA) in the first non-terminal stage and blocks terminal moves', async () => {
		const {
			DEMO_SIM_CONTACT_EMAIL,
			ensureAndResetDemoLead,
			getWorkspaceSnapshot,
			syncDemoLeadStageFromAi
		} = await import('$lib/server/crm/repository');

		const initialSnapshot = await getWorkspaceSnapshot('org_wunderside');
		const existingDealsCount = initialSnapshot?.deals.length ?? 0;

		const resetState = await ensureAndResetDemoLead('org_wunderside', 'usr_arturo');
		expect(resetState.stageSlug).toBe('new');

		const moved = await syncDemoLeadStageFromAi({
			organizationId: 'org_wunderside',
			ownerUserId: 'usr_arturo',
			recommendedStageName: 'Propuesta enviada',
			intentSummary: 'Solicitó cotización concreta.',
			followUpAction: 'Enviar propuesta',
			needsHumanHandoff: false
		});
		expect(moved.stageName).toBe('Propuesta enviada');

		// Terminal stage 'Ganado' must be ignored by AI sync
		const attemptedTerminal = await syncDemoLeadStageFromAi({
			organizationId: 'org_wunderside',
			ownerUserId: 'usr_arturo',
			recommendedStageName: 'Ganado',
			intentSummary: 'Intento de etapa terminal.',
			followUpAction: 'Esperar confirmación humana',
			needsHumanHandoff: false
		});
		expect(attemptedTerminal.stageName).toBe('Propuesta enviada');

		const reReset = await ensureAndResetDemoLead('org_wunderside', 'usr_arturo');
		expect(reReset.stageSlug).toBe('new');

		const afterSnapshot = await getWorkspaceSnapshot('org_wunderside');
		const demoContact = afterSnapshot?.contacts.find((c) => c.email === DEMO_SIM_CONTACT_EMAIL);
		expect(demoContact).toBeTruthy();
		expect(afterSnapshot?.deals.length).toBe(existingDealsCount + 1);
	});
});

describe('Knowledge base CRUD and AI business_context preferences', () => {
	it('updates and deletes knowledge documents with multi-tenant isolation and SSRF checks', async () => {
		const {
			addKnowledgeDocument,
			deleteKnowledgeDocument,
			getWorkspaceSnapshot,
			updateKnowledgeDocument
		} = await import('$lib/server/crm/repository');

		const createdText = await addKnowledgeDocument({
			organizationId: 'org_wunderside',
			sourceType: 'text',
			title: 'Política temporal',
			question: '',
			answer: '',
			content: 'Contenido inicial de prueba.',
			url: ''
		});

		const updatedText = await updateKnowledgeDocument({
			organizationId: 'org_wunderside',
			documentId: createdText.id,
			title: 'Política actualizada',
			content: 'Contenido corregido para el asistente.'
		});
		expect(updatedText.title).toBe('Política actualizada');
		expect(updatedText.content_preview).toBe('Contenido corregido para el asistente.');
		expect(updatedText.status).toBe('ready');

		await expect(
			updateKnowledgeDocument({
				organizationId: 'org_other_tenant',
				documentId: createdText.id,
				title: 'Hack',
				content: 'Cross-tenant'
			})
		).rejects.toThrow('Fuente no encontrada');

		const createdUrl = await addKnowledgeDocument({
			organizationId: 'org_wunderside',
			sourceType: 'url',
			title: 'Servicios',
			question: '',
			answer: '',
			content: 'Catálogo web',
			url: 'https://example.com/servicios'
		});

		await expect(
			updateKnowledgeDocument({
				organizationId: 'org_wunderside',
				documentId: createdUrl.id,
				title: 'Servicios',
				content: 'Catálogo web',
				url: 'http://127.0.0.1/admin'
			})
		).rejects.toThrow();

		const updatedUrl = await updateKnowledgeDocument({
			organizationId: 'org_wunderside',
			documentId: createdUrl.id,
			title: 'Servicios 2026',
			content: 'Catálogo web actualizado',
			url: 'https://example.com/catalogo-2026'
		});
		expect(updatedUrl.source_url).toBe('https://example.com/catalogo-2026');

		await expect(deleteKnowledgeDocument('org_other_tenant', createdText.id)).rejects.toThrow(
			'Fuente no encontrada'
		);

		const deletedText = await deleteKnowledgeDocument('org_wunderside', createdText.id);
		expect(deletedText.deletedId).toBe(createdText.id);
		await deleteKnowledgeDocument('org_wunderside', createdUrl.id);

		await expect(deleteKnowledgeDocument('org_wunderside', createdText.id)).rejects.toThrow(
			'Fuente no encontrada'
		);

		const snapshot = await getWorkspaceSnapshot('org_wunderside');
		expect(snapshot?.knowledgeDocuments.some((d) => d.id === createdText.id)).toBe(false);
		expect(snapshot?.knowledgeDocuments.some((d) => d.id === createdUrl.id)).toBe(false);
	});

	it('updates business_context alongside AI preferences', async () => {
		const { getWorkspaceSnapshot, updateAiPreferences } = await import(
			'$lib/server/crm/repository'
		);

		const updated = await updateAiPreferences({
			organizationId: 'org_wunderside',
			tone: 'direct',
			autoQualifyEnabled: true,
			maxAiRepliesPerThread: 5,
			handoffRules: 'Escalar si pide factura fiscal.',
			businessContext: 'Estudio de diseño industrial con entregas en 15 días.'
		});

		expect(updated.business_context).toBe('Estudio de diseño industrial con entregas en 15 días.');
		expect(updated.tone).toBe('direct');
		expect(updated.max_ai_replies_per_thread).toBe(5);
		expect(updated.handoff_rules).toBe('Escalar si pide factura fiscal.');

		const snapshot = await getWorkspaceSnapshot('org_wunderside');
		expect(snapshot?.aiSettings?.business_context).toBe(
			'Estudio de diseño industrial con entregas en 15 días.'
		);
	});
});
