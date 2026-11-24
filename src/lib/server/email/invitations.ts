import { env } from '$env/dynamic/private';
import type { OrgRole } from '$lib/types/domain';
import { formatRoleLabel } from '$lib/utils/format';

export interface InvitationEmailDelivery {
	sent: boolean;
	provider: 'resend' | 'none';
	messageId?: string;
	error?: string;
}

export function isEmailDeliveryConfigured(): boolean {
	return Boolean(env.RESEND_API_KEY?.trim());
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Envía el correo transaccional de invitación al equipo mediante Resend REST API (`fetch` nativo para CF Workers).
 */
export async function sendTeamInvitationEmail(
	params: {
		toEmail: string;
		organizationName: string;
		invitedByName: string;
		role: Exclude<OrgRole, 'owner'>;
		inviteUrl: string;
		expiresAt: string;
	},
	customFetch: typeof fetch = fetch
): Promise<InvitationEmailDelivery> {
	const apiKey = env.RESEND_API_KEY?.trim();
	if (!apiKey) {
		return { sent: false, provider: 'none' };
	}

	const fromAddress = env.EMAIL_FROM?.trim() || 'Okeo <invitaciones@okeo.ai>';
	const roleLabel = formatRoleLabel(params.role);
	const expiresDate = new Date(params.expiresAt);
	const expiresText = Number.isNaN(expiresDate.getTime())
		? '7 días'
		: expiresDate.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

	const safeOrg = escapeHtml(params.organizationName);
	const safeInviter = escapeHtml(params.invitedByName);
	const safeRole = escapeHtml(roleLabel);
	const safeUrl = escapeHtml(params.inviteUrl);
	const safeExpires = escapeHtml(expiresText);

	const subject = `${params.invitedByName} te invitó a ${params.organizationName} en Okeo`;
	const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f8f8f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1c1a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #eaeae4;border-radius:12px;padding:28px;">
      <tr>
        <td>
          <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:0.06em;color:#3b6342;text-transform:uppercase;">Okeo</p>
          <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#1c1c1a;">Te invitaron a ${safeOrg}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#666660;">
            <strong>${safeInviter}</strong> te invitó a unirte al workspace <strong>${safeOrg}</strong> con el rol de <strong>${safeRole}</strong>.
          </p>
          <p style="margin:24px 0;">
            <a href="${safeUrl}" style="display:inline-block;background:#1e1e1c;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:12px 20px;border-radius:8px;">
              Aceptar invitación
            </a>
          </p>
          <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#8e8e86;">
            Si el botón no funciona, copia y pega este enlace en tu navegador:<br />
            <a href="${safeUrl}" style="color:#3b6342;word-break:break-all;">${safeUrl}</a>
          </p>
          <p style="margin:16px 0 0;font-size:12px;color:#8e8e86;">
            Este enlace vence el ${safeExpires}.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

	const text = [
		`${params.invitedByName} te invitó a unirte a "${params.organizationName}" en Okeo como ${roleLabel}.`,
		'',
		`Acepta la invitación aquí: ${params.inviteUrl}`,
		'',
		`Este enlace vence el ${expiresText}.`
	].join('\n');

	try {
		const res = await customFetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from: fromAddress,
				to: [params.toEmail],
				subject,
				html,
				text
			}),
			signal: AbortSignal.timeout(10_000)
		});

		const payload = (await res.json().catch(() => ({}))) as {
			id?: string;
			message?: string;
			error?: { message?: string };
		};

		if (!res.ok) {
			return {
				sent: false,
				provider: 'resend',
				error: payload?.message || payload?.error?.message || `Error Resend HTTP ${res.status}`
			};
		}

		return {
			sent: true,
			provider: 'resend',
			messageId: payload.id
		};
	} catch (err) {
		return {
			sent: false,
			provider: 'resend',
			error: err instanceof Error ? err.message : 'Error de red enviando correo con Resend'
		};
	}
}
