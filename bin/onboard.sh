#!/usr/bin/env bash
#
# The connect flow now ships inside the plugin, and this is the path the README
# and every provisioning script already knew.
#
# It moved because of where it was needed. A box that ran `/plugin install
# sync@sync` has no clone of this repository -- that is the whole point of the
# plugin -- so the one script that connects a machine without a browser lived
# somewhere the machines that need it cannot reach. Now it is at
# ${CLAUDE_PLUGIN_ROOT}/bin/sync-connect on every install, and this is a
# forwarder rather than a second copy: two copies of an onboarding script drift,
# and the drift shows up as a box that will not connect.
exec "$(dirname "$0")/../plugin/bin/sync-connect" "$@"
