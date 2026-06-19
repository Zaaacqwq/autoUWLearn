# autoUWLearn

Read-only MCP server for fetching Waterloo LEARN / Brightspace content through an authenticated Playwright persistent browser session.

The server does not store Waterloo passwords. It opens LEARN in a persistent local browser profile, lets you complete SSO/MFA manually, and then reuses that browser session for authenticated requests.

## Setup

```bash
npm install
npm run build
```

Optional environment variables:

```bash
LEARN_BASE_URL=https://learn.uwaterloo.ca
LEARN_PROFILE_DIR=~/.uwlearn-mcp/playwright-profile
LEARN_DOWNLOAD_DIR=~/.uwlearn-mcp/downloads
LEARN_HEADLESS=false
LEARN_MCP_PUBLIC_BASE_URL=https://mcp.example.com
LEARN_MCP_RESOURCE_URL=https://mcp.example.com/mcp
LEARN_MCP_OAUTH_PASSWORD=choose-a-private-oauth-password
LEARN_AUTH_URL=http://127.0.0.1:8787/auth
```

Keep `LEARN_HEADLESS=false` for first login/debug. After the browser profile is authenticated, you can run normal MCP reads with `LEARN_HEADLESS=true`; if the session expires, use the local auth page again.

## Local auth page

The auth UI is local-only:

```text
http://127.0.0.1:8787/auth
```

It starts the persistent Playwright browser, navigates to UW LEARN, and waits while you manually complete Waterloo SSO/MFA. It does not ask ChatGPT for your UW password and does not store your UW password.

If you are not sitting at the Mac mini, use SSH port forwarding:

```bash
ssh -L 8787:127.0.0.1:8787 mac
```

Then open `http://127.0.0.1:8787/auth` on your current machine.

## Run

```bash
npm run dev
```

For MCP clients, use the built stdio server:

```bash
npm run build
node dist/server.js
```

Example MCP client command:

```json
{
  "command": "node",
  "args": ["/Users/user/Documents/Code/autoUWLearn/dist/server.js"],
  "env": {
    "LEARN_HEADLESS": "false"
  }
}
```

## Tools

- `learn_auth_status`
- `learn_auth_start`
- `learn_auth_reset`
- `learn_login` alias for starting manual auth
- `learn_list_courses`
- `learn_find_course`
- `learn_due_items`
- `learn_latest_announcements`
- `learn_course_dashboard`
- `learn_all_courses_dashboard`
- `learn_get_course_home`
- `learn_list_content`
- `learn_get_content_item`
- `learn_download_content_file`
- `learn_list_announcements`
- `learn_list_grades`
- `learn_list_calendar`
- `learn_list_assignments`
- `learn_list_quizzes`
- `learn_list_discussions`
- `learn_fetch_page`

All tools are read-only against LEARN. `learn_download_content_file` only downloads authenticated `/content/enforced/...` file URLs from `learn.uwaterloo.ca` into `.local/learn-downloads`.

## Natural-language workflows

The high-level tools are designed for prompts like:

```text
Is anything due in the next two weeks?
What is the latest announcement for ECE 350?
Give me a dashboard for ECE 327.
Which ECE 380 course do you mean?
```

Recommended tool mapping:

- Use `learn_find_course` to resolve names like `ECE 350`.
- Use `learn_due_items` for “what is due?”; it defaults to the next 14 days.
- Use `learn_latest_announcements` for one course’s recent visible announcements.
- Use `learn_course_dashboard` for one course summary.
- Use `learn_all_courses_dashboard` for all active visible courses.

Ambiguous course names return choices instead of silently picking a section.

## OpenClaw or other local MCP clients

Use the same stdio server configuration:

```json
{
  "mcpServers": {
    "autouwlearn": {
      "command": "node",
      "args": ["/Users/user/Documents/Code/autoUWLearn/dist/server.js"],
      "env": {
        "LEARN_HEADLESS": "false",
        "LEARN_BASE_URL": "https://learn.uwaterloo.ca",
        "LEARN_PROFILE_DIR": "/Users/user/Documents/Code/autoUWLearn/.local/learn-browser-profile",
        "LEARN_DOWNLOAD_DIR": "/Users/user/Documents/Code/autoUWLearn/.local/learn-downloads"
      }
    }
  }
}
```

Use the local auth page once, complete Waterloo SSO/MFA, then use the high-level tools. If the session expires, tools return `AUTH_REQUIRED` with the local auth URL.

## ChatGPT note

ChatGPT custom MCP apps/connectors currently require eligible ChatGPT plans and a remote MCP server/app deployment. This project is a local stdio MCP server, so direct ChatGPT use needs a later remote wrapper or deployment step. The tool schemas and read-only behavior here are intended to be reusable for that wrapper.
