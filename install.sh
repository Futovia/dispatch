#!/usr/bin/env bash
# dispatch installer: text your server.
#
#   curl -fsSL https://raw.githubusercontent.com/Futovia/dispatch/main/install.sh | bash
#
# Installs Node 22 if needed (into your home, no sudo), installs
# @futovia/dispatch from npm, then runs `dispatch init`, which asks for your
# Twilio details. Any arguments are passed to `dispatch init`, e.g.
#   curl -fsSL .../install.sh | bash -s -- --sid AC... --token ... --from +1... --operator +44...
#
# Run as root (a fresh VPS), it creates a normal user "dispatch" and installs
# there: Claude Code will not run with full permissions as root.
set -euo pipefail

PKG="@futovia/dispatch"
INSTALL_URL="https://raw.githubusercontent.com/Futovia/dispatch/main/install.sh"
NODE_MAJOR=22
USER_NAME="${DISPATCH_USER:-dispatch}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
tty_ok() { [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; }
ask_yes() { # ask_yes "question" default(y|n)
  local def="${2:-y}" a=""
  if tty_ok; then
    printf '%s (%s) ' "$1" "$([ "$def" = y ] && echo Y/n || echo y/N)" >/dev/tty
    read -r a </dev/tty || true
  fi
  a="${a:-$def}"
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

have curl || die "curl is required"

# ---- root: hand over to a normal user ---------------------------------------
if [ "$(id -u)" = "0" ] && [ -z "${DISPATCH_ALLOW_ROOT:-}" ]; then
  [ "$(uname -s)" = "Linux" ] || die "run this as your normal user, not root"
  say "running as root: dispatch will run as its own user, \"$USER_NAME\"."
  if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$USER_NAME"
    say "created user $USER_NAME"
  fi
  if ask_yes "let the agent use sudo, so it can install packages and fix system problems?" y; then
    if ! have sudo; then
      if have apt-get; then apt-get update -qq && apt-get install -y -qq sudo >/dev/null
      elif have dnf; then dnf install -y -q sudo
      elif have yum; then yum install -y -q sudo
      fi
    fi
    have sudo || die "sudo is not installed and could not be installed; install it, or rerun and answer no"
    mkdir -p /etc/sudoers.d
    echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-dispatch
    chmod 440 /etc/sudoers.d/90-dispatch
    say "$USER_NAME can use sudo (remove /etc/sudoers.d/90-dispatch to undo)"
  fi
  # Keep its services running without a login session.
  have loginctl && loginctl enable-linger "$USER_NAME" || true
  say "continuing as $USER_NAME..."
  args=""
  for a in "$@"; do args="$args $(printf '%q' "$a")"; done
  # su - starts a clean environment; carry the installer's own overrides across.
  envs=""
  [ -n "${DISPATCH_PACKAGE:-}" ] && envs="DISPATCH_PACKAGE=$(printf '%q' "$DISPATCH_PACKAGE") "
  if [ -n "${DISPATCH_INSTALL_SCRIPT:-}" ]; then
    exec su - "$USER_NAME" -c "${envs}bash $(printf '%q' "$DISPATCH_INSTALL_SCRIPT") $args"
  fi
  exec su - "$USER_NAME" -c "curl -fsSL $INSTALL_URL | ${envs}bash -s -- $args"
fi

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# ---- node ---------------------------------------------------------------------
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; }
if ! node_ok; then
  say "installing Node $NODE_MAJOR into ~/.local (no sudo)..."
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '{print $2}' | grep -E "^node-v[0-9.]+-${os}-${arch}\.tar\.gz$" | head -1)"
  [ -n "$file" ] || die "could not find a Node $NODE_MAJOR build for $os-$arch"
  dest="$HOME/.local/share/dispatch-node"
  rm -rf "$dest" && mkdir -p "$dest"
  curl -fsSL "$base/$file" | tar -xz -C "$dest" --strip-components=1
  for b in node npm npx; do ln -sf "$dest/bin/$b" "$HOME/.local/bin/$b"; done
  node_ok || die "node install failed"
fi
say "node $(node -v)"

# ---- npm prefix: global installs must not need sudo ------------------------------
prefix="$(npm prefix -g)"
if ! [ -w "$prefix/lib" ] && ! [ -w "$prefix" ]; then
  npm config set prefix "$HOME/.local"
  prefix="$HOME/.local"
fi
export PATH="$prefix/bin:$PATH"

# Make ~/.local/bin (and the npm prefix) stick for future shells.
line="export PATH=\"$prefix/bin:\$HOME/.local/bin:\$PATH\""
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || continue
  grep -qsF "$line" "$rc" || printf '\n# added by the dispatch installer\n%s\n' "$line" >>"$rc"
done

# ---- dispatch -------------------------------------------------------------------
say "installing $PKG..."
if [ -n "${DISPATCH_PACKAGE:-}" ]; then
  npm install -g --no-audit --no-fund "$DISPATCH_PACKAGE" >/dev/null
else
  npm install -g --no-audit --no-fund "$PKG@latest" >/dev/null
fi
have dispatch || die "dispatch was installed but is not on PATH ($prefix/bin)"
say "dispatch $(dispatch --version)"

if tty_ok; then
  exec dispatch init "$@" </dev/tty
elif [ "$#" -gt 0 ]; then
  exec dispatch init --yes "$@"
else
  say "installed. now run: dispatch init"
fi
