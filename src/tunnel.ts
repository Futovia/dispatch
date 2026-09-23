import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/**
 * DISPATCH_PUBLIC_URL=tunnel: no domain, no reverse proxy. Dispatch runs a
 * Cloudflare quick tunnel (cloudflared, fetched on first use) and learns its
 * https://*.trycloudflare.com URL at startup. The URL changes whenever the
 * tunnel restarts, so the caller re-points the Twilio webhook each time.
 * Good for trying it out; a real hostname is better for something you keep.
 */
const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

export function cloudflaredAsset(platform = process.platform, arch = process.arch): { name: string; tgz: boolean } {
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : arch === "arm" ? "arm" : "";
  if (!a) throw new Error(`no cloudflared build for ${platform}/${arch}; install cloudflared yourself or use your own https URL`);
  if (platform === "linux") return { name: `cloudflared-linux-${a}`, tgz: false };
  if (platform === "darwin") return { name: `cloudflared-darwin-${a === "arm64" ? "arm64" : "amd64"}.tgz`, tgz: true };
  throw new Error(`no cloudflared build for ${platform}; use your own https URL`);
}

function onPath(bin: string): string | undefined {
  try {
    return execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** cloudflared from PATH, or downloaded once into <stateDir>/bin. */
export async function ensureCloudflared(stateDir: string): Promise<string> {
  const found = onPath("cloudflared");
  if (found) return found;
  const dir = join(stateDir, "bin");
  const bin = join(dir, "cloudflared");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const asset = cloudflaredAsset();
  log.info("downloading cloudflared", { asset: asset.name });
  const res = await fetch(`${RELEASES}/${asset.name}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (asset.tgz) {
    const tgz = join(dir, asset.name);
    writeFileSync(tgz, buf);
    execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  } else {
    writeFileSync(bin + ".tmp", buf);
    renameSync(bin + ".tmp", bin);
  }
  chmodSync(bin, 0o755);
  return bin;
}

export const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface Tunnel {
  url: string;
  child: ChildProcess;
}

/** Start a quick tunnel to 127.0.0.1:<port> and resolve with its public URL. */
export function startTunnel(bin: string, port: number, timeoutMs = 45_000): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    let seen = "";
    let done = false;
    const timer = setTimeout(() => finish(new Error(`cloudflared gave no URL within ${timeoutMs / 1000}s: ${seen.slice(-400)}`)), timeoutMs);
    const finish = (err?: Error, url?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else resolve({ url: url!, child });
    };
    const onData = (d: Buffer) => {
      const text = d.toString();
      if (!done) seen += text;
      const m = TUNNEL_URL_RE.exec(text);
      if (m) finish(undefined, m[0]);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => finish(new Error(`cloudflared exited (${code}) before giving a URL: ${seen.slice(-400)}`)));
  });
}

/** Wait until the tunnel actually serves our /health (DNS for a new quick tunnel takes a few seconds). */
export async function waitReachable(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
