import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dispatch service install|uninstall|status|logs`: keep the daemon running
 * across logouts and reboots, as YOU (a systemd user unit on Linux, a launchd
 * agent on macOS). Never root: the agent uses your claude login, your keys,
 * your dotfiles.
 */
// DISPATCH_SERVICE_NAME lets a second instance (another number, another state dir) run beside the first.
const NAME = () => process.env.DISPATCH_SERVICE_NAME || "dispatch";
const LABEL = () => `com.futovia.${NAME()}`;

/** Carry a non-default state dir into the service, so it runs the same instance you set up. */
function stateEnv(): Array<[string, string]> {
  return process.env.DISPATCH_STATE_DIR ? [["DISPATCH_STATE_DIR", process.env.DISPATCH_STATE_DIR]] : [];
}

export function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

/** PATH for the service: node's own dir first, so the agent's subprocesses find node, npm and dispatch. */
export function servicePath(): string {
  const dirs = [dirname(process.execPath), join(homedir(), ".local", "bin"), join(homedir(), "bin"), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  const bin = binDir();
  if (bin) dirs.splice(1, 0, bin);
  return [...new Set(dirs)].join(":");
}

/** Where the `dispatch` command itself lives (npm's global bin), if we can tell. */
function binDir(): string | undefined {
  try {
    const p = execFileSync("sh", ["-c", "command -v dispatch"], { encoding: "utf8" }).trim();
    return p ? dirname(p) : undefined;
  } catch {
    return undefined;
  }
}

export function systemdUnit(node = process.execPath, cli = cliPath(), path = servicePath()): string {
  return `# Written by \`dispatch service install\`. Remove with \`dispatch service uninstall\`.
[Unit]
Description=dispatch - text your server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${node} ${cli} start
Restart=always
RestartSec=3
Environment=PATH=${path}
${stateEnv().map(([k, v]) => `Environment=${k}=${v}\n`).join("")}StandardOutput=journal
StandardError=journal
SyslogIdentifier=${NAME()}

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(node = process.execPath, cli = cliPath(), path = servicePath(), logDir = process.env.DISPATCH_STATE_DIR || join(homedir(), ".dispatch")): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL()}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${cli}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string>${stateEnv().map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "dispatch.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "dispatch.log")}</string>
</dict>
</plist>
`;
}

const unitFile = () => join(homedir(), ".config", "systemd", "user", `${NAME()}.service`);
const plistFile = () => join(homedir(), "Library", "LaunchAgents", `${LABEL()}.plist`);

/** `su - user` and some ssh setups leave these unset, and then systemctl --user cannot find the user manager. */
function userBusEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const uid = process.getuid?.();
  if (uid !== undefined && !env.XDG_RUNTIME_DIR && existsSync(`/run/user/${uid}`)) env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (env.XDG_RUNTIME_DIR && !env.DBUS_SESSION_BUS_ADDRESS && existsSync(`${env.XDG_RUNTIME_DIR}/bus`)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  return env;
}

function run(cmd: string, args: string[], quiet = false): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: userBusEnv(), stdio: quiet ? "pipe" : ["ignore", "inherit", "inherit"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function installService(say: (s: string) => void = (s) => process.stdout.write(s + "\n")): boolean {
  if (process.platform === "darwin") {
    const file = plistFile();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) run("launchctl", ["unload", file], true);
    writeFileSync(file, launchdPlist());
    const ok = run("launchctl", ["load", "-w", file]).ok;
    say(ok ? `installed ${file}; dispatch runs at login. logs: dispatch service logs` : `wrote ${file} but launchctl load failed`);
    return ok;
  }
  if (process.platform !== "linux") {
    say(`no service support for ${process.platform}; run \`dispatch start\` under your own supervisor`);
    return false;
  }
  if (!run("systemctl", ["--user", "--version"], true).ok) {
    say("systemctl --user is not available here; run `dispatch start` under tmux, screen or your own supervisor");
    return false;
  }
  const file = unitFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, systemdUnit());
  run("systemctl", ["--user", "daemon-reload"], true);
  const enabled = run("systemctl", ["--user", "enable", NAME()], true);
  const started = run("systemctl", ["--user", "restart", NAME()], true);
  if (!enabled.ok || !started.ok) {
    say(`wrote ${file} but systemctl failed: ${(started.out || enabled.out).slice(0, 300)}`);
    return false;
  }
  // Without linger, user services stop when you log out of ssh.
  const linger = run("loginctl", ["enable-linger", userInfo().username], true);
  say(`installed ${file} and started it. logs: dispatch service logs`);
  if (!linger.ok) say(`could not enable linger (${linger.out.slice(0, 120)}). so it survives logout, run: sudo loginctl enable-linger ${userInfo().username}`);
  return true;
}

export function uninstallService(say: (s: string) => void = (s) => process.stdout.write(s + "\n")): void {
  if (process.platform === "darwin") {
    const file = plistFile();
    if (existsSync(file)) {
      run("launchctl", ["unload", file], true);
      rmSync(file);
    }
    say("removed the launchd agent");
    return;
  }
  run("systemctl", ["--user", "disable", "--now", NAME()], true);
  if (existsSync(unitFile())) rmSync(unitFile());
  run("systemctl", ["--user", "daemon-reload"], true);
  say("stopped and removed the systemd user unit");
}

export function serviceStatus(): void {
  if (process.platform === "darwin") run("launchctl", ["list", LABEL()]);
  else run("systemctl", ["--user", "status", NAME(), "--no-pager"]);
}

export function serviceLogs(): void {
  if (process.platform === "darwin") run("tail", ["-n", "100", "-f", join(process.env.DISPATCH_STATE_DIR || join(homedir(), ".dispatch"), "dispatch.log")]);
  else run("journalctl", ["--user", "-u", NAME(), "-n", "100", "-f"]);
}

export function serviceInstalled(): boolean {
  return existsSync(process.platform === "darwin" ? plistFile() : unitFile());
}
