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
