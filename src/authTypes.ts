export type AuthState =
  | "UNKNOWN"
  | "LOGGED_IN"
  | "NOT_LOGGED_IN"
  | "LOGIN_PAGE"
  | "PASSWORD_REQUIRED"
  | "MFA_REQUIRED"
  | "MFA_PUSH_WAITING"
  | "MFA_CODE_REQUIRED"
  | "LOGIN_IN_PROGRESS"
  | "AUTH_FAILED"
  | "SESSION_EXPIRED";

export interface AuthStatus {
  ok: boolean;
  authenticated: boolean;
  state: AuthState;
  url: string;
  title: string;
  message: string;
  authUrl: string;
}

export function authRequired(status?: Partial<AuthStatus>) {
  return {
    ok: false,
    error: status?.state === "MFA_REQUIRED" || status?.state === "MFA_PUSH_WAITING" || status?.state === "MFA_CODE_REQUIRED"
      ? "MFA_REQUIRED"
      : "AUTH_REQUIRED",
    state: status?.state ?? "SESSION_EXPIRED",
    message:
      status?.message ??
      "UW LEARN session is missing or expired. Open the local auth page on the Mac mini and complete login/MFA, then ask again.",
    action: "Open the local auth page and complete Waterloo login/MFA.",
    authUrl: status?.authUrl ?? "http://127.0.0.1:8787/auth"
  };
}
