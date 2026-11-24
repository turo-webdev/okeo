import { z } from 'zod';

const roleEnum = z.enum(['owner', 'admin', 'agent', 'viewer']);
const inviteRoleEnum = z.enum(['admin', 'agent', 'viewer']);
const platformEnum = z.enum(['whatsapp', 'instagram', 'facebook']);
const toneEnum = z.enum(['friendly', 'professional', 'direct']);

export const createWorkspaceSchema = z.object({
	name: z.string().trim().min(2, 'Escribe el nombre de tu negocio').max(80),
	platform: platformEnum.default('whatsapp'),
	industry: z.string().trim().max(60).optional().default('Servicios profesionales'),
	language: z.enum(['es', 'en']).default('es'),
	autoReplyEnabled: z.boolean().optional().default(false),
	initialKnowledge: z.string().trim().max(4000).optional().default('')
});

export const messageAttachmentSchema = z.object({
	storage_path: z.string().trim().min(1).max(400),
	mime_type: z.string().trim().min(1).max(120),
	file_name: z.string().trim().min(1).max(160),
	size_bytes: z.coerce.number().int().min(1).max(10 * 1024 * 1024),
	kind: z.enum(['image', 'audio', 'file'])
});

export const sendMessageSchema = z
	.object({
		organizationId: z.string().min(1),
		conversationId: z.string().min(1),
		body: z.string().trim().max(4000).optional().default(''),
		retryMessageId: z.coerce.number().int().positive().optional(),
		attachment: messageAttachmentSchema.optional()
	})
	.refine((d) => d.body.length > 0 || Boolean(d.attachment), {
		message: 'Escribe un mensaje o adjunta un archivo antes de enviar',
		path: ['body']
	});

export const saveNoteSchema = z.object({
	organizationId: z.string().min(1),
	contactId: z.string().min(1),
	conversationId: z.string().optional().nullable(),
	body: z.string().trim().min(1, 'Escribe una nota antes de guardar').max(2000)
});

export const updateConversationSchema = z.object({
	organizationId: z.string().min(1),
	conversationId: z.string().min(1),
	assignedTo: z.string().nullable().optional(),
	status: z.enum(['open', 'pending', 'closed']).optional(),
	aiPaused: z.boolean().optional()
});

export const createDealSchema = z.object({
	organizationId: z.string().min(1),
	title: z.string().trim().min(2, 'Indica el nombre de la oportunidad').max(120),
	contactId: z.string().min(1),
	stageId: z.string().min(1),
	dealType: z.string().trim().min(1).max(60).default('Servicio'),
	valueAmount: z.coerce.number().min(0).max(100_000_000),
	ownerUserId: z.string().nullable().optional()
});

export const updateDealSchema = z.object({
	organizationId: z.string().min(1),
	dealId: z.string().min(1),
	stageId: z.string().min(1).optional(),
	contactId: z.string().min(1).optional(),
	dealType: z.string().trim().min(1).max(60).optional(),
	ownerUserId: z.string().nullable().optional(),
	nextStepTitle: z.string().trim().max(120).optional(),
	nextStepLabel: z.string().trim().max(60).optional()
});

export const createContactSchema = z.object({
	organizationId: z.string().min(1),
	name: z.string().trim().min(2, 'Escribe el nombre del contacto').max(100),
	company: z.string().trim().max(100).optional().default(''),
	email: z.string().trim().email('Correo no válido').or(z.literal('')).optional().default(''),
	phone: z.string().trim().max(40).optional().default(''),
	ownerUserId: z.string().nullable().optional(),
	nextStepTitle: z.string().trim().max(120).optional().default('Primer contacto'),
	nextStepAtLabel: z.string().trim().max(60).optional().default('Mañana')
});

export const updateContactSchema = z.object({
	organizationId: z.string().min(1),
	contactId: z.string().min(1),
	name: z.string().trim().min(2).max(100),
	company: z.string().trim().max(100).optional().default(''),
	roleTitle: z.string().trim().max(80).optional().default(''),
	email: z.string().trim().email('Correo no válido').or(z.literal('')).optional().default(''),
	phone: z.string().trim().max(40).optional().default(''),
	ownerUserId: z.string().nullable().optional(),
	nextStepTitle: z.string().trim().max(120).optional().default(''),
	nextStepAtLabel: z.string().trim().max(60).optional().default('')
});

export const inviteMemberSchema = z.object({
	organizationId: z.string().min(1),
	email: z.string().trim().email('Ingresa un correo válido'),
	role: inviteRoleEnum
});

export const updateMemberRoleSchema = z.object({
	organizationId: z.string().min(1),
	userId: z.string().min(1),
	role: roleEnum
});

export const requestRoleChangeSchema = z.object({
	organizationId: z.string().min(1),
	requestedRole: inviteRoleEnum.default('agent')
});

export const updateAiModeSchema = z.object({
	organizationId: z.string().min(1),
	autoReplyEnabled: z.boolean()
});

export const updateAiPreferencesSchema = z.object({
	organizationId: z.string().min(1),
	tone: toneEnum,
	autoQualifyEnabled: z.boolean(),
	maxAiRepliesPerThread: z.coerce.number().int().min(1).max(20),
	handoffRules: z.string().trim().max(1000),
	businessContext: z.string().trim().max(4000).optional()
});

export const updatePipelineRulesSchema = z.object({
	organizationId: z.string().min(1),
	rules: z.record(z.string(), z.string().trim().max(400))
});

export const addKnowledgeSchema = z.object({
	organizationId: z.string().min(1),
	sourceType: z.enum(['faq', 'text', 'file', 'url']),
	title: z.string().trim().max(140).optional().default(''),
	question: z.string().trim().max(300).optional().default(''),
	answer: z.string().trim().max(2000).optional().default(''),
	content: z.string().trim().max(6000).optional().default(''),
	url: z.string().trim().max(500).optional().default('')
});

export const updateKnowledgeSchema = z.object({
	organizationId: z.string().min(1),
	documentId: z.string().min(1),
	title: z.string().trim().min(1, 'Escribe un título para la fuente').max(140),
	content: z.string().trim().min(1, 'Escribe el contenido de la fuente').max(6000),
	url: z.string().trim().max(500).optional()
});

export const deleteKnowledgeSchema = z.object({
	organizationId: z.string().min(1),
	documentId: z.string().min(1)
});

export const aiDraftSchema = z.object({
	organizationId: z.string().min(1),
	conversationId: z.string().min(1)
});

export const aiSimulateSchema = z.object({
	organizationId: z.string().min(1),
	message: z.string().trim().min(1, 'Escribe un mensaje de prueba').max(1000),
	syncDemoLead: z.boolean().optional().default(true),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				text: z.string().trim().min(1).max(2000)
			})
		)
		.max(15)
		.optional()
		.default([])
});

export const aiSimulateResetSchema = z.object({
	organizationId: z.string().min(1)
});

export const channelActionSchema = z.object({
	organizationId: z.string().min(1),
	channelId: z.string().min(1).optional(),
	platform: platformEnum.optional()
});

export const updateWorkspaceSchema = z.object({
	organizationId: z.string().min(1),
	name: z.string().trim().min(2).max(80),
	industry: z.string().trim().min(2).max(80),
	currency: z.enum(['MXN', 'USD']),
	language: z.enum(['es', 'en'])
});

export const updateChannelSlotsSchema = z.object({
	organizationId: z.string().min(1),
	channelSlots: z.coerce.number().int().min(1).max(100)
});
