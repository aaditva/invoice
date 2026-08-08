#!/bin/bash
#
# Installs the ESC/POS receipt bridge for EVERY user account on this Mac.
#
# Difference from "Install Receipt Printer.command":
#   that one installs a LaunchAgent in your own home folder, which only runs
#   when *you* are logged in. This installs a LaunchDaemon, which starts at boot
#   and serves whichever account is signed in.
#
# This one DOES need your admin password (sudo), because it writes to
# /Library/LaunchDaemons and /usr/local/share.
#
# To undo, double-click "Uninstall Receipt Printer.command".
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.remactables.receiptbridge"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
SHARE="/usr/local/share/receipt-bridge"
LOG="/var/log/receipt-bridge.log"

say(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
ok(){  printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
die(){ bad "$1"; echo; read -r -p "Press Return to close." _; exit 1; }

say "Receipt printer setup - all user accounts"
echo "Working from: $DIR"

# ---------------------------------------------------------------- 1. Runtime
say "1. Choosing a runtime"
if [ -x /usr/bin/perl ]; then
  RUNTIME=/usr/bin/perl; SRC="$DIR/escpos-bridge.pl"; NAME="escpos-bridge.pl"
  ok "$RUNTIME ($(/usr/bin/perl -e 'print $^V')) - built into macOS"
else
  NODE="$(command -v node || true)"
  [ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
  [ -z "$NODE" ] && [ -x /usr/local/bin/node ]    && NODE=/usr/local/bin/node
  [ -n "$NODE" ] || die "Neither Perl nor Node.js found on this Mac."
  RUNTIME="$NODE"; SRC="$DIR/escpos-bridge.js"; NAME="escpos-bridge.js"
  ok "$NODE ($("$NODE" -v))"
fi
[ -f "$SRC" ] || die "Missing $SRC"

# ---------------------------------------------------------------- 2. Queue
say "2. Finding the Epson print queue"
QUEUE="$(lpstat -a 2>/dev/null | awk '{print $1}' | grep -i 'T88' | head -1)"
if [ -z "$QUEUE" ]; then
  bad "No printer with 'T88' in its name is set up."
  lpstat -a 2>/dev/null | awk '{print "       - " $1}'
  die "Add the TM-T88V in System Settings > Printers & Scanners first."
fi
ok "Using queue: $QUEUE"
# CUPS queues are system-wide, so every account can already print to this.

# ---------------------------------------------------------------- 3. Test
say "3. Printing a test docket (raw ESC/POS)"
BRIDGE_QUEUE="$QUEUE" "$RUNTIME" "$SRC" --selftest \
  || die "Could not send to the printer. Is it on and connected?"
ok "Sent. Check the printer."

echo
read -r -p "Did a readable receipt come out (not binary junk)? [y/N] " ANSWER
case "$ANSWER" in
  [yY]*) ok "Good - continuing." ;;
  *) say "Stopping. Nothing has been installed."; echo; read -r -p "Press Return to close." _; exit 1 ;;
esac

# ---------------------------------------------------------------- 4. Deploy
# Copied out of your home folder because other accounts may not be able to read
# it there. Re-run this installer after editing the script to refresh the copy.
say "4. Installing system-wide (admin password required)"
echo "  You'll be asked for your Mac password now."

sudo mkdir -p "$SHARE"                              || die "Could not create $SHARE"
sudo cp "$SRC" "$SHARE/$NAME"                       || die "Could not copy the bridge script"
sudo chown root:wheel "$SHARE/$NAME"
sudo chmod 755 "$SHARE/$NAME"
ok "Bridge installed at $SHARE/$NAME"

# Stop any per-user copy from the other installer, so they can't fight over :9100.
if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  ok "Removed the older single-user login item (it would have clashed on port 9100)."
fi

sudo tee "$PLIST" >/dev/null <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME</string>
    <string>$SHARE/$NAME</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>BRIDGE_QUEUE</key><string>$QUEUE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

sudo chown root:wheel "$PLIST"
sudo chmod 644 "$PLIST"
ok "LaunchDaemon written to $PLIST"

# ---------------------------------------------------------------- 5. Start
say "5. Starting the daemon"
sudo launchctl bootout  "system/$LABEL"   2>/dev/null
sudo launchctl bootstrap system "$PLIST"  2>/dev/null \
  || sudo launchctl load -w "$PLIST"      2>/dev/null \
  || bad "launchctl would not start it - check $LOG"

HEALTH=""
for _ in $(seq 1 12); do
  sleep 0.5
  HEALTH="$(curl -fsS --max-time 2 http://127.0.0.1:9100/health 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
done

if [ -n "$HEALTH" ]; then
  ok "Bridge is live: $HEALTH"
  say "Done - every account on this Mac can now print receipts."
  echo "  - Starts automatically at boot, before anyone logs in."
  echo "  - Listens on 127.0.0.1 only, so it is not reachable from the network."
  echo "  - Log: $LOG"
  echo
  echo "  Reminder: open the till over http:// or https://, never as a file:// page."
else
  bad "The daemon did not answer on port 9100."
  echo "     Check the log:  cat $LOG"
  echo "     Check it loaded: sudo launchctl print system/$LABEL"
fi

echo
read -r -p "Press Return to close." _
