import type { AuthState } from "./authTypes.js";

/**
 * What the page looks like.
 *
 * Only ever a hint. Brightspace renders its homepage with JavaScript, so at
 * `domcontentloaded` the body of a perfectly good session is still a skeleton,
 * and the phrases that would identify it have not appeared yet. Never decide
 * "logged in" from this alone; see resolveAuthState.
 */
export function detectLoginState(url: string, title: string, bodyText: string): AuthState {
  const text = `${title}\n${bodyText}`.slice(0, 12_000);
  if (/\/d2l\/home/i.test(url) && /\b(My Courses|Course|Homepage|Brightspace)\b/i.test(text)) return "LOGGED_IN";
  if (/\/d2l\//i.test(url) && /\b(My Courses|Course|Brightspace|navbar|profile)\b/i.test(text)) return "LOGGED_IN";
  if (/\b(approve sign in request|approve.*phone|push notification|check your.*phone)\b/i.test(text)) {
    return "MFA_PUSH_WAITING";
  }
  if (/\b(enter code|verification code|code displayed|number shown|authenticator code)\b/i.test(text)) {
    return "MFA_CODE_REQUIRED";
  }
  if (/\b(Duo|Microsoft Authenticator|Verify your identity|multi-factor|multifactor|two-step|two factor)\b/i.test(text)) {
    return "MFA_REQUIRED";
  }
  if (/\b(password|enter password)\b/i.test(text) || /pwd|passwd|password/i.test(url)) return "PASSWORD_REQUIRED";
  if (/adfs|login\.microsoftonline|signin|saml|login/i.test(url) || /\b(sign in|University of Waterloo)\b/i.test(text)) {
    return "LOGIN_PAGE";
  }
  if (url === "about:blank") return "UNKNOWN";
  return "NOT_LOGGED_IN";
}

export interface AuthStateInput {
  /** Whether the browser's cookies actually authenticate a LEARN read. */
  readonly sessionWorks: boolean;
  readonly url: string;
  readonly title: string;
  readonly bodyText: string;
}

/**
 * Decides the session state, with the cookie probe as the only authority.
 *
 * Reading it off the page was wrong in both directions. A logged-in user whose
 * homepage had not finished rendering was reported as LOGIN_PAGE — the page
 * title carries "University of Waterloo" long before the body carries "My
 * Courses" — so a successful login looked like a failed one and the user was
 * sent back to log in again. In the other direction, markup left over from a
 * session that has since lapsed still reads as logged in.
 *
 * So ask the question that matters: do these cookies authenticate a read? That
 * is what every tool does, which makes this answer agree with them by
 * construction. The page is then only consulted to explain a failure — whether
 * SSO is waiting on a password, on Duo, or on nothing at all.
 */
export function resolveAuthState(input: AuthStateInput): AuthState {
  if (input.sessionWorks) return "LOGGED_IN";

  const appearance = detectLoginState(input.url, input.title, input.bodyText);
  // The probe has already said no, so a page that merely looks logged in is a
  // session that has lapsed since it was rendered.
  return appearance === "LOGGED_IN" ? "SESSION_EXPIRED" : appearance;
}

export function messageForState(state: AuthState): string {
  switch (state) {
    case "LOGGED_IN":
      return "UW LEARN session is active.";
    case "PASSWORD_REQUIRED":
      return "Complete Waterloo password entry in the opened browser window.";
    case "MFA_REQUIRED":
    case "MFA_PUSH_WAITING":
      return "Complete MFA in the opened browser window or approve the request on your phone.";
    case "MFA_CODE_REQUIRED":
      return "Enter the MFA verification code in the opened browser window.";
    case "LOGIN_PAGE":
    case "NOT_LOGGED_IN":
    case "SESSION_EXPIRED":
      return "UW LEARN login is required. Open the local auth page and complete Waterloo SSO/MFA.";
    default:
      return "UW LEARN auth state is unknown. Check the local auth page.";
  }
}
