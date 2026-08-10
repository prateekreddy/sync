# Where this session's credential lives. Sourced, never run.
#
# Two processes have to agree on one filename: the hook that writes the watch
# URL after a claim, and the monitor that reads it to keep the lease alive. They
# worked it out separately, and disagreed -- the hook used the session id Claude
# Code actually sets, the monitor read a variable that does not exist and fell
# back to a file called `default.watch` that nothing ever writes. The monitor ran,
# found no credential, kept nothing alive, and reported success. Measured
# 2026-08-10: the state directory was empty in a box that had claimed an item
# that session and been handed a watch URL in the reply.
#
# The same decision made in two places is a missing primitive, so it is made
# here, once. Neither caller may compute this path itself.

# Where the helper scripts beside this one live.
#
# Callers set SYNC_BIN before sourcing. This used to read $(dirname "$0"), which
# is right only when the sourcing script IS the running program -- source it from
# anything else and it silently resolved to that program's directory instead,
# so the rotation below was written by a sync-json that did not exist and the
# credential was never updated. Silent, naturally.
sync_bin() {
  printf '%s' "${SYNC_BIN:-$(dirname "$0")}"
}

# The directory. Overridable because the tests need somewhere that is not $HOME.
sync_state_dir() {
  printf '%s' "${SYNC_STATE_DIR:-$HOME/.claude/sync}"
}

# This session's id, or empty if it cannot be known.
#
#   $1  session id lifted from hook stdin, when the caller has stdin at all.
#       The monitor does not, which is exactly why the environment has to be the
#       common ground: it is the only thing both callers can see.
#
# Empty is a real answer and callers must handle it. There used to be a fallback
# to the literal string `default`, which is worse than no answer twice over: it
# turns "I do not know which session this is" into a valid-looking filename, and
# it gives every session on the box the same one -- merging the state of windows
# that have nothing to do with each other, which is the confusion this file
# exists to prevent.
sync_session_id() {
  _s="${1:-}"
  case "$_s" in
    '' | null) _s="${CLAUDE_CODE_SESSION_ID:-}" ;;
  esac
  printf '%s' "$_s"
}

# The credential file for a session id, which callers pass from sync_session_id.
sync_watch_file() {
  printf '%s/%s.watch' "$(sync_state_dir)" "$1"
}

# Poll the watch credential, keeping the replacement it hands back.
#
#   $1  the watch file
#   $2  where to write the response body
#   ->  the HTTP status on stdout, or 000 if the gateway could not be reached
#
# Every GET rotates: the gateway retires the URL that was used and returns its
# successor in the body. That makes every reader a writer, and for as long as
# three callers polled this only one of them kept the new value. The other two
# left the file holding a credential the gateway had already retired, and the
# next poll of it came back 410 — which is the same answer the gateway gives when
# somebody else really has taken the item, because no record of the superseded
# hash is kept.
#
# What that produced, measured live 2026-08-10 within a minute of a good claim:
# the push fence refused with "this work is no longer yours", the monitor
# announced the claim lost and deleted the credential, and the lease then stopped
# being extended and genuinely lapsed. Nobody had touched the item. An agent was
# told to discard correct work and stopped from pushing it — the worst direction
# this could fail in.
#
# So the rotation is persisted here, once, and all three callers poll through it.
# $3 names the caller, and the gateway acts on it.
#
# Three things poll this endpoint -- the monitor, the push fence and the resume
# report -- and only the monitor's poll says anything about whether liveness is
# working. They were indistinguishable on the wire, so the gateway read "something
# polled" as "the monitor is running" and stayed quiet about sessions whose
# monitor was dead while their hooks fired. Measured 2026-08-10: that session
# existed, with the monitor latched in a 900s backoff.
#
# Sent as a User-Agent rather than a query parameter because the credential is in
# the path, and query strings are the part of a URL most likely to be logged or
# copied. Default is deliberately not the monitor: a caller that forgets to say
# what it is must not be counted as proof of liveness.
sync_poll() {
  _file=$1
  _body=$2
  _who=${3:-sync-hook}
  _url=$(cat "$_file" 2>/dev/null || true)
  [ -n "$_url" ] || { printf '000'; return 1; }

  _code=$(curl -sS -m 20 -A "$_who" -o "$_body" -w '%{http_code}' "$_url" 2>/dev/null) || _code=000

  # Written before the caller is told anything, so a crash mid-poll costs a
  # message rather than the credential.
  if [ "$_code" = "200" ]; then
    _next=$("$(sync_bin)/sync-json" watchUrl < "$_body" 2>/dev/null || true)
    [ -n "$_next" ] && printf '%s' "$_next" > "$_file"
  fi

  printf '%s' "$_code"
}
