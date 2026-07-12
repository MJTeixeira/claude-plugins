#!/bin/bash

# Lean Workflow Status Line
# Shows: git branch | model + effort | session cost | cumulative tokens | context size | lines changed

# Force C locale: number formatting must use dot decimals regardless of system locale.
export LC_ALL=C

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
    printf '\033[0;33m⚠️  statusline requires jq. Install: brew install jq\033[0m\n'
    exit 0
fi

MAGENTA='\033[0;35m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

MODEL_NAME=$(echo "$INPUT" | jq -r '.model.display_name // empty')
EFFORT_LEVEL=$(echo "$INPUT" | jq -r '.effort.level // empty')
MODEL_DISPLAY="$MODEL_NAME"
[ -n "$EFFORT_LEVEL" ] && MODEL_DISPLAY="$MODEL_NAME ($EFFORT_LEVEL)"

BRANCH=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
    BRANCH=$(cd "$CWD" && git branch --show-current 2>/dev/null)
fi
[ -z "$BRANCH" ] && BRANCH="no git"

COST=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0')
COST_FORMATTED=$(printf "%.2f" "$COST")
LINES_ADDED=$(echo "$INPUT" | jq -r '.cost.total_lines_added // 0')
LINES_REMOVED=$(echo "$INPUT" | jq -r '.cost.total_lines_removed // 0')

# === TOKEN TRACKING (cumulative across the session, including cached tokens) ===
# Deterministic session file keyed on cwd so projects don't collide.
if command -v md5sum >/dev/null 2>&1; then
    SESSION_HASH=$(echo "$CWD" | md5sum | cut -d' ' -f1)
elif command -v md5 >/dev/null 2>&1; then
    SESSION_HASH=$(echo "$CWD" | md5 | cut -d' ' -f1)
else
    SESSION_HASH="default"
fi
SESSION_FILE="${TMPDIR:-/tmp}/lean-statusline-session-${SESSION_HASH}"

RAW_INPUT=$(echo "$INPUT" | jq -r '.context_window.total_input_tokens // 0')
RAW_OUTPUT=$(echo "$INPUT" | jq -r '.context_window.total_output_tokens // 0')
RAW_TOTAL=$((RAW_INPUT + RAW_OUTPUT))

CALL_INPUT=$(echo "$INPUT" | jq -r '.context_window.current_usage.input_tokens // 0')
CALL_CACHE_READ=$(echo "$INPUT" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
CALL_CACHE_CREATE=$(echo "$INPUT" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
CALL_OUTPUT=$(echo "$INPUT" | jq -r '.context_window.current_usage.output_tokens // 0')
CALL_TOTAL=$((CALL_INPUT + CALL_CACHE_READ + CALL_CACHE_CREATE + CALL_OUTPUT))

PREV_SESSION_ID=""
PREV_RAW_TOTAL="0"
ACCUMULATED_TOKENS="0"
PREV_RAW_COST="0"
if [ -f "$SESSION_FILE" ]; then
    PREV_SESSION_ID=$(sed -n '1p' "$SESSION_FILE" 2>/dev/null || echo "")
    PREV_RAW_TOTAL=$(sed -n '2p' "$SESSION_FILE" 2>/dev/null || echo "0")
    ACCUMULATED_TOKENS=$(sed -n '3p' "$SESSION_FILE" 2>/dev/null || echo "0")
    PREV_RAW_COST=$(sed -n '4p' "$SESSION_FILE" 2>/dev/null || echo "0")
fi

# Process restart: cost decreased from previous invocation → reset accumulation.
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
IS_RESTART="0"
if [ -n "$PREV_RAW_COST" ] && [ "$PREV_RAW_COST" != "0" ]; then
    IS_RESTART=$(jq -n --argjson a "$COST" --argjson b "$PREV_RAW_COST" 'if $a < $b then 1 else 0 end' 2>/dev/null || echo "0")
fi
if [ "$IS_RESTART" = "1" ]; then
    ACCUMULATED_TOKENS=0
    PREV_RAW_TOTAL=0
fi

# /clear (session_id changed): reset the raw baseline.
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "$PREV_SESSION_ID" ]; then
    PREV_RAW_TOTAL=0
fi

if [ "$RAW_TOTAL" -ne "$PREV_RAW_TOTAL" ] 2>/dev/null; then
    RAW_DELTA=$((RAW_TOTAL - PREV_RAW_TOTAL))
    CALL_NON_CACHED=$((CALL_INPUT + CALL_OUTPUT))
    EXTRA=0
    if [ "$RAW_DELTA" -gt "$CALL_NON_CACHED" ] && [ "$CALL_NON_CACHED" -gt 0 ]; then
        EXTRA=$((RAW_DELTA - CALL_NON_CACHED))
    fi
    ACCUMULATED_TOKENS=$((ACCUMULATED_TOKENS + CALL_TOTAL + EXTRA))
    PREV_RAW_TOTAL=$RAW_TOTAL
fi

printf '%s\n%s\n%s\n%s\n' "$SESSION_ID" "$PREV_RAW_TOTAL" "$ACCUMULATED_TOKENS" "$COST" > "$SESSION_FILE" 2>/dev/null

CONTEXT_LENGTH=$((CALL_INPUT + CALL_CACHE_READ + CALL_CACHE_CREATE))

format_tokens() {
    local count=$1
    if [ "$count" -ge 1000000 ]; then
        awk "BEGIN { printf \"%.1fM\\n\", $count / 1000000 }"
    elif [ "$count" -ge 1000 ]; then
        awk "BEGIN { printf \"%.1fk\\n\", $count / 1000 }"
    else
        echo "$count"
    fi
}

TOKENS_FORMATTED=$(format_tokens "$ACCUMULATED_TOKENS")
CONTEXT_FORMATTED=$(format_tokens "$CONTEXT_LENGTH")

echo -e "${MAGENTA}⎇ ${BRANCH}${NC} | ${YELLOW}${MODEL_DISPLAY}${NC} | ${GREEN}Cost: \$${COST_FORMATTED}${NC} | ${CYAN}Tokens: ${TOKENS_FORMATTED}${NC} | Context: ${CONTEXT_FORMATTED} | Lines: +${LINES_ADDED}/-${LINES_REMOVED} | ${DIM}By Code4Food${NC}"
