export const REDACTED = "[REDACTED]";
export const MIN_KEY_LENGTH = 8;

export function redact(text: string, key: string): string {
	if (key.length < MIN_KEY_LENGTH) return text;
	return text.split(`Bearer ${key}`).join(REDACTED).split(key).join(REDACTED);
}
