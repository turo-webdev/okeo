import { describe, expect, it, vi } from 'vitest';
import { ingestKnowledgeSource } from '../knowledge-ingest';
import { extractTextFromHtml, fetchAndExtractPublicUrl } from '../rag';

describe('Knowledge Base HTML & URL anti-SSRF extraction', () => {
	it('strips scripts, styles, nav, and footer while extracting title and readable text', () => {
		const html = `
			<!doctype html>
			<html>
				<head>
					<title>Planes &amp; Precios — Okeo Club</title>
					<style>.secret { display: none; }</style>
				</head>
				<body>
					<nav><a href="/login">Entrar</a></nav>
					<main>
						<h1>Membresías 2026</h1>
						<p>Membresía pareja &mdash; $2,400 MXN/mes.</p>
						<p>Horario: Lunes a viernes de 6:00 a 22:00.</p>
					</main>
					<script>alert('xss')</script>
					<footer>Copyright 2026</footer>
				</body>
			</html>
		`;

		const extracted = extractTextFromHtml(html);
		expect(extracted.title).toBe('Planes & Precios — Okeo Club');
		expect(extracted.text).toContain('Membresías 2026');
		expect(extracted.text).toContain('Membresía pareja');
		expect(extracted.text).toContain('$2,400 MXN/mes.');
		expect(extracted.text).not.toContain('alert(');
		expect(extracted.text).not.toContain('Copyright 2026');
		expect(extracted.text).not.toContain('Entrar');
	});

	it('blocks private/loopback URLs and blocks redirects to cloud metadata IPs', async () => {
		await expect(fetchAndExtractPublicUrl('http://127.0.0.1:8080/admin')).rejects.toThrow(
			/privadas o locales/
		);

		const redirectFetch = vi.fn(async () => {
			return new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data/' }
			});
		});

		await expect(
			fetchAndExtractPublicUrl('https://public.example.com/pricing', redirectFetch)
		).rejects.toThrow(/privadas o locales/);

		const okFetch = vi.fn(async () => {
			return new Response(
				'<html><head><title>Catálogo Oficial</title></head><body><p>Plan básico mensual con soporte incluido.</p></body></html>',
				{
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' }
				}
			);
		});

		const res = await fetchAndExtractPublicUrl('https://public.example.com/catalogo', okFetch);
		expect(res.finalUrl).toBe('https://public.example.com/catalogo');
		expect(res.title).toBe('Catálogo Oficial');
		expect(res.text).toContain('Plan básico mensual');
	});
});

describe('Knowledge ingestion orchestrator (TXT & PDF multimodal)', () => {
	it('uploads TXT files to private knowledge-files bucket and decodes UTF-8 without calling PDF extractor', async () => {
		const orgId = '11111111-1111-4111-8111-111111111111';
		const uploadFile = vi.fn(async (p) => ({
			storagePath: `${p.organizationId}/${p.resourceId}/${p.fileName}`,
			fileName: p.fileName,
			sizeBytes: p.bytes.byteLength
		}));
		const extractPdf = vi.fn();
		const recordLedger = vi.fn();

		const bytes = new TextEncoder().encode('Política de devoluciones: 15 días hábiles con recibo.');
		const result = await ingestKnowledgeSource(
			{
				organizationId: orgId,
				sourceType: 'file',
				title: '',
				question: '',
				answer: '',
				content: '',
				url: '',
				file: { name: 'politicas.txt', mimeType: 'text/plain', bytes }
			},
			{ uploadFile, extractPdf, recordLedger }
		);

		expect(uploadFile).toHaveBeenCalledOnce();
		expect(uploadFile.mock.calls[0][0].bucket).toBe('knowledge-files');
		expect(extractPdf).not.toHaveBeenCalled();
		expect(recordLedger).not.toHaveBeenCalled();
		expect(result.title).toBe('politicas.txt');
		expect(result.subtitle).toBe('Archivo');
		expect(result.storagePath).toContain(`${orgId}/`);
		expect(result.fullText).toContain('Política de devoluciones');
	});

	it('extracts PDF text via Gemini callback and records embed usage in ledger', async () => {
		const orgId = '11111111-1111-4111-8111-111111111111';
		const uploadFile = vi.fn(async (p) => ({
			storagePath: `${p.organizationId}/${p.resourceId}/${p.fileName}`,
			fileName: p.fileName,
			sizeBytes: p.bytes.byteLength
		}));
		const extractPdf = vi.fn(async () => ({
			text: 'Catálogo 2026: Plan Pro $49 USD/mes con CRM completo.',
			model: 'gemini-2.5-flash',
			usage: { inputTokens: 420, outputTokens: 64 }
		}));
		const recordLedger = vi.fn(async () => undefined);

		const fakePdfBytes = new TextEncoder().encode('%PDF-1.4 fake binary bytes');
		const result = await ingestKnowledgeSource(
			{
				organizationId: orgId,
				sourceType: 'file',
				title: 'Catálogo 2026',
				question: '',
				answer: '',
				content: '',
				url: '',
				file: { name: 'catalogo.pdf', mimeType: 'application/pdf', bytes: fakePdfBytes }
			},
			{ uploadFile, extractPdf, recordLedger }
		);

		expect(uploadFile).toHaveBeenCalledOnce();
		expect(extractPdf).toHaveBeenCalledOnce();
		expect(recordLedger).toHaveBeenCalledWith({
			organizationId: orgId,
			action: 'embed',
			billableUnits: 0,
			model: 'gemini-2.5-flash',
			inputTokens: 420,
			outputTokens: 64
		});
		expect(result.title).toBe('Catálogo 2026');
		expect(result.subtitle).toBe('PDF');
		expect(result.fullText).toContain('Plan Pro $49 USD/mes');
	});

	it('rejects unsupported file formats and files larger than 10 MB', async () => {
		const orgId = '11111111-1111-4111-8111-111111111111';
		await expect(
			ingestKnowledgeSource({
				organizationId: orgId,
				sourceType: 'file',
				title: '',
				question: '',
				answer: '',
				content: '',
				url: '',
				file: {
					name: 'malware.exe',
					mimeType: 'application/x-msdownload',
					bytes: new Uint8Array([1, 2, 3])
				}
			})
		).rejects.toThrow(/Formato no compatible/);

		const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
		await expect(
			ingestKnowledgeSource({
				organizationId: orgId,
				sourceType: 'file',
				title: '',
				question: '',
				answer: '',
				content: '',
				url: '',
				file: { name: 'huge.pdf', mimeType: 'application/pdf', bytes: oversized }
			})
		).rejects.toThrow(/10 MB/);
	});
});
