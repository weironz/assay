import { apiOrigin } from "./api";
import { SecurityRequestError } from "./security-step-up";
export type LoginOptions = {
  registrationEnabled: boolean;
  directoryEnabled: boolean;
};
export class LoginError extends SecurityRequestError {
  constructor(
    status: number,
    readonly code?: "EMAIL_NOT_VERIFIED" | "DIRECTORY_LINK_REQUIRED",
  ) {
    super(status);
  }
}
export const loginOptions = async (): Promise<LoginOptions> => {
  const response = await fetch(`${apiOrigin}/api/auth/login/options`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new LoginError(response.status);
  return response.json();
};
export async function unifiedSignIn(
  username: string,
  password: string,
  rememberMe: boolean,
  code?: string,
  emergency = false,
): Promise<{
  twoFactorRequired?: boolean;
  twoFactorRedirect?: boolean;
  filesConnected?: boolean;
  destination?: string;
}> {
  const response = await fetch(
    `${apiOrigin}/api/auth/sign-in/${emergency ? "local-admin" : "unified"}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        rememberMe,
        ...(code ? { code } : {}),
      }),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const safeCode =
      response.status === 403 &&
      ["EMAIL_NOT_VERIFIED", "DIRECTORY_LINK_REQUIRED"].includes(body?.code)
        ? body.code
        : undefined;
    throw new LoginError(response.status, safeCode);
  }
  return response.json();
}
