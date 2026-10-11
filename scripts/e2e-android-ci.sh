#!/usr/bin/env bash
#
# Run the Android e2e suite in CI, inside reactivecircus/android-emulator-runner.
#
# The emulator sometimes dies partway through a run without printing anything:
# adb loses the device and its console port stops answering. Playwright's
# retries can't help then, since every one of them finds no device. When the
# suite fails that way, this prints the end of the kernel log (an OOM kill
# shows up there), boots a fresh emulator from the same AVD, and runs the suite
# once more. A failure with the emulator still alive is a real one and is
# returned as is.
#
# USAGE: ./scripts/e2e-android-ci.sh
#
# Environment Variables
#   EMULATOR_OPTIONS  The emulator flags the action booted with, reused for the
#                     replacement emulator
#   ANDROID_SERIAL    Set by the action; defaults to emulator-5554
#   ANDROID_AVD       The AVD to boot; defaults to the action's "test"
#
set -uo pipefail

serial="${ANDROID_SERIAL:-emulator-5554}"
port="${serial#emulator-}"
avd="${ANDROID_AVD:-test}"
boot_timeout_s=300

pnpm run e2e:android
status=$?
[[ $status -eq 0 ]] && exit 0

if [[ "$(adb -s "$serial" get-state 2>/dev/null)" == "device" ]]; then
  exit $status
fi

echo "::warning::The emulator died during the Android e2e run; booting a new one and running the suite again."
echo "Kernel log tail:"
sudo dmesg | tail -n 40 || true

# Playwright empties its output folder when a run starts, which would take the
# first run's traces with it.
rm -rf e2e-tests/test-results-emulator-died
mv e2e-tests/test-results e2e-tests/test-results-emulator-died 2>/dev/null || true

# The action kills the emulator on this port when the script ends, so the
# replacement must take the same one.
# shellcheck disable=SC2086 # EMULATOR_OPTIONS is a list of flags
nohup "$ANDROID_HOME/emulator/emulator" -port "$port" -avd "$avd" \
  ${EMULATOR_OPTIONS:-} > /tmp/emulator-relaunch.log 2>&1 &

deadline=$((SECONDS + boot_timeout_s))
until [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
  if ((SECONDS > deadline)); then
    echo "❌ The new emulator did not boot within ${boot_timeout_s}s" >&2
    cat /tmp/emulator-relaunch.log >&2
    exit $status
  fi
  sleep 5
done

for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb -s "$serial" shell settings put global "$setting" 0.0
done

# main.js was built by the first run.
pnpm exec cross-env E2E_CLEANUP=1 playwright test --project e2e-android
