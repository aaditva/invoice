#!/bin/bash
#
# Removes the receipt bridge — both the single-user login item and the
# system-wide daemon, whichever are present. Double-click to run.
#
# Your printer, its queue, and the till itself are left untouched.
#
set -uo pipefail

LABEL="com.remactables.receiptbridge"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DAEMON="/Library/LaunchDaemons/$LABEL.plist"
SHARE="/usr/local/share/receipt-bridge"

ok(){   printf '  \033[32mOK\033[0m   %s\n' "$1"; }
skip(){ printf '  --   %s\n' "$1"; }

printf '\n\033[1mRemoving the receipt bridge\033[0m\n'

# ---- single-user login item (no password needed) ----
if [ -f "$AGENT" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$AGENT" 2>/dev/null
  rm -f "$AGENT"
  ok "Login item removed (this account)."
else
  skip "No login item for this account."
fi

# ---- system-wide daemon (needs admin) ----
if [ -f "$DAEMON" ]; then
  echo "  A system-wide daemon is installed; removing it needs your password."
  sudo launchctl bootout "system/$LABEL" 2>/dev/null || sudo launchctl unload "$DAEMON" 2>/dev/null
  sudo rm -f "$DAEMON"
  sudo rm -rf "$SHARE"
  ok "System-wide daemon and $SHARE removed."
else
  skip "No system-wide daemon installed."
fi

# ---- catch anything started by hand ----
if pkill -f 'escpos-bridge' 2>/dev/null; then
  ok "Stopped a bridge process that was still running."
fi

if curl -fsS --max-time 2 http://127.0.0.1:9100/health >/dev/null 2>&1; then
  printf '  \033[31mNOTE\033[0m Something is still answering on port 9100.\n'
  printf '       Find it with:  lsof -nP -iTCP:9100 -sTCP:LISTEN\n'
else
  ok "Port 9100 is clear."
fi

printf '\nDone. The till will fall back to the normal print dialog.\n\n'
read -r -p "Press Return to close." _
