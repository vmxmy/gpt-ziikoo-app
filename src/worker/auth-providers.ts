export type AuthProviders = {
	google: boolean;
	github: boolean;
};

function hasCredentials(id: string | undefined, secret: string | undefined): boolean {
	return Boolean(id?.trim() && secret?.trim());
}

/** Resolve which OAuth providers have both client ID and secret configured. */
export function resolveAuthProviders(env: Record<string, string | undefined>): AuthProviders {
	return {
		google: hasCredentials(env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET),
		github: hasCredentials(env.AUTH_GITHUB_CLIENT_ID, env.AUTH_GITHUB_CLIENT_SECRET),
	};
}
