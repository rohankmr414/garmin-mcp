import OAuth from "oauth-1.0a";
import { createHmac } from "node:crypto";
import { getConsumer, type OAuth1Token } from "./garmin";

// Garth 0.6.3 web-widget login flow, ported to fetch. This flow (unlike the mobile
// endpoint) is not bot-blocked from datacenter IPs — verified against Garmin from the Worker.
const SSO = "https://sso.garmin.com/sso";
const EMBED = `${SSO}/embed`;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MOBILE_UA = "com.garmin.android.apps.connectmobile";

const EMBED_PARAMS = { id: "gauth-widget", embedWidget: "true", gauthHost: SSO };
const SIGNIN_PARAMS = {
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: EMBED,
  service: EMBED,
  source: EMBED,
  redirectAfterAccountLoginUrl: EMBED,
  redirectAfterAccountCreationUrl: EMBED,
};

class Jar {
  private jar = new Map<string, string>();
  addFrom(resp: Response) {
    for (const c of resp.headers.getSetCookie?.() ?? []) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  dump(): string {
    return JSON.stringify([...this.jar]);
  }
  static load(s: string): Jar {
    const j = new Jar();
    for (const [k, v] of JSON.parse(s) as [string, string][]) j["jar"].set(k, v);
    return j;
  }
}

export interface MfaState {
  cookies: string;
  csrf: string;
}
export type SsoResult =
  | { status: "success"; oauth1: OAuth1Token }
  | { status: "needs_mfa"; state: MfaState }
  | { status: "error"; message: string };

const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
const csrfOf = (html: string) => html.match(/name="_csrf"\s+value="(.+?)"/)?.[1];
const ticketOf = (html: string) => html.match(/embed\?ticket=([^"']+)["']/)?.[1];

// Garmin SSO returns a widget page on success, an MFA form when 2FA is on, else a login error
function classify(html: string): "success" | "mfa" | "error" {
  if (ticketOf(html)) return "success";
  if (/verifyMFA|mfa-code|loginEnterMfaCode/i.test(html) || /<title>[^<]*MFA[^<]*<\/title>/i.test(html))
    return "mfa";
  return "error";
}

export async function ssoStart(email: string, password: string): Promise<SsoResult> {
  const jar = new Jar();
  const embed = await fetch(`${SSO}/embed?${qs(EMBED_PARAMS)}`, {
    headers: { "User-Agent": BROWSER_UA },
  });
  jar.addFrom(embed);

  const signin = await fetch(`${SSO}/signin?${qs(SIGNIN_PARAMS)}`, {
    headers: { "User-Agent": BROWSER_UA, Cookie: jar.header(), Referer: `${SSO}/embed` },
  });
  jar.addFrom(signin);
  const csrf = csrfOf(await signin.text());
  if (!csrf) return { status: "error", message: "Garmin login page changed (no CSRF token)." };

  const post = await fetch(`${SSO}/signin?${qs(SIGNIN_PARAMS)}`, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      Cookie: jar.header(),
      Referer: `${SSO}/signin?${qs(SIGNIN_PARAMS)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: qs({ username: email, password, embed: "true", _csrf: csrf }),
    redirect: "manual",
  });
  jar.addFrom(post);
  const body = await post.text();

  switch (classify(body)) {
    case "success":
      return { status: "success", oauth1: await ticketToOauth1(jar, ticketOf(body)!) };
    case "mfa": {
      const mfaCsrf = csrfOf(body) ?? csrf;
      return { status: "needs_mfa", state: { cookies: jar.dump(), csrf: mfaCsrf } };
    }
    default:
      return { status: "error", message: "Incorrect Garmin email or password." };
  }
}

export async function ssoCompleteMfa(state: MfaState, code: string): Promise<SsoResult> {
  const jar = Jar.load(state.cookies);
  const post = await fetch(`${SSO}/verifyMFA/loginEnterMfaCode?${qs(SIGNIN_PARAMS)}`, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      Cookie: jar.header(),
      Referer: `${SSO}/signin?${qs(SIGNIN_PARAMS)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: qs({
      "mfa-code": code,
      embed: "true",
      _csrf: state.csrf,
      fromPage: "setupEnterMfaCode",
    }),
    redirect: "manual",
  });
  jar.addFrom(post);
  const body = await post.text();
  const ticket = ticketOf(body);
  if (!ticket) return { status: "error", message: "Invalid or expired MFA code." };
  return { status: "success", oauth1: await ticketToOauth1(jar, ticket) };
}

// Trade the SSO ticket for an OAuth1 token via the two-legged (consumer-only) preauthorized endpoint
async function ticketToOauth1(jar: Jar, ticket: string): Promise<OAuth1Token> {
  const url =
    "https://connectapi.garmin.com/oauth-service/oauth/preauthorized" +
    `?ticket=${encodeURIComponent(ticket)}&login-url=${encodeURIComponent(EMBED)}` +
    "&accepts-mfa-tokens=true";
  const oauth = new OAuth({
    consumer: await getConsumer(),
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) => createHmac("sha1", key).update(base).digest("base64"),
  });
  const header = oauth.toHeader(oauth.authorize({ url, method: "GET" }));
  const resp = await fetch(url, {
    headers: { "User-Agent": MOBILE_UA, Cookie: jar.header(), ...header },
  });
  if (!resp.ok) throw new Error(`preauthorized ticket exchange failed: ${resp.status}`);
  const parsed = new URLSearchParams(await resp.text());
  const oauth_token = parsed.get("oauth_token");
  const oauth_token_secret = parsed.get("oauth_token_secret");
  if (!oauth_token || !oauth_token_secret) throw new Error("no oauth1 token in ticket response");
  const tok: OAuth1Token = { oauth_token, oauth_token_secret };
  const mfa = parsed.get("mfa_token");
  if (mfa) tok.mfa_token = mfa;
  return tok;
}
