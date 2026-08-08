#!/bin/bash
#
# Sets up the ESC/POS receipt bridge for the Epson TM-T88V.
#
# Double-click this file in Finder. It does NOT need an admin password and does
# NOT install a printer driver — it only creates a LaunchAgent in your own home
# folder and prints one test docket.
#
# To undo everything, double-click "Uninstall Receipt Printer.command".
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.remactables.receiptbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs"

say(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
ok(){  printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

say "Receipt printer setup"
echo "Working from: $DIR"

# ---------------------------------------------------------------- 1. Runtime
# Perl ships with macOS, so it's the default and nothing needs installing.
# Node is used only if it happens to be present and Perl somehow isn't.
say "1. Choosing a runtime"
RUNTIME=""; SCRIPT=""
if [ -x /usr/bin/perl ]; then
  RUNTIME=/usr/bin/perl
  SCRIPT="$DIR/escpos-bridge.pl"
  ok "$RUNTIME ($(/usr/bin/perl -e 'print $^V')) - built into macOS, nothing to install"
else
  NODE="$(command -v node || true)"
  [ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
  [ -z "$NODE" ] && [ -x /usr/local/bin/node ]    && NODE=/usr/local/bin/node
  if [ -n "$NODE" ]; then
    RUNTIME="$NODE"; SCRIPT="$DIR/escpos-bridge.js"
    ok "$NODE ($("$NODE" -v))"
  else
    bad "Neither Perl nor Node.js was found on this Mac."
    echo "     That's unusual - macOS normally ships Perl at /usr/bin/perl."
    echo; read -r -p "Press Return to close." _; exit 1
  fi
fi
[ -f "$SCRIPT" ] || { bad "Missing $SCRIPT"; echo; read -r -p "Press Return to close." _; exit 1; }

# ---------------------------------------------------------------- 2. Queue
say "2. Finding the Epson print queue"
QUEUE="$(lpstat -a 2>/dev/null | awk '{print $1}' | grep -i 'T88' | head -1)"
if [ -z "$QUEUE" ]; then
  bad "No printer with 'T88' in its name is set up on this Mac."
  echo "     Available queues:"
  lpstat -a 2>/dev/null | awk '{print "       - " $1}'
  echo "     Add the TM-T88V in System Settings > Printers & Scanners first."
  echo; read -r -p "Press Return to close." _; exit 1
fi
ok "Using queue: $QUEUE"

# ---------------------------------------------------------------- 3. Test
# -o raw makes CUPS skip every filter, so the wrong ESC/P2 driver never touches
# the data and our ESC/POS bytes reach the printer intact.
say "3. Printing a test docket (raw ESC/POS)"
if BRIDGE_QUEUE="$QUEUE" "$RUNTIME" "$SCRIPT" --selftest; then
  ok "Sent. Check the printer."
else
  bad "Could not send to the printer. Is it powered on and connected?"
  echo; read -r -p "Press Return to close." _; exit 1
fi

echo
read -r -p "Did a readable receipt come out (not binary junk)? [y/N] " ANSWER
case "$ANSWER" in
  [yY]*) ok "Great — continuing." ;;
  *)
    say "Stopping here so you don't waste paper."
    echo "Nothing has been installed. Tell Claude what came out and we'll adjust."
    echo; read -r -p "Press Return to close." _; exit 1 ;;
esac

# ---------------------------------------------------------------- 4. Autostart
say "4. Installing the login item"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME</string>
    <string>$SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>BRIDGE_QUEUE</key><string>$QUEUE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/receipt-bridge.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/receipt-bridge.log</string>
</dict>
</plist>
PLISTEOF

launchctl load "$PLIST" && ok "Login item installed." || { bad "Could not load the login item."; }

# ---------------------------------------------------------------- 5. Verify
say "5. Verifying the bridge is answering"
HEALTH=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  HEALTH="$(curl -fsS --max-time 2 http://127.0.0.1:9100/health 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
done

if [ -n "$HEALTH" ]; then
  ok "Bridge is live: $HEALTH"
  say "Done."
  echo "The till will now print through the bridge automatically."
  echo "It restarts by itself whenever you log in."
  echo "Log file: $LOGDIR/receipt-bridge.log"
else
  bad "Bridge did not answer on port 9100."
  echo "     Check the log: $LOGDIR/receipt-bridge.log"
fi

echo
read -r -p "Press Return to close." _
