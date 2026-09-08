import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The whole Twilio surface Dispatch needs, over fetch. Four things: verify an
 * inbound signature, send a WhatsApp message, download inbound media, and
 * re-sign + forward a webhook. The official SDK is 20MB for that.
 */
export interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

/** Twilio's signature: base64(HMAC-SHA1(url + sortedKey1 + value1 + ...)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

export interface InboundMedia {
  url: string;
  contentType: string;
}

export interface InboundMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  media: InboundMedia[];
  profileName?: string;
}

/** Pull the fields we care about out of a Twilio inbound-message webhook. */
export function parseInbound(params: Record<string, string>): InboundMessage | null {
  const sid = params.MessageSid ?? params.SmsMessageSid;
  const from = params.From;
  const to = params.To;
  if (!sid || !from || !to) return null;
  const media: InboundMedia[] = [];
  const n = Number(params.NumMedia ?? "0");
  for (let i = 0; i < n; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) media.push({ url, contentType: params[`MediaContentType${i}`] ?? "application/octet-stream" });
  }
  return { sid, from, to, body: params.Body ?? "", media, profileName: params.ProfileName };
}

export class TwilioSendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
  }
  /** WhatsApp only lets a business reply freely within 24h of the user's last message. */
  get outsideWindow(): boolean {
    return this.code === 63016;
  }
}

export interface SendOptions {
  mediaUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function sendWhatsApp(
  creds: TwilioCreds,
  from: string,
  to: string,
  body: string,
  opts: SendOptions = {},
): Promise<{ sid: string }> {
  const f = opts.fetchImpl ?? fetch;
  const form = new URLSearchParams({ From: from, To: to, Body: body });
  if (opts.mediaUrl) form.set("MediaUrl", opts.mediaUrl);
  const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: basic(creds), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new TwilioSendError(json.message ?? `twilio ${res.status}`, res.status, json.code);
  return { sid: json.sid ?? "" };
}

/** Inbound media URLs need basic auth; Twilio then redirects to unauthenticated storage. */
export async function downloadMedia(creds: TwilioCreds, url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: { Authorization: basic(creds) }, redirect: "follow" });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Forward a verified webhook to another service that ALSO validates Twilio
 * signatures. We hold the same auth token, so we sign the same params for the
 * URL that service expects, and it cannot tell the difference from Twilio.
 */
export async function forwardWebhook(
  authToken: string,
  target: { url: string; signedUrl: string },
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number }> {
  const res = await fetchImpl(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": twilioSignature(authToken, target.signedUrl, params),
    },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status };
}

function basic(creds: TwilioCreds): string {
  return "Basic " + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
}
