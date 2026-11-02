// A small file to try Fork AI on. parseDate has a bug: months in JavaScript dates start at 0.

export function parseDate(text: string): Date {
	const [year, month, day] = text.split('-').map(Number);
	return new Date(year, month, day);
}

export function formatDate(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

export function daysBetween(a: Date, b: Date): number {
	const ms = Math.abs(b.getTime() - a.getTime());
	return Math.round(ms / 86_400_000);
}
