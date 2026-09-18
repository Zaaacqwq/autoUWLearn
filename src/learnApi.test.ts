import assert from "node:assert/strict";
import test from "node:test";
import { createLearnApi, LearnAuthError, LearnPermissionError, LearnHttpError } from "./learnApi.js";

const versionsPayload = [
  { ProductCode: "le", LatestVersion: "1.95" },
  { ProductCode: "lp", LatestVersion: "1.61" }
];

interface StubCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** Builds a fetch stub driven by a url -> response table. */
function stubFetch(routes: Array<[RegExp, () => Response]>) {
  const calls: StubCall[] = [];
  let inFlight = 0;
  let peakInFlight = 0;

  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    );
    calls.push({ url, headers });

    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;

    for (const [pattern, respond] of routes) {
      if (pattern.test(url)) return respond();
    }
    throw new Error(`no stub route for ${url}`);
  }) as unknown as typeof fetch;

  return { impl, calls, peak: () => peakInFlight };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status: number) =>
  new Response("<html>Not Authorized</html>", { status, headers: { "content-type": "text/html" } });

const versionsRoute: [RegExp, () => Response] = [/\/d2l\/api\/versions\//, () => json(versionsPayload)];
const whoamiAlive: [RegExp, () => Response] = [/users\/whoami/, () => json({ Identifier: "123" })];
const whoamiDead: [RegExp, () => Response] = [/users\/whoami/, () => html(403)];

function api(routes: Array<[RegExp, () => Response]>, options: Record<string, unknown> = {}) {
  const stub = stubFetch(routes);
  const client = createLearnApi({
    baseUrl: "https://learn.uwaterloo.ca",
    cookieHeader: () => "d2lSessionVal=a; d2lSecureSessionVal=b",
    fetchImpl: stub.impl,
    retryDelayMs: () => 0,
    ...options
  });
  return { client, stub };
}

test("sends the session cookies and does not send a CSRF header on reads", async () => {
  const { client, stub } = api([versionsRoute, [/grades/, () => json([])]]);
  await client.grades(123);

  const call = stub.calls.find((c) => c.url.includes("grades"));
  assert.ok(call);
  assert.equal(call.headers.cookie, "d2lSessionVal=a; d2lSecureSessionVal=b");
  assert.equal(call.headers["x-csrf-token"], undefined, "GET requests do not require a CSRF token");
});

test("discovers the API version once and reuses it", async () => {
  const { client, stub } = api([versionsRoute, [/grades|dropbox/, () => json([])]]);

  await client.grades(1);
  await client.assignments(1);
  await client.grades(2);

  const versionCalls = stub.calls.filter((c) => c.url.includes("/d2l/api/versions/"));
  assert.equal(versionCalls.length, 1, "version discovery should be cached");
  assert.ok(stub.calls.some((c) => c.url.includes("/d2l/api/le/1.95/1/grades/values/myGradeValues/")));
});

test("an expired session raises LearnAuthError, confirmed via whoami", async () => {
  const { client } = api([versionsRoute, whoamiDead, [/grades/, () => html(403)]]);
  await assert.rejects(() => client.grades(123), LearnAuthError);
});

test("a 403 on a live session is a permission error, not an auth error", async () => {
  // Hitting an org unit you are not enrolled in also answers 403. Only whoami
  // can tell the two apart, so the client must not report a false logout.
  const { client } = api([versionsRoute, whoamiAlive, [/grades/, () => html(403)]]);
  await assert.rejects(() => client.grades(999), LearnPermissionError);
});

test("retries transient failures and then succeeds", async () => {
  let attempts = 0;
  const { client } = api([
    versionsRoute,
    [
      /grades/,
      () => {
        attempts += 1;
        return attempts < 3 ? json({ error: "boom" }, 503) : json([{ DisplayedGrade: "5 / 5" }]);
      }
    ]
  ]);

  const grades = await client.grades(1);
  assert.equal(attempts, 3);
  assert.equal((grades as unknown[]).length, 1);
});

test("gives up after maxRetries and reports the status", async () => {
  const { client } = api([versionsRoute, [/grades/, () => json({}, 500)]], { maxRetries: 2 });
  await assert.rejects(() => client.grades(1), (error: unknown) => {
    assert.ok(error instanceof LearnHttpError);
    assert.equal(error.status, 500);
    return true;
  });
});

test("does not retry a 404", async () => {
  let attempts = 0;
  const { client } = api([
    versionsRoute,
    [/grades/, () => { attempts += 1; return json({}, 404); }]
  ]);

  await assert.rejects(() => client.grades(1), LearnHttpError);
  assert.equal(attempts, 1, "a 404 is not transient");
});

test("bounds concurrency so the school's servers are not hammered", async () => {
  const { client, stub } = api([versionsRoute, [/news/, () => json([])]], { concurrency: 3 });

  await client.warmUp();
  await Promise.all(Array.from({ length: 12 }, (_, i) => client.announcements(i)));

  assert.ok(stub.peak() <= 3, `peak in-flight was ${stub.peak()}, expected <= 3`);
});

/* Session rotation and the shapes a lapsed session actually arrives in. */

test("every Set-Cookie LEARN returns is handed to the jar", async () => {
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [
      /whoami/,
      () =>
        new Response(JSON.stringify({ Identifier: "1" }), {
          status: 200,
          headers: [
            ["content-type", "application/json"],
            ["set-cookie", "d2lSessionVal=rotated; path=/; HttpOnly"],
            ["set-cookie", "d2lSecureSessionVal=rotated2; path=/; Secure"]
          ]
        })
    ]
  ]);

  const absorbed: string[][] = [];
  await createLearnApi({
    cookieHeader: () => "d2lSessionVal=old; d2lSecureSessionVal=old",
    fetchImpl: stub.impl,
    onSetCookie: (headers) => absorbed.push([...headers])
  }).whoami();

  assert.deepEqual(absorbed.at(-1), [
    "d2lSessionVal=rotated; path=/; HttpOnly",
    "d2lSecureSessionVal=rotated2; path=/; Secure"
  ]);
});

