# dispatch

**Text your server.**

One WhatsApp number, wired through Twilio, straight to Claude Code and Codex running on your own box. You text, the agent works the machine, you get the result on your phone.

```
you:       is the site up? deploy says green but it feels slow
dispatch:  up. p95 is 2.1s because next.js is rebuilding the /blog pages on
           every request: revalidate is 0 in app/blog/[slug]/page.tsx. want me
           to set it to 3600 and redeploy?
you:       yes
dispatch:  done. deployed 4f1c2a9, p95 now 180ms.
```

## The opinion

Most "personal AI assistant" projects want to connect to everything, everywhere, for everyone. Dispatch does one thing:

- **One channel: WhatsApp, via Twilio.** A real business number with a signed webhook. No linked-device hacks, no QR codes, no banned personal accounts, nothing to babysit.
- **One operator (or a few).** It is *your* box. Strangers who text the number are ignored, or handed to whatever bot used to own it.
- **No agent loop of its own.** Claude Code and Codex are the best coding agents on earth and they improve every month. Dispatch does not compete with them; it routes to them. Your subscription logins on the box are all the auth it needs.
- **One conversation, one job at a time.** More texts queue. `/stop` cancels. Each agent keeps its own resumable session, so "and now do the same for staging" just works. The session is never reset unless you say `/new`; it auto-compacts, so "what was that email from Henry yesterday" works.
- **Your other Claude Code sessions are reachable from the same thread.** A terminal session that runs `ping-admin "pr done"` texts you tagged with its project; you reply "merge it" and the root conversation runs that instruction inside that session, with its full history. See "Steering other sessions".
- **One env file.** No JSON config, no dashboard, no plugin marketplace. `dispatch init`, fill in eight lines, `dispatch start`.

If you want a marketplace of skills, twelve chat platforms, a companion iOS app and a Docker sandbox matrix, use OpenClaw. If you want to text your server, this is it.

## Requirements

- Linux or macOS box with Node 22+
- `claude` (Claude Code) and/or `codex` CLIs installed and logged in
- A Twilio account with a WhatsApp sender (the free sandbox works for trying it out)
- An https hostname that reaches the box (Caddy, nginx, a tunnel; anything)

## Install

```bash
git clone https://github.com/Futovia/dispatch && cd dispatch
npm install && npm run build
ln -s "$PWD/bin/dispatch.js" ~/.local/bin/dispatch

dispatch init          # writes ~/.dispatch/env, edit it
dispatch doctor        # checks logins, Twilio, your public URL
dispatch start
```

Point the Twilio sender's inbound webhook at `https://<your host>/twilio/whatsapp`, then text the number.

Run it for real with the user-level systemd unit in `deploy/dispatch.service` (no root needed) and a two-line reverse-proxy block like `deploy/Caddyfile.snippet`.

## Talking to it

Text what you want done. Anything that is not a command goes to the active agent, with your photos attached as files it can read.

| command | what it does |
|---|---|
| `/new` | fresh session for the current agent |
| `/claude`, `/codex` | switch agent; each keeps its own session |
| `/cd <folder>` | set the working folder (`/cd` shows it) |
| `/status` | agent, folder, running job, load, memory, uptime |
| `/stop` | cancel the running job and clear the queue |
| `/verbose` | narrate tool calls as they happen |
| `/auto`, `/ask` | act freely, or ask you before every command and edit |
| `/yes`, `/no` | answer an approval (plain "yes" / "no" works too) |
| `/<cmd> <msg>` | send to the fallthrough bot, only if you set `DISPATCH_FALLTHROUGH_COMMAND` |

The agent can text you mid-task from any script: `dispatch send "build green, deploying"`. Pipes work too: `make test 2>&1 | tail -5 | dispatch send`.

## Steering other sessions

You usually have several Claude Code sessions open in terminals, one per project. Dispatch lets the WhatsApp thread act on any of them.

Install the hooks once (they register every session with dispatch; nothing runs unless a session starts, prompts, stops or ends):

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

## Permissions

`DISPATCH_PERMISSIONS=auto` (default): the agent has your box, same as you at a terminal. That is the point.

`DISPATCH_PERMISSIONS=ask`: every command and file edit is relayed to your phone as a one-line summary; reply yes or no. Unanswered approvals are denied after `DISPATCH_APPROVAL_TIMEOUT_MIN`. Claude Code supports this natively. Codex has no approval hook, so in ask mode it runs in its workspace-write sandbox instead: writes stay inside the working folder.

Switch at runtime with `/auto` and `/ask`.

## Sharing a number with an existing bot

Already have a bot on that WhatsApp number? Set `DISPATCH_FALLTHROUGH_URL` to its webhook. Messages from anyone who is not an operator are re-signed with your Twilio auth token and forwarded, so the old bot cannot tell the difference. Operators reach it with `/fwd <message>` (rename the command with `DISPATCH_FALLTHROUGH_COMMAND`).

## Where things live

```
~/.dispatch/env             all configuration
~/.dispatch/DISPATCH.md     your instructions to the agent, appended to its system prompt
~/.dispatch/state.json      operator settings, session ids, pending context (the agents keep the transcripts)
~/.dispatch/sessions/       one JSON per Claude Code session on the box, written by the hooks
~/.dispatch/transcripts/    one JSONL per operator; grep is the UI
~/.dispatch/media/          photos and files you sent
```

## How it works

```
WhatsApp -> Twilio -> https://host/twilio/whatsapp -> dispatch (127.0.0.1:8790)
                                                         |
                                     operator? ----no----+--> forward / ignore
                                         |
                                        yes
                                         |
                                 command? --yes--> /new /cd /status ...
                                         |
                                        no
                                         |
                              Claude Agent SDK  or  Codex SDK  (resumed session)
                                         |
                              markdown -> WhatsApp text, chunked -> Twilio -> phone
```

Local routes (`/send`, `/alert`, `/tell`, `/sessions`) take a bearer token from state.json, so only processes running as you can use them. Twilio's signature is verified against the public URL before anything is parsed. Twilio retries webhooks that take longer than 15 seconds, so Dispatch acks immediately and works asynchronously; duplicate deliveries are dropped by message id. Outbound messages are capped at 1500 characters each and split at paragraph boundaries.

## Not built, on purpose (for now)

Voice note transcription, group chats, multiple machines behind one number, a web UI, other messaging platforms. Open an issue if one of these is the thing standing between you and texting your server.

## Development

```bash
npm test          # vitest: signature, formatting, router with fake agents, session registry, alerts and tell
npm run typecheck
```

MIT. Made by [Futovia](https://futovia.com).
