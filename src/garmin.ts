import OAuth from "oauth-1.0a";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";

// Garmin blocks non-mobile user agents on connectapi
const UA = { "User-Agent": "com.garmin.android.apps.connectmobile" };
const API_BASE = "https://connectapi.garmin.com";
// Garmin Connect Mobile's OAuth1 consumer credentials, same source garth uses
const CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string;
}

export interface OAuth2Token {
  access_token: string;
  expires_at: number;
  [k: string]: unknown;
}

let consumer: { key: string; secret: string } | undefined;

export async function getConsumer() {
  if (!consumer) {
    const res = await fetch(CONSUMER_URL);
    if (!res.ok) throw new Error(`consumer fetch failed: ${res.status}`);
    const j = (await res.json()) as { consumer_key: string; consumer_secret: string };
    consumer = { key: j.consumer_key, secret: j.consumer_secret };
  }
  return consumer;
}

// Exchange long-lived OAuth1 token for a short-lived OAuth2 bearer token
export async function exchange(oauth1: OAuth1Token): Promise<OAuth2Token> {
  const url = `${API_BASE}/oauth-service/oauth/exchange/user/2.0`;
  const data: Record<string, string> = {};
  if (oauth1.mfa_token) data.mfa_token = oauth1.mfa_token;

  const oauth = new OAuth({
    consumer: await getConsumer(),
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) => createHmac("sha1", key).update(base).digest("base64"),
  });
  const header = oauth.toHeader(
    oauth.authorize(
      { url, method: "POST", data },
      { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret }
    )
  );

  const res = await fetch(url, {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded", ...header },
    body: new URLSearchParams(data).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);

  const tok = (await res.json()) as OAuth2Token & { expires_in: number };
  tok.expires_at = Math.floor(Date.now() / 1000) + tok.expires_in;
  return tok;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, string | string[] | undefined>;
  body?: unknown; // JSON-encoded
  binary?: boolean; // return { base64, contentType } instead of parsed JSON
  // multipart upload: field name -> file
  form?: Record<string, { filename: string; content: ArrayBuffer | Uint8Array | string; type?: string }>;
}

export async function api(
  accessToken: string,
  path: string,
  opts: ApiOptions = {}
): Promise<unknown> {
  if (!path.startsWith("/")) throw new Error("path must start with /");
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v === undefined || v === "") continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  const method = opts.method ?? "GET";
  let body: BodyInit | undefined;
  let contentType: Record<string, string> = {};
  if (opts.form) {
    const fd = new FormData();
    for (const [field, f] of Object.entries(opts.form)) {
      fd.append(field, new Blob([f.content as BlobPart], { type: f.type ?? "application/octet-stream" }), f.filename);
    }
    body = fd; // fetch sets the multipart boundary header itself
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    contentType = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, {
    method,
    headers: { ...UA, Authorization: `Bearer ${accessToken}`, ...contentType },
    body,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  if (opts.binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }
  const text = await res.text();
  return text ? JSON.parse(text) : { ok: true, status: res.status };
}
