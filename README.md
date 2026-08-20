# garmin-mcp

Remote MCP server for Garmin Connect on Cloudflare Workers (free tier). Full TypeScript port of
[taxuspt/garmin_mcp](https://github.com/taxuspt/garmin_mcp): all 138 tools plus a `garmin_get`
passthrough (139 total) and the 5 workout template/reference MCP resources.

Modules: activity management (21), health & wellness (29), training & performance (15),
workouts + builders (19), nutrition (14), challenges/devices/gear (18), weight/body/women's
health/courses (14), FIT-file analysis (4), user profile (4), passthrough (1).

Auth: the server is an OAuth 2.1 authorization server (via `@cloudflare/workers-oauth-provider`).
Adding it to an MCP client opens a browser page where you enter your Garmin email and password
(and an MFA code if your account uses 2FA). The Worker runs Garmin's SSO web-widget login flow
server-side — the one login path that isn't bot-blocked from datacenter IPs — obtains a
long-lived (~1 year) OAuth1 token, discards your credentials, and stores only that token
encrypted in the grant. It then mints short-lived OAuth2 bearers on demand for
`connectapi.garmin.com`. A "paste a token" fallback (via the local script below) is tucked
behind a details toggle in case Garmin ever starts blocking server-side login.

## Deploy

1. `npm install`
2. `npx wrangler kv namespace create OAUTH_KV` — paste the id into `wrangler.jsonc`
3. `npx wrangler deploy`

## Connect a client

```sh
claude mcp add garmin --transport http https://garmin-mcp.<your-subdomain>.workers.dev/mcp
```

Claude Code opens the authorization page in your browser; follow its two steps. claude.ai web:
Settings → Connectors → Add custom connector with the same URL. Claude Desktop and other
stdio-only clients: `mcp-remote` handles the OAuth flow too.

Access is OAuth-only — there is no raw-header path. Every `/mcp` request is gated on a
provider-issued access token, and an access token is minted only by completing the login flow.

## Locking to your own account

Set `OWNER_GARMIN_IDS` in `wrangler.jsonc` to your Garmin `displayName` (the value
`get_user_profile` returns) — a comma-separated allowlist. Any login for a Garmin account not on
the list is rejected at the authorize step, so strangers can't use your deployment even with
their own valid Garmin credentials. Leave it empty to allow any Garmin account.

## Deviations from the original (remote/serverless adaptations)

- `download_activity_file` returns file content inline (fit as base64, gpx/tcx/csv as text, size-capped) instead of writing to local disk; `set_fit_download_dir` is a documented no-op.
- `upload_course` takes `gpx_content` (GPX XML text) instead of a local file path.
- `get_activity_fit_data` covers session/laps/records + power analysis (NP, VI, power curve, W/kg); the original's Di2 shift, climb-detection, and HRV analytics are not ported.
- Free-tier subrequest budget (~50/invocation): `get_training_load_trend` capped at 45 days (was 90), `get_power_duration_curve` at 15 activities (was 20), `get_hrv_trend` uses the range endpoint in one call, goal/step/menstrual pagination loops capped.
- Tools return JSON objects rather than pre-serialized strings; errors surface as MCP tool errors.

## Notes

- The Garmin token is stored encrypted inside the grant in Workers KV; when it expires (~1 year), tool calls start failing — reauthenticate the server in your client to run the flow again.
- Access tokens are bearer credentials: whoever holds a valid one has your data until it expires, so the security rests on your MCP client keeping its stored token secret.
- Local dev: `npm run dev`, then point a client at `http://localhost:8787/mcp`.
