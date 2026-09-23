import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pointWebhook, routing, TwilioAdminError } from "../src/twilio-admin.js";
import { installHooks, parseInitFlags, renderEnv } from "../src/init.js";
import { loadConfig, parseEnvFile } from "../src/config.js";
import { systemdUnit, launchdPlist } from "../src/service.js";
import { cloudflaredAsset, TUNNEL_URL_RE } from "../src/tunnel.js";

const creds = { accountSid: "AC" + "0".repeat(32), authToken: "tok" };

/** A fake Twilio: one Messaging Service, some senders, and a log of writes. */
function fakeTwilio(opts: { serviceMembers?: string[]; defers?: boolean; serviceUrl?: string; senders?: Array<{ sid: string; num: string; url: string }> }) {
  const writes: Array<{ url: string; body: string }> = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (init?.method === "POST") {
      writes.push({ url, body: String(init.body) });
      return ok({});
    }
    if (url.includes("/v2/Channels/Senders")) {
      return ok({
        senders: (opts.senders ?? []).map((s) => ({ sid: s.sid, sender_id: `whatsapp:${s.num}`, status: "ONLINE", webhook: { callback_url: s.url } })),
        meta: { next_page_url: null },
      });
    }
    if (url.endsWith("/v1/Services?PageSize=100")) {
      return ok({ services: opts.serviceMembers ? [{ sid: "MG1", friendly_name: "Main", inbound_request_url: opts.serviceUrl ?? "https://old", use_inbound_webhook_on_number: opts.defers ?? false }] : [] });
    }
    if (url.includes("/PhoneNumbers")) return ok({ phone_numbers: (opts.serviceMembers ?? []).map((n) => ({ phone_number: n })) });
    if (url.includes("/ChannelSenders")) return ok({ senders: (opts.serviceMembers ?? []).map((n) => ({ sender: `whatsapp:${n}` })) });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, writes };
}

describe("twilio-admin: where inbound goes and repointing it", () => {
  it("a sender outside any service is repointed through the Senders API, with the status callback", async () => {
    const { f, writes } = fakeTwilio({ senders: [{ sid: "XE1", num: "+15550001111", url: "https://old" }] });
    const r = await pointWebhook(creds, "whatsapp:+15550001111", "https://me/twilio/whatsapp", { statusUrl: "https://me/twilio/status", fetchImpl: f });
    expect(r).toMatchObject({ changed: true, via: "sender", previous: "https://old" });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe("https://messaging.twilio.com/v2/Channels/Senders/XE1");
    expect(JSON.parse(writes[0]!.body)).toEqual({
      webhook: { callback_url: "https://me/twilio/whatsapp", callback_method: "POST", status_callback_url: "https://me/twilio/status", status_callback_method: "POST" },
    });
  });

  it("a service that owns routing is repointed instead; the same number listed twice counts once", async () => {
    const { f, writes } = fakeTwilio({ serviceMembers: ["+15550001111"], senders: [{ sid: "XE1", num: "+15550001111", url: "https://ignored" }] });
    const route = await routing(creds, "whatsapp:+15550001111", f);
    expect(route).toMatchObject({ via: "service", effectiveUrl: "https://old", service: { members: 1 } });
    const r = await pointWebhook(creds, "whatsapp:+15550001111", "https://me/twilio/whatsapp", { fetchImpl: f });
    expect(r.via).toBe("service");
    expect(writes[0]!.url).toBe("https://messaging.twilio.com/v1/Services/MG1");
    expect(new URLSearchParams(writes[0]!.body).get("InboundRequestUrl")).toBe("https://me/twilio/whatsapp");
  });

  it("refuses to move a service shared with other numbers unless allowed", async () => {
    const { f, writes } = fakeTwilio({ serviceMembers: ["+15550001111", "+15550002222"] });
    await expect(pointWebhook(creds, "whatsapp:+15550001111", "https://me/x", { fetchImpl: f })).rejects.toThrow(TwilioAdminError);
    expect(writes).toHaveLength(0);
    await pointWebhook(creds, "whatsapp:+15550001111", "https://me/x", { fetchImpl: f, allowShared: true });
    expect(writes).toHaveLength(1);
  });

  it("a service that defers to the sender leaves routing with the sender; nothing is written when already right", async () => {
    const { f, writes } = fakeTwilio({ serviceMembers: ["+15550001111"], defers: true, senders: [{ sid: "XE1", num: "+15550001111", url: "https://me/x" }] });
    const r = await pointWebhook(creds, "whatsapp:+15550001111", "https://me/x", { fetchImpl: f });
    expect(r).toMatchObject({ changed: false, via: "sender" });
    expect(writes).toHaveLength(0);
  });

  it("an unknown number is an error, not a silent no-op", async () => {
    const { f } = fakeTwilio({});
    await expect(pointWebhook(creds, "whatsapp:+15559999999", "https://me/x", { fetchImpl: f })).rejects.toThrow(/not a WhatsApp sender/);
  });
});

