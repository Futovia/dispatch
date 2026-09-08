import { describe, it, expect } from "vitest";
import { twilioSignature, verifyTwilioSignature, parseForm, parseInbound, forwardWebhook } from "../src/twilio.js";

const TOKEN = "12345";

describe("twilio signature", () => {
  it("matches Twilio's documented example", () => {
    // From https://www.twilio.com/docs/usage/webhooks/webhooks-security
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    };
    expect(twilioSignature(TOKEN, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(verifyTwilioSignature(TOKEN, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
  });

  it("rejects a bad or missing signature without throwing", () => {
    expect(verifyTwilioSignature(TOKEN, "https://x/y", { A: "1" }, "nope")).toBe(false);
    expect(verifyTwilioSignature(TOKEN, "https://x/y", { A: "1" }, undefined)).toBe(false);
  });

  it("re-signs a forwarded webhook for the target's own URL", async () => {
    const params = { MessageSid: "SM1", From: "whatsapp:+1", To: "whatsapp:+2", Body: "hi" };
    let seen: { url: string; sig: string; body: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, sig: (init.headers as Record<string, string>)["X-Twilio-Signature"], body: String(init.body) };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await forwardWebhook(TOKEN, { url: "http://127.0.0.1:8787/hook", signedUrl: "https://public.example/hook" }, params, fetchImpl);
    expect(seen!.url).toBe("http://127.0.0.1:8787/hook");
    expect(verifyTwilioSignature(TOKEN, "https://public.example/hook", parseForm(seen!.body), seen!.sig)).toBe(true);
  });
});

describe("parseInbound", () => {
  it("extracts text and media", () => {
    const msg = parseInbound({
      MessageSid: "SM1",
      From: "whatsapp:+15551234567",
      To: "whatsapp:+14155238886",
      Body: "look",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/media/1",
      MediaContentType0: "image/jpeg",
    })!;
    expect(msg.body).toBe("look");
    expect(msg.media).toEqual([{ url: "https://api.twilio.com/media/1", contentType: "image/jpeg" }]);
  });

  it("ignores payloads that are not messages", () => {
    expect(parseInbound({ MessageStatus: "delivered" })).toBeNull();
  });
});
