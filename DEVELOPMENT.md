## Testing

Make sure to run the Obsidian setup script at least once on the machine before running E2E tests.

Debug flaky tests: `pnpm run e2e:repeat`. Some handy arguments:

- Choose the run count `pnpm run e2e:repeat -- --repeat-each <count>`
- Filter by test name `-- -g <grep>`

To use arguments on Windows, run the command directly instead of using the package.json script.

### Android

`e2e-tests/mobile.spec.ts` runs against the real Obsidian Android app, not the desktop app's mobile emulation. You need:

1. An Android emulator or device that `adb devices` lists. Set `ANDROID_SERIAL` if more than one is attached. An x86_64 emulator image at API 34 matches CI.
2. The APK: `bash ./scripts/setup-obsidian-android.sh` (needs the `gh` CLI; set `OBSIDIAN_MOBILE_VERSION` to pin a version).

Then run `pnpm run e2e:android`. The tests install the APK over any existing Obsidian on the device, so don't point them at a phone you use.

There are no iOS tests. Obsidian's iOS app ships only through the App Store, and the iOS Simulator runs only builds compiled for it, which Obsidian doesn't publish.
