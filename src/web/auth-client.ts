import { createAuthClient } from "void/client";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
	plugins: [emailOTPClient()],
});
