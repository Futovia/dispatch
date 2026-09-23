# dispatch

**Text your server.**

A WhatsApp number, wired through Twilio, straight to Claude Code running on your own box. You text, Claude works the machine, you get the result on your phone. It can start fresh Claude sessions for side jobs and run several at once.

```
you:       is the site up? deploy says green but it feels slow
dispatch:  up. p95 is 2.1s because next.js is rebuilding the /blog pages on
           every request: revalidate is 0 in app/blog/[slug]/page.tsx. want me
           to set it to 3600 and redeploy?
you:       yes
dispatch:  done. deployed 4f1c2a9, p95 now 180ms.
```

## Install

On the box (a VPS, a home server, a Mac mini under the desk):

```bash
curl -fsSL https://raw.githubusercontent.com/Futovia/dispatch/main/install.sh | bash
```

That installs Node 22 if needed, installs `@futovia/dispatch`, and runs `dispatch init`, which walks you through six steps:

1. **Claude login**: uses your Claude subscription (or `ANTHROPIC_API_KEY`). Claude Code does not even need to be installed first; dispatch ships with it.
2. **Twilio account**: paste your Account SID and Auth Token (console.twilio.com, dashboard). Checked on the spot.
3. **WhatsApp sender**: pick one of your Twilio WhatsApp numbers from the list, or the free Twilio sandbox to try it out.
4. **Your number**: the only WhatsApp number allowed to drive the box.
5. **How Twilio reaches the box**: a free Cloudflare tunnel (nothing to set up, the default) or your own https URL.
6. **Done**: dispatch points your sender's webhook at itself, registers your Claude Code sessions, and installs itself as a service that survives reboots.

Then text the number.

Already have Node 22+? `npm install -g @futovia/dispatch && dispatch init` does the same.

Running as root on a fresh VPS? The installer creates a normal user called `dispatch` (Claude Code will not run with full permissions as root), offers it passwordless sudo so the agent can install packages and fix system problems, and installs there.

### What you need

- A Linux or macOS box
- A Claude subscription (Pro/Max) or an Anthropic API key
- A Twilio account with a WhatsApp sender. The [Twilio sandbox](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn) works for trying it out: text its join code from your phone first.

### No questions asked

Everything init asks can be passed as flags, for scripts and cloud-init:

```bash
curl -fsSL https://raw.githubusercontent.com/Futovia/dispatch/main/install.sh | bash -s -- \
  --sid ACxxxxxxxx --token xxxxxxxx --from +15551234567 --operator +447700900123 --url tunnel
```

Other flags: `--url https://your.host` instead of the tunnel, `--no-service`, `--no-hooks`, `--no-webhook`, `--shared-service` (allow repointing a Messaging Service that other numbers share).

## Talking to it

Text what you want done. Anything that is not a command goes to Claude, with your photos attached as files it can read.

| command | what it does |
|---|---|
| `/new` | fresh session |
| `/cd <folder>` | set the working folder (`/cd` shows it) |
| `/status` | what is running, load, memory, uptime |
| `/stop` | cancel the running job and clear the queue |
| `/verbose` | narrate tool calls as they happen |
| `/auto`, `/ask` | act freely, or ask you before every command and edit |
| `/yes`, `/no` | answer an approval (plain "yes" / "no" works too) |
| `/claude`, `/codex` | switch agent (Codex is optional: `dispatch enable-codex`) |

One conversation, one job at a time: more texts queue behind it. The session is kept until you say `/new`, and it auto-compacts, so "what was that error yesterday" works.

## Subtasks: spawning sessions

The main conversation hands side jobs to fresh Claude Code sessions, each in its own folder, running in parallel:

```
you:       update the deps in ~/api and ~/web, and check disk space while you're at it
dispatch:  started sessions in api and web. disk: 41% used on /, fine.
dispatch:  *api* (new session 3f2a9c1e)
           bumped 14 deps, tests green, committed 8e1d0b2.
dispatch:  *web* (new session a71c44d0)
           bumped 9 deps; next 15 needs a config change, did it, build passes.
```

