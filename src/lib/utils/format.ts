export function formatMoneyCents(cents: number, currency = 'MXN'): string {
	const whole = Math.round(cents / 100);
	return `$${whole.toLocaleString('en-US')} ${currency}`;
}

export function formatMoneyShort(cents: number, currency = 'MXN'): string {
	const whole = Math.round(cents / 100);
	return `$${whole.toLocaleString('en-US')}`;
}

export function formatCurrencyName(cents: number, currency = 'MXN'): string {
	return `${formatMoneyShort(cents, currency)} ${currency}`;
}

export function formatRoleLabel(role: string): string {
	switch (role) {
		case 'owner':
			return 'Owner';
		case 'admin':
			return 'Admin';
		case 'agent':
			return 'Agente';
		case 'viewer':
			return 'Solo lectura';
		default:
			return role;
	}
}

export function formatPlatformLabel(platform: string): string {
	switch (platform) {
		case 'whatsapp':
			return 'WhatsApp';
		case 'instagram':
			return 'Instagram';
		case 'facebook':
			return 'Messenger';
		default:
			return platform;
	}
}
