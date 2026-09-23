/**
 * The Twilio account-side calls `dispatch init` and `dispatch doctor` need:
 * check credentials, list the account's WhatsApp senders, and point a
 * sender's inbound webhook at this box. Plain fetch, like twilio.ts.
 *
 * Where Twilio routes an inbound WhatsApp message:
 *   - the sender is in a Messaging Service that does NOT defer to the sender
 *     (use_inbound_webhook_on_number=false): the service's inbound URL wins;
 *   - otherwise: the sender's own webhook (Senders API v2).
 */
export interface AdminCreds {
  accountSid: string;
  authToken: string;
}

export interface WhatsAppSender {
  sid: string;
  /** "whatsapp:+15551234567" */
  address: string;
  status: string;
  webhookUrl: string;
}

export interface ServiceRoute {
  sid: string;
  name: string;
  inboundUrl: string;
  /** true: the service defers to each sender's own webhook. */
  defersToSender: boolean;
  /** How many senders/numbers share the service (and so its inbound URL). */
  members: number;
}

export interface Routing {
  /** The URL inbound messages actually go to right now ("" if none). */
  effectiveUrl: string;
  via: "service" | "sender" | "unknown";
  service?: ServiceRoute;
  sender?: WhatsAppSender;
}

export const SANDBOX_ADDRESS = "whatsapp:+14155238886";
export const SANDBOX_CONSOLE = "https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn";

export class TwilioAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

async function api<T>(creds: AdminCreds, url: string, init: RequestInit = {}, f: FetchLike = fetch): Promise<T> {
  const res = await f(url, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64"),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // leave empty
  }
  if (!res.ok) throw new TwilioAdminError(String(json.message ?? `HTTP ${res.status} from ${new URL(url).pathname}`), res.status);
  return json as T;
}

/** Returns the account's friendly name; throws TwilioAdminError on bad credentials. */
export async function checkCredentials(creds: AdminCreds, f?: FetchLike): Promise<{ name: string; status: string }> {
  const a = await api<{ friendly_name?: string; status?: string }>(creds, `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}.json`, {}, f);
  return { name: a.friendly_name ?? creds.accountSid, status: a.status ?? "unknown" };
}

export async function listWhatsAppSenders(creds: AdminCreds, f?: FetchLike): Promise<WhatsAppSender[]> {
  const out: WhatsAppSender[] = [];
  let url: string | null = "https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50";
  while (url) {
    const page: { senders?: Array<Record<string, any>>; meta?: { next_page_url?: string | null } } = await api(creds, url, {}, f);
    for (const s of page.senders ?? []) {
      out.push({
        sid: String(s.sid),
        address: String(s.sender_id),
        status: String(s.status ?? ""),
        webhookUrl: String(s.webhook?.callback_url ?? ""),
      });
    }
    url = page.meta?.next_page_url ?? null;
  }
  return out;
}

/** The Messaging Service a number belongs to, if any. */
export async function serviceFor(creds: AdminCreds, address: string, f?: FetchLike): Promise<ServiceRoute | undefined> {
  const e164 = address.replace(/^whatsapp:/, "");
  const services = await api<{ services?: Array<Record<string, any>> }>(creds, "https://messaging.twilio.com/v1/Services?PageSize=100", {}, f);
  for (const svc of services.services ?? []) {
    const members = new Set<string>();
    for (const kind of ["PhoneNumbers", "ChannelSenders"]) {
      try {
        const list = await api<Record<string, any>>(creds, `https://messaging.twilio.com/v1/Services/${svc.sid}/${kind}?PageSize=100`, {}, f);
        const key = kind === "PhoneNumbers" ? "phone_numbers" : "senders";
        for (const m of (list[key] as Array<Record<string, any>>) ?? []) members.add(String(m.phone_number ?? m.sender ?? "").replace(/^whatsapp:/, ""));
      } catch {
        // ChannelSenders is not enabled on every account
      }
    }
    if (members.has(e164)) {
      return {
        sid: String(svc.sid),
        name: String(svc.friendly_name ?? svc.sid),
        inboundUrl: String(svc.inbound_request_url ?? ""),
        defersToSender: Boolean(svc.use_inbound_webhook_on_number),
        members: members.size,
      };
    }
  }
  return undefined;
}

export async function routing(creds: AdminCreds, address: string, f?: FetchLike): Promise<Routing> {
  const [senders, service] = await Promise.all([listWhatsAppSenders(creds, f), serviceFor(creds, address, f)]);
  const sender = senders.find((s) => s.address === address);
  if (service && !service.defersToSender) return { effectiveUrl: service.inboundUrl, via: "service", service, sender };
  if (sender) return { effectiveUrl: sender.webhookUrl, via: "sender", service, sender };
  return { effectiveUrl: "", via: "unknown", service };
}

export interface PointResult {
  changed: boolean;
  via: "service" | "sender";
  what: string;
  previous: string;
}

/**
 * Make inbound messages for `address` go to `url`. Refuses to repoint a
 * Messaging Service shared with other numbers unless `allowShared`, because
 * that would take the other numbers along.
 */
export async function pointWebhook(
  creds: AdminCreds,
  address: string,
  url: string,
  opts: { statusUrl?: string; allowShared?: boolean; fetchImpl?: FetchLike } = {},
): Promise<PointResult> {
  const f = opts.fetchImpl;
  const r = await routing(creds, address, f);
  if (r.via === "service" && r.service) {
    if (r.service.inboundUrl === url) return { changed: false, via: "service", what: `Messaging Service "${r.service.name}"`, previous: url };
    if (r.service.members > 1 && !opts.allowShared) {
      throw new TwilioAdminError(
        `${address} is in Messaging Service "${r.service.name}" with ${r.service.members - 1} other number(s); repointing it would move them too. ` +
          `Set its inbound URL to ${url} in the Twilio console, or rerun with --shared-service.`,
        409,
      );
    }
    const form = new URLSearchParams({ InboundRequestUrl: url, InboundMethod: "POST" });
    await api(creds, `https://messaging.twilio.com/v1/Services/${r.service.sid}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, f);
    return { changed: true, via: "service", what: `Messaging Service "${r.service.name}"`, previous: r.service.inboundUrl };
  }
  if (!r.sender) throw new TwilioAdminError(`${address} is not a WhatsApp sender on this Twilio account`, 404);
  if (r.sender.webhookUrl === url) return { changed: false, via: "sender", what: `sender ${address}`, previous: url };
  const webhook: Record<string, string> = { callback_url: url, callback_method: "POST" };
  if (opts.statusUrl) {
    webhook.status_callback_url = opts.statusUrl;
    webhook.status_callback_method = "POST";
  }
  await api(
    creds,
    `https://messaging.twilio.com/v2/Channels/Senders/${r.sender.sid}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ webhook }) },
    f,
  );
  return { changed: true, via: "sender", what: `sender ${address}`, previous: r.sender.webhookUrl };
}