Claude does this itself with `dispatch spawn`, and you can too, from any shell on the box:

| command | what it does |
|---|---|
| `dispatch spawn <folder> "task"` | new Claude Code session in that folder; waits and prints the report |
| `dispatch spawn <folder> "task" --bg` | returns at once; the report is texted to you when done |
| `dispatch tell <folder> "..."` | continue that session later, with its full history |

Up to `DISPATCH_MAX_SPAWNS` (default 4) run at once. Each is a normal Claude Code session: `claude --resume <id>` opens it in a terminal.

## Commands on the box

| command | what it does |
|---|---|
| `dispatch init` | guided setup (safe to rerun: keeps what you had) |
| `dispatch doctor` | checks login, Twilio, webhook, tunnel, daemon, hooks; says what to fix |
| `dispatch start` | run in the foreground |
| `dispatch service install` | run as a service (systemd user unit / launchd); also `uninstall`, `status`, `logs` |
| `dispatch send "text"` | text yourself from any script: `make test 2>&1 \| tail -5 \| dispatch send` |
| `dispatch status` | what the daemon is doing right now |
| `dispatch enable-codex` | add the optional Codex worker (`/codex`) |

## Security, plainly

- **Only your number gets in.** Every webhook's Twilio signature is checked against your auth token before anything is read; messages from any other number are ignored.
- **It has your box.** By default (`/auto`) Claude runs with full permissions as the user dispatch runs as, like you at a terminal. That is the point. `/ask` makes it ask you on WhatsApp before every command and file edit.
- **The tunnel is public, the daemon is not.** Only the webhook and a bare `{"ok":true}` health check answer from outside. Everything else needs a token that only processes running as you can read.
- **Your secrets stay on the box**, in `~/.dispatch/env` (mode 600).

The agent is as powerful as the user it runs as. Give it a user and sudo rights you are comfortable texting commands to.

## The public URL

`DISPATCH_PUBLIC_URL=tunnel` (the default) runs a free Cloudflare quick tunnel: no domain, no ports to open, no reverse proxy. Its URL changes whenever the tunnel restarts, and dispatch re-points your Twilio sender each time (`DISPATCH_AUTO_WEBHOOK`). Quick tunnels are best effort; for something you keep, give it a hostname:

```
# Caddyfile (Caddy gets the certificate itself)
dispatch.example.com {
  reverse_proxy 127.0.0.1:8790
}
```

then `dispatch init --url https://dispatch.example.com`.

With the Twilio sandbox, the webhook may have to be set by hand in the [sandbox settings](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn) ("When a message comes in"); `dispatch doctor` tells you the URL.

## Steering your other Claude Code sessions

You usually have several Claude Code sessions open in terminals, one per project. Dispatch lets the WhatsApp thread act on any of them.

`dispatch init` installs the hooks that register every session with dispatch (nothing runs unless a session starts, prompts, stops or ends). By hand, they are:

```json
// ~/.claude/settings.json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "dispatch hook", "timeout": 5 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "dispatch hook", "timeout": 5 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "dispatch hook", "timeout": 5 }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "dispatch hook", "timeout": 5 }] }]
}
```

Then, from any session or script:

| command | what it does |
|---|---|
| `dispatch alert "pr done"` | text the operator, tagged with the folder of the Claude Code session it ran from |
| `dispatch sessions` | live terminal sessions: id, idle/busy, folder, last prompt |
| `dispatch tell perfit-app "merge the pr"` | run the instruction inside that session's conversation and print the result |
| `dispatch tell <id> "..." --bg` | return at once; the result is texted when it finishes |
| `dispatch tell <id> "..." --model opus` | run this one instruction on a named model |

