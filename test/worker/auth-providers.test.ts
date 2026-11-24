import { describe, expect, it } from "vitest";
import { resolveAuthProviders } from "../../src/worker/auth-providers.ts";

describe("resolveAuthProviders", () => {
	it("returns false for both providers when neither is set", () => {
		expect(resolveAuthProviders({})).toEqual({ google: false, github: false });
	});

	it("enables only Google when only Google credentials are set", () => {
		expect(
			resolveAuthProviders({
				AUTH_GOOGLE_CLIENT_ID: "google-id",
				AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
			}),
		).toEqual({ google: true, github: false });
	});

	it("enables only GitHub when only GitHub credentials are set", () => {
		expect(
			resolveAuthProviders({
				AUTH_GITHUB_CLIENT_ID: "github-id",
				AUTH_GITHUB_CLIENT_SECRET: "github-secret",
			}),
		).toEqual({ google: false, github: true });
	});

	it("ignores partial credentials when only client ID or secret is set", () => {
		expect(
			resolveAuthProviders({
				AUTH_GOOGLE_CLIENT_ID: "google-id",
				AUTH_GITHUB_CLIENT_SECRET: "github-secret",
			}),
		).toEqual({ google: false, github: false });
		expect(
			resolveAuthProviders({
				AUTH_GOOGLE_CLIENT_ID: "google-id",
				AUTH_GOOGLE_CLIENT_SECRET: "   ",
				AUTH_GITHUB_CLIENT_ID: "",
				AUTH_GITHUB_CLIENT_SECRET: "github-secret",
			}),
		).toEqual({ google: false, github: false });
	});

	it("enables both providers when both credential pairs are set", () => {
		expect(
			resolveAuthProviders({
				AUTH_GOOGLE_CLIENT_ID: "google-id",
				AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
				AUTH_GITHUB_CLIENT_ID: "github-id",
				AUTH_GITHUB_CLIENT_SECRET: "github-secret",
			}),
		).toEqual({ google: true, github: true });
	});
});
