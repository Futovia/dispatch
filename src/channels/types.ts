import type { ChannelName } from "../config.js";

/**
 * A way the operator texts the box. The router never sees a channel: it gets
 * InboundMessages (twilio.ts / imessage.ts parse them) and hands replies to
 * one send(operator, text), which picks the channel (route.ts).
 */
export interface Channel {
  readonly name: ChannelName;
  /** Deliver markdown to one address of this channel ("whatsapp:+1...", "imessage:me@x.com"). */
  send(address: string, text: string): Promise<void>;
  /** Whether it can receive and send right now, and if not, what to do about it. */
  status(): ChannelStatus;
}

export interface ChannelStatus {
  ok: boolean;
  detail?: string;
}

export function channelOf(address: string): ChannelName | undefined {
  const prefix = address.slice(0, address.indexOf(":"));
  return prefix === "whatsapp" || prefix === "imessage" ? prefix : undefined;
}
