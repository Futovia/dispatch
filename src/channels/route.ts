import type { ChannelName } from "../config.js";
import { channelOf } from "./types.js";

/**
 * Which address a message to an operator goes to. One operator can text from
 * several addresses (a WhatsApp number, an iMessage phone, an Apple ID email);
 * the reply follows them:
 *  1. the address they texted from last, on a channel that is up;
 *  2. except a WhatsApp number whose 24h window has closed, when iMessage can
 *     carry it instead (iMessage has no window);
 *  3. with nothing to go on: iMessage first (no window), then WhatsApp.
 * Among several addresses on one channel, the one heard from most recently wins.
 */
export function pickAddress(input: {
  operator: string;
  aliases: Record<string, string>;
  up: ChannelName[];
  replyTo?: string;
  lastInboundVia?: Record<string, string>;
  whatsappWindowOpen: (address: string) => boolean;
}): string | undefined {
  const { operator, aliases, up, replyTo, lastInboundVia = {} } = input;
  const mine = Object.keys(aliases).filter((a) => aliases[a] === operator && up.includes(channelOf(a)!));
  const recency = (a: string) => Date.parse(lastInboundVia[a] ?? "") || 0;
  const best = (ch: ChannelName) =>
    mine
      .filter((a) => channelOf(a) === ch)
      .sort((a, b) => recency(b) - recency(a))[0];

  if (replyTo && mine.includes(replyTo)) {
    if (channelOf(replyTo) === "whatsapp" && !input.whatsappWindowOpen(replyTo) && best("imessage")) return best("imessage");
    return replyTo;
  }
  return best("imessage") ?? best("whatsapp");
}
