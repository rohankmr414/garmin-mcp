import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { exchange, api, type OAuth1Token } from "./garmin";
import { ssoStart, ssoCompleteMfa, type MfaState } from "./sso";

interface AuthEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  // comma-separated Garmin displayName allowlist; empty/unset = open to any Garmin account
  OWNER_GARMIN_IDS?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STYLE = `<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fafafa}
  @media(prefers-color-scheme:dark){body{color:#eee;background:#111}input,textarea,details{background:#1d1d1d!important;color:#eee;border-color:#333!important}}
  label{display:block;font-weight:600;margin:1rem 0 .3rem}
  input,textarea{width:100%;font-size:1rem;border:1px solid #ccc;border-radius:6px;padding:.6rem;box-sizing:border-box}
  textarea{font-family:monospace;font-size:.8rem;height:5rem}
  button{margin-top:1.2rem;background:#0a7;color:#fff;border:0;border-radius:6px;padding:.7rem 1.6rem;font-size:1rem;cursor:pointer}
  .err{background:#fee;color:#900;border:1px solid #e99;border-radius:6px;padding:.6rem;margin:1rem 0}
  .note{font-size:.85rem;opacity:.7}
  details{margin-top:2rem;border:1px solid #ddd;border-radius:6px;padding:.6rem .8rem}
  summary{cursor:pointer;font-size:.9rem}
  pre{background:#f0f0f0;border-radius:6px;padding:.6rem;overflow-x:auto;font-size:.72rem;white-space:pre-wrap;word-break:break-all}
</style>`;

function shell(title: string, inner: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${STYLE}</head><body>${inner}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

const TOKEN_ONELINER = `uvx --with garth==0.6.3 python -c "import garth,base64,getpass,os; garth.client.sess.headers.update({'User-Agent':'Mozilla/5.0'}); garth.login(input('Garmin email: '),getpass.getpass('Password: ')); d=os.path.expanduser('~/.garminconnect'); garth.save(d); print('Token: ' + base64.b64encode(open(d+'/oauth1_token.json','rb').read()).decode())"`;

function loginPage(clientName: string, action: string, error?: string): Response {
  return shell(
    "Connect Garmin",
    `<h2>Connect your Garmin account</h2>
<p><b>${esc(clientName)}</b> wants to access your Garmin Connect data through this MCP server.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="${esc(action)}">
  <input type="hidden" name="step" value="password">
  <label>Garmin email</label>
  <input type="email" name="email" autocomplete="username" required autofocus>
  <label>Password</label>
  <input type="password" name="password" autocomplete="current-password" required>
  <button type="submit">Connect Garmin</button>
</form>
<details><summary>Have two-factor auth? It'll ask for your code next. Trouble logging in? Paste a token instead.</summary>
<p class="note">Run this locally (needs <a href="https://docs.astral.sh/uv/">uv</a>), then paste what it prints:</p>
<pre>${esc(TOKEN_ONELINER)}</pre>
<form method="post" action="${esc(action)}">
  <input type="hidden" name="step" value="token">
  <textarea name="token" placeholder="eyJvYXV0aF90b2tlbiI6..." required></textarea>
  <button type="submit">Connect with token</button>
</form></details>
<p class="note" style="margin-top:2rem">Credentials are sent once to this server to log in to Garmin, then discarded — only the resulting access token is kept, encrypted, in your authorization grant (expires ~1 year).</p>`
  );
}

function mfaPage(action: string, nonce: string, error?: string): Response {
  return shell(
    "Enter MFA code",
    `<h2>Two-factor code</h2>
<p>Enter the code Garmin just sent you (or from your authenticator app).</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="${esc(action)}">
  <input type="hidden" name="step" value="mfa">
  <input type="hidden" name="nonce" value="${esc(nonce)}">
  <label>MFA code</label>
  <input name="mfa_code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
  <button type="submit">Verify</button>
</form>`
  );
}

function parseTokenBlob(input: string): OAuth1Token {
  const cleaned = input
    .trim()
    .replace(/^Token:\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
  let tok: OAuth1Token;
  try {
    tok = JSON.parse(atob(cleaned));
  } catch {
    throw new Error("That doesn't look like a token — paste the base64 string the command printed.");
  }
  if (!tok.oauth_token || !tok.oauth_token_secret)
    throw new Error("Token is missing oauth_token/oauth_token_secret fields.");
  return tok;
}

async function finish(
  env: AuthEnv,
  oauthRequest: AuthRequest,
  oauth1: OAuth1Token
): Promise<Response> {
  const oauth2 = await exchange(oauth1); // proves the token works before storing it
  const profile = (await api(oauth2.access_token, "/userprofile-service/socialProfile")) as {
    displayName: string;
    fullName?: string;
  };
  const allow = (env.OWNER_GARMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(profile.displayName)) {
    throw new Error("This server is private — only its owner's Garmin account can connect.");
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: profile.displayName,
    metadata: { fullName: profile.fullName ?? "" },
    scope: oauthRequest.scope,
    props: { oauth1 },
  });
  return Response.redirect(redirectTo, 302);
}

async function handleAuthorize(request: Request, env: AuthEnv): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return new Response(error.description, { status: 400 });
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const clientName = client?.clientName ?? oauthRequest.clientId;
  const u = new URL(request.url);
  const action = u.pathname + u.search; // re-post here so OAuth query params survive

  if (request.method !== "POST") return loginPage(clientName, action);

  const form = await request.formData();
  const step = String(form.get("step") ?? "password");

  try {
    if (step === "token") {
      return await finish(env, oauthRequest, parseTokenBlob(String(form.get("token") ?? "")));
    }

    if (step === "mfa") {
      const nonce = String(form.get("nonce") ?? "");
      const raw = await env.OAUTH_KV.get(`mfa:${nonce}`);
      if (!raw) return loginPage(clientName, action, "Your session expired. Please log in again.");
      const result = await ssoCompleteMfa(JSON.parse(raw) as MfaState, String(form.get("mfa_code") ?? ""));
      if (result.status !== "success")
        return mfaPage(action, nonce, result.status === "error" ? result.message : "MFA failed.");
      await env.OAUTH_KV.delete(`mfa:${nonce}`);
      return await finish(env, oauthRequest, result.oauth1);
    }

    // step === "password"
    const result = await ssoStart(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
    if (result.status === "error") return loginPage(clientName, action, result.message);
    if (result.status === "needs_mfa") {
      const nonce = crypto.randomUUID();
      await env.OAUTH_KV.put(`mfa:${nonce}`, JSON.stringify(result.state), { expirationTtl: 300 });
      return mfaPage(action, nonce);
    }
    return await finish(env, oauthRequest, result.oauth1);
  } catch (e) {
    return loginPage(clientName, action, e instanceof Error ? e.message : String(e));
  }
}

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/") {
      return new Response(
        "garmin-mcp: remote MCP server for Garmin Connect. MCP endpoint: /mcp (OAuth or raw token header).",
        { headers: { "Content-Type": "text/plain" } }
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