What happens on `tell`: dispatch waits for the target to finish its current turn (up to `DISPATCH_TELL_IDLE_WAIT_SEC`), stops whatever is running it (a terminal process gets SIGTERM; a `claude --bg` session is stopped through the daemon with `claude stop`, which keeps its conversation), and resumes the same session id headlessly with your instruction. One transcript, no branches; `claude --resume <id>` in a terminal later shows everything. If the session stays busy, or cannot be stopped, it forks the transcript instead, leaves the original alone, and labels the result as a fork with the reason. A session with no process left (ended, or already taken) is still a target: its transcript is resumed with nothing to stop.

Which model a `tell` runs on is never left to the CLI's default: dispatch passes `DISPATCH_CLAUDE_MODEL` explicitly, on resume and on fork alike, and `--model <name>` overrides it for a single instruction. If the target session's own transcript last ran on a different model, the result says so instead of leaving you to guess. When a run dies on a usage limit, the alert names the model it was running on and how to change it.

The registry is the hooks plus `claude agents --json`, the CLI's own list of interactive and background sessions. A session only counts as gone when its process is dead and the CLI no longer lists it; a failed resume never drops one. Every failed `tell` is texted to you with the exact error, so it gets fixed instead of worked around.

The WhatsApp conversation gets the alert as context on your next message, so "pls merge" after a "pr done" alert from perfit-app is routed into that session by the agent itself, using `dispatch tell`. If two sessions could match, it asks which.

## The 24 hour window

WhatsApp lets a business reply freely for 24 hours after your last message. Outside that only an approved template gets through, and Twilio only reports the rejection asynchronously (error 63016 on the status callback). Dispatch handles both: it sends via the template up front when you have not texted for 23 hours, and resends via the template when a status callback reports 63016. Create a Content template with two variables ({{1}} machine name, {{2}} message), get it approved for WhatsApp as a UTILITY template, and set `DISPATCH_ALERT_TEMPLATE_SID`. Without one, alerts after a quiet day are dropped until you text the number.

## Sharing a number with an existing bot

Already have a bot on that WhatsApp number? Set `DISPATCH_FALLTHROUGH_URL` to its webhook. Messages from anyone who is not an operator are re-signed with your Twilio auth token and forwarded, so the old bot cannot tell the difference. Operators reach it with `/fwd <message>` (rename the command with `DISPATCH_FALLTHROUGH_COMMAND`).

## Where things live

```
~/.dispatch/env             all configuration (dispatch init writes it; every knob is documented inside)
~/.dispatch/DISPATCH.md     your instructions to the agent, appended to its system prompt
~/.dispatch/state.json      operator settings, session ids, the local token
~/.dispatch/sessions/       one JSON per Claude Code session on the box, written by the hooks
~/.dispatch/transcripts/    one JSONL per operator; grep is the UI
~/.dispatch/media/          photos you sent
~/.dispatch/public-url      the current tunnel URL
```

## How it works

```
WhatsApp -> Twilio -> https://<tunnel or host>/twilio/whatsapp -> dispatch (127.0.0.1:8790)
                                                                     |
                                              your number? ----no----+--> ignore / forward
                                                   |
                                                  yes
                                                   |
                                           command? --yes--> /new /cd /status ...
                                                   |
                                                  no
                                                   |
                                    Claude Agent SDK (resumed session)  --dispatch spawn-->  more sessions
                                                   |
                                    markdown -> WhatsApp text, chunked -> Twilio -> your phone
```

Twilio retries webhooks that take longer than 15 seconds, so dispatch acks at once and works asynchronously; duplicate deliveries are dropped by message id. Replies are split into WhatsApp-sized messages at paragraph boundaries.

## Not built, on purpose (for now)

Voice notes, group chats, several machines behind one number, a web UI, other messaging apps. Open an issue if one of these is the thing standing between you and texting your server.

## Development

```bash
git clone https://github.com/Futovia/dispatch && cd dispatch
npm install && npm run build
npm test          # vitest: signatures, formatting, router with fake agents, sessions, spawn, setup
npm link          # puts your checkout's `dispatch` on PATH
```

MIT. Made by [Futovia](https://futovia.com).
