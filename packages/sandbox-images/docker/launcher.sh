#!/usr/bin/env bash
set -euo pipefail

# Docker reruns PID 1 after start. Only the supervisor may mark a completed
# boot: an interrupted clone/setup must retry fresh, not resume partial state.
export OI_BOOT_COMPLETE_MARKER=/var/lib/openinspect/boot-complete
export OPENINSPECT_STATE_DIR=/var/lib/openinspect/runtime
export OI_DEFERRED_START=false IMAGE_BUILD_MODE=false FROM_REPO_IMAGE=false REPO_IMAGE_SHA=
export RESTORED_FROM_SNAPSHOT=false
# The runtime writes its repo manifest and state here and expects the
# directory to exist. It lives on the container filesystem, so it survives
# stop/start like the workspace.
mkdir -p "$OPENINSPECT_STATE_DIR" "$(dirname "$OI_BOOT_COMPLETE_MARKER")"
if [[ -e "$OI_BOOT_COMPLETE_MARKER" ]]; then
  export RESTORED_FROM_SNAPSHOT=true
fi

cd /workspace
exec /opt/openinspect/python/bin/python -m sandbox_runtime.entrypoint
