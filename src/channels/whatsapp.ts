import type { Config } from "../config.js";
import type { State } from "../state.js";
import { sendWhatsApp, sendWhatsAppTemplate, TwilioSendError, type TwilioCreds } from "../twilio.js";
import { renderForWhatsApp } from "../wa-format.js";
import { log } from "../log.js";
import type { Channel, ChannelStatus } from "./types.js";

/**
 * WhatsApp through Twilio. Inbound arrives as a webhook (server.ts ->
 * Router.handleWebhook); this is the outbound half.
 *
 * WhatsApp only lets a business message someone freely for 24h after their
 * last message. Past that only an approved template gets through, and the
 * rejection is asynchronous (the API says 200, the status callback says
 * 63016). So: pick the template up front when the window is clearly closed,
 * and resend via template when a status callback reports 63016 anyway.
 */
const WINDOW_MS = 23 * 60 * 60 * 1000;

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  private recentOutbound = new Map<string, { to: string; text: string; template: boolean }>();
  private creds: TwilioCreds & { from: string };

  constructor(
    private config: Config,
    private state: State,
    private fetchImpl?: typeof fetch,
  ) {
    if (!config.twilio) throw new Error("whatsapp channel without Twilio settings");
    this.creds = config.twilio;
  }

  status(): ChannelStatus {
    return { ok: true };
  }

  /** Read at send time: with a tunnel the public URL is only known after startup. */
  private statusCallback(): string | undefined {
    return this.config.publicUrl ? this.config.publicUrl + this.config.statusPath : undefined;
  }

  /** Whether `address` texted in the last 23h, so a plain message still gets through. */
  windowOpen(address: string): boolean {
    const id = this.config.aliases[address];
    if (!id) return false;
    const op = this.state.operator(id, { worker: this.config.defaultWorker, cwd: this.config.workspace });
    // Before per-address tracking, lastInboundAt was the WhatsApp number's.
    const last = op.lastInboundVia?.[address] ?? (op.lastInboundVia ? undefined : op.lastInboundAt);
    return Boolean(last) && Date.now() - Date.parse(last!) < WINDOW_MS;
  }

  async send(to: string, text: string): Promise<void> {
    for (const part of renderForWhatsApp(text)) {
      if (!this.windowOpen(to) && this.config.alertTemplateSid) {
        await this.viaTemplate(to, part);
        continue;
      }
      try {
        const { sid } = await sendWhatsApp(this.creds, this.creds.from, to, part, { statusCallback: this.statusCallback(), fetchImpl: this.fetchImpl });
        this.remember(sid, { to, text: part, template: false });
      } catch (e) {
        if (e instanceof TwilioSendError && e.outsideWindow) {
          if (!this.config.alertTemplateSid) {
            log.warn("outside WhatsApp 24h window and no DISPATCH_ALERT_TEMPLATE_SID; operator must text first", { to });
            return;
          }
          await this.viaTemplate(to, part);
          continue;
        }
        throw e;
      }
    }
  }

  /** A verified Twilio delivery status callback. */
  async onStatus(params: Record<string, string>): Promise<void> {
    const sid = params.MessageSid ?? params.SmsSid ?? "";
    const st = params.MessageStatus ?? "";
    if (st !== "failed" && st !== "undelivered") return;
    const code = Number(params.ErrorCode ?? "0");
    const known = this.recentOutbound.get(sid);
    log.warn("outbound message not delivered", { sid, status: st, code, to: params.To, template: known?.template ?? null });
    if (code === 63016 && known && !known.template && this.config.alertTemplateSid) {
      this.recentOutbound.delete(sid);
      await this.viaTemplate(known.to, known.text);
    }
  }

  private remember(sid: string, entry: { to: string; text: string; template: boolean }): void {
    if (!sid) return;
    this.recentOutbound.set(sid, entry);
    if (this.recentOutbound.size > 300) this.recentOutbound.delete(this.recentOutbound.keys().next().value!);
  }

  private async viaTemplate(to: string, text: string): Promise<void> {
    if (!this.config.alertTemplateSid) throw new TwilioSendError("outside the 24h window and no DISPATCH_ALERT_TEMPLATE_SID", 0, 63016);
    // Template variables cannot hold newlines; flatten. The operator texting back reopens the window.
    const flat = text.replace(/\s*\n+\s*/g, " / ").replace(/\s{4,}/g, "   ").slice(0, 1000);
    const { sid } = await sendWhatsAppTemplate(this.creds, this.creds.from, to, this.config.alertTemplateSid, { "1": this.config.machineName, "2": flat }, {
      statusCallback: this.statusCallback(),
      fetchImpl: this.fetchImpl,
    });
    this.remember(sid, { to, text, template: true });
    log.info("sent via template (outside 24h window)", { to, sid });
  }
}
