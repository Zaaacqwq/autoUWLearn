import assert from "node:assert/strict";
import test from "node:test";
import { detectLoginState, resolveAuthState } from "./authState.js";

const HOME = "https://learn.uwaterloo.ca/d2l/home";

/**
 * Three shapes a freshly completed login really takes, each of which the old
 * appearance-only state machine reported as logged out — which is what sent a
 * user who had just finished SSO back to do it again.
 */
const justLoggedIn: Array<[string, { url: string; title: string; bodyText: string }]> = [
  [
    "sitting on D2L's own post-login landing URL",
    { url: "https://learn.uwaterloo.ca/d2l/lp/auth/login/ProcessLoginActions.d2l", title: "", bodyText: "" }
  ],
  [
    "on the homepage, which JavaScript has not filled in yet",
    { url: HOME, title: "", bodyText: "" }
  ],
  [
    "on the homepage, whose title says Waterloo before the body says anything",
    { url: HOME, title: "University of Waterloo LEARN", bodyText: "" }
  ]
];

test("a working session is logged in, whatever the page looks like", () => {
  for (const [name, page] of justLoggedIn) {
    assert.equal(resolveAuthState({ sessionWorks: true, ...page }), "LOGGED_IN", name);
  }
});

test("each of those really would have been misread without the probe", () => {
  // Kept as a guard: it documents why appearance is only ever a hint.
  for (const [name, page] of justLoggedIn) {
    assert.notEqual(detectLoginState(page.url, page.title, page.bodyText), "LOGGED_IN", name);
  }
});

test("a page that looks logged in but does not work is a lapsed session", () => {
  const state = resolveAuthState({
    sessionWorks: false,
    url: HOME,
    title: "Homepage",
    bodyText: "My Courses"
  });

  assert.equal(state, "SESSION_EXPIRED");
});

test("when the session does not work the page explains what SSO is waiting for", () => {
  const cases: Array<[string, string]> = [
    ["Approve sign in request on your phone", "MFA_PUSH_WAITING"],
    ["Enter code from your authenticator", "MFA_CODE_REQUIRED"],
    ["Verify your identity with Duo", "MFA_REQUIRED"],
    ["Enter password to continue", "PASSWORD_REQUIRED"]
  ];

  for (const [bodyText, expected] of cases) {
    assert.equal(
      resolveAuthState({ sessionWorks: false, url: "https://adfs.uwaterloo.ca/", title: "", bodyText }),
      expected,
      bodyText
    );
  }
});

test("a browser that has not gone anywhere yet is unknown, not logged out", () => {
  assert.equal(
    resolveAuthState({ sessionWorks: false, url: "about:blank", title: "", bodyText: "" }),
    "UNKNOWN"
  );
});

test("the identity provider is reported as the login page", () => {
  assert.equal(
    resolveAuthState({
      sessionWorks: false,
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      title: "Sign in",
      bodyText: "Sign in"
    }),
    "LOGIN_PAGE"
  );
});
