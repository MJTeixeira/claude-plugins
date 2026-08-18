#!/bin/sh
# Factory failure notifier (O6, NOTES item 46) — the dumb outer net that
# fires when a factory unit fails, INCLUDING when the machine runtime is too
# broken to reach its own Telegram code. Deliberately trivial: POSIX sh +
# curl, no node, no runtime files.
#
# Install (once per machine):
#   cp notify-fail.sh ~/.factory/notify-fail.sh
#   (Telegram creds live in ~/secrets/factory-shared.env — the machine
#    credentials file; see FACTORY.md § Machine credentials)
#
# Wired via factory-onfailure@.service (OnFailure= on factory units).
# Never exits non-zero: a broken notifier must not add its own failures.
UNIT="${1:-unknown}"
ENV_FILE="$HOME/secrets/factory-shared.env"
[ -f "$ENV_FILE" ] || exit 0
# Extract, don't source: the file carries every machine-shared credential,
# and sourcing arbitrary values into sh is how a token with a space or $
# breaks the one notifier that must never break.
TELEGRAM_BOT_TOKEN=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | head -n 1)
TELEGRAM_CHAT_ID=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "$ENV_FILE" | head -n 1)
[ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ] || exit 0
curl -sS -m 10 "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
  --data-urlencode "text=[fleet] ✗ $UNIT FAILED on $(hostname) — check: journalctl --user -u $UNIT" \
  >/dev/null 2>&1
exit 0