test("a response that rotates nothing does not disturb the jar", async () => {
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [/whoami/, () => json({ Identifier: "1" })]
  ]);

  let calls = 0;
  await createLearnApi({
    cookieHeader: () => "d2lSessionVal=old",
    fetchImpl: stub.impl,
    onSetCookie: () => {
      calls += 1;
    }
  }).whoami();

  assert.equal(calls, 0);
});

test("a JSON read bounced to SSO is a lapsed session, not an opaque 302", async () => {
  // LEARN redirects an unauthenticated API request to the identity provider.
  // Reported as "LEARN answered 302" it is actionable by nobody.
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [
      /whoami/,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://login.microsoftonline.com/saml2" }
        })
    ]
  ]);

  await assert.rejects(
    () => createLearnApi({ cookieHeader: () => "stale", fetchImpl: stub.impl }).whoami(),
    LearnAuthError
  );
});

test("an HTML read that lands on the login page is a lapsed session too", async () => {
  // fetchHtml follows redirects, so expiry arrives as a 200 whose body is the
  // Waterloo login page rather than the list page that was asked for.
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [
      /quizzes_list/,
      () =>
        Object.defineProperty(new Response("<html>Sign in</html>", { status: 200 }), "url", {
          value: "https://login.microsoftonline.com/common/oauth2/authorize"
        })
    ]
  ]);

  await assert.rejects(
    () => createLearnApi({ cookieHeader: () => "stale", fetchImpl: stub.impl }).fetchHtml("/d2l/lms/quizzing/quizzes_list"),
    LearnAuthError
  );
});

test("a 304 is not mistaken for a redirect to SSO", async () => {
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [/whoami/, () => new Response(null, { status: 304 })]
  ]);

  await assert.rejects(
    () => createLearnApi({ cookieHeader: () => "live", fetchImpl: stub.impl }).whoami(),
    LearnHttpError
  );
});

test("a LEARN path that merely contains 'login' is still a LEARN page", async () => {
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [
      /enforced/,
      () =>
        Object.defineProperty(new Response("pdf", { status: 200 }), "url", {
          value: "https://learn.uwaterloo.ca/content/enforced/1/week3-login-security.pdf"
        })
    ]
  ]);

  const file = await createLearnApi({ cookieHeader: () => "live", fetchImpl: stub.impl }).fetchFile(
    "/content/enforced/1/week3-login-security.pdf"
  );
  assert.equal(file.bytes.byteLength, 3);
});

test("a genuine LEARN page is not mistaken for the login page", async () => {
  const stub = stubFetch([
    [/versions/, () => json(versionsPayload)],
    [
      /quizzes_list/,
      () =>
        Object.defineProperty(new Response("<html>Quizzes</html>", { status: 200 }), "url", {
          value: "https://learn.uwaterloo.ca/d2l/lms/quizzing/user/quizzes_list.d2l?ou=1"
        })
    ]
  ]);

  const body = await createLearnApi({ cookieHeader: () => "live", fetchImpl: stub.impl }).fetchHtml(
    "/d2l/lms/quizzing/quizzes_list"
  );
  assert.match(body, /Quizzes/);
});
