import { createContext } from "preact";
import { useContext } from "preact/hooks";

export const PRIVACY_KEY = "gpt.privacy.v1";
export const HIDDEN_SITE = "站点已隐藏";
const HIDDEN_FILE_HOST = "hidden-site";

export const privacyFromStorage = (value: string | null): boolean => value !== "off";

export function loadPrivacy(): boolean {
	try {
		return privacyFromStorage(localStorage.getItem(PRIVACY_KEY));
	} catch {
		return true;
	}
}

export function savePrivacy(on: boolean): boolean {
	try {
		localStorage.setItem(PRIVACY_KEY, on ? "on" : "off");
		return true;
	} catch {
		return false;
	}
}

export const PrivacyContext = createContext(true);

export const usePrivacy = (): boolean => useContext(PrivacyContext);

export const siteLabel = (host: string, privacy: boolean): string => (privacy ? HIDDEN_SITE : host);

export const fileHost = (host: string, privacy: boolean): string => (privacy ? HIDDEN_FILE_HOST : host);

export const privateInputClass = (privacy: boolean): string | undefined => (privacy ? "private-input" : undefined);