describe("init helpers", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("parses flags in both --k v and --k=v forms and rejects unknown ones", () => {
    const f = parseInitFlags(["--sid", "AC1", "--token=t", "--from", "+1555", "--operator=+1666", "--url", "tunnel", "--yes", "--no-service"]);
    expect(f).toMatchObject({ sid: "AC1", token: "t", from: "+1555", operator: "+1666", url: "tunnel", yes: true, service: false, hooks: true });
    expect(() => parseInitFlags(["--nope"])).toThrow(/unknown option/);
  });

  it("renders the env template with values, keeping unrelated settings from an old file", () => {
    const text = renderEnv({ TWILIO_ACCOUNT_SID: "ACx", DISPATCH_PUBLIC_URL: "tunnel" }, { DISPATCH_PORT: "9999", CUSTOM_THING: "1" });
    const env = parseEnvFile(text);
    expect(env).toMatchObject({ TWILIO_ACCOUNT_SID: "ACx", DISPATCH_PUBLIC_URL: "tunnel", DISPATCH_PORT: "9999", CUSTOM_THING: "1" });
    expect(text.match(/^DISPATCH_PORT=/gm)).toHaveLength(1);
  });

  it("the rendered env loads, and tunnel mode turns on auto webhook", () => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-init-"));
    writeFileSync(
      join(dir, "env"),
      renderEnv({ TWILIO_ACCOUNT_SID: creds.accountSid, TWILIO_AUTH_TOKEN: "t", TWILIO_WHATSAPP_FROM: "+14155238886", DISPATCH_OPERATORS: "+15550001111", DISPATCH_PUBLIC_URL: "tunnel" }),
    );
    const c = loadConfig({ DISPATCH_STATE_DIR: dir } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ tunnel: true, publicUrl: "", autoWebhook: true, sharedService: false, operators: ["whatsapp:+15550001111"] });
    const own = loadConfig({ DISPATCH_STATE_DIR: dir, DISPATCH_PUBLIC_URL: "https://d.example" } as NodeJS.ProcessEnv);
    expect(own).toMatchObject({ tunnel: false, publicUrl: "https://d.example", autoWebhook: false });
    expect(() => loadConfig({ DISPATCH_STATE_DIR: dir, DISPATCH_PUBLIC_URL: "http://plain" } as NodeJS.ProcessEnv)).toThrow(/https origin, or: tunnel/);
  });

  it("adds the four hooks once, keeps existing settings, and backs the file up", () => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-hooks-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }));
    expect(installHooks(file, "dispatch hook")).toBe("added");
    const s = JSON.parse(readFileSync(file, "utf8"));
    expect(s.model).toBe("opus");
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      expect(JSON.stringify(s.hooks[ev])).toContain("dispatch hook");
    }
    expect(s.hooks.Stop).toHaveLength(2);
    expect(readFileSync(file + ".bak-dispatch", "utf8")).toContain('"other"');
    expect(installHooks(file, "dispatch hook")).toBe("present");
  });
});

describe("service and tunnel bits", () => {
  it("the systemd unit runs this node and cli, and carries a custom state dir", () => {
    process.env.DISPATCH_STATE_DIR = "/tmp/d2";
    process.env.DISPATCH_SERVICE_NAME = "dispatch-two";
    try {
      const unit = systemdUnit("/usr/bin/node", "/x/dist/cli.js", "/a:/b");
      expect(unit).toContain("ExecStart=/usr/bin/node /x/dist/cli.js start");
      expect(unit).toContain("Environment=PATH=/a:/b");
      expect(unit).toContain("Environment=DISPATCH_STATE_DIR=/tmp/d2");
      expect(unit).toContain("SyslogIdentifier=dispatch-two");
      const plist = launchdPlist("/usr/bin/node", "/x/dist/cli.js", "/a:/b", "/tmp/d2");
      expect(plist).toContain("<string>com.futovia.dispatch-two</string>");
      expect(plist).toContain("<key>DISPATCH_STATE_DIR</key><string>/tmp/d2</string>");
    } finally {
      delete process.env.DISPATCH_STATE_DIR;
      delete process.env.DISPATCH_SERVICE_NAME;
    }
  });

  it("picks the right cloudflared build and recognises its URL", () => {
    expect(cloudflaredAsset("linux", "x64")).toEqual({ name: "cloudflared-linux-amd64", tgz: false });
    expect(cloudflaredAsset("linux", "arm64")).toEqual({ name: "cloudflared-linux-arm64", tgz: false });
    expect(cloudflaredAsset("darwin", "arm64")).toEqual({ name: "cloudflared-darwin-arm64.tgz", tgz: true });
    expect(() => cloudflaredAsset("win32", "x64")).toThrow();
    const line = "2026-09-23T12:00:00Z INF |  https://quiet-river-abc-123.trycloudflare.com  |";
    expect(TUNNEL_URL_RE.exec(line)?.[0]).toBe("https://quiet-river-abc-123.trycloudflare.com");
  });
});
