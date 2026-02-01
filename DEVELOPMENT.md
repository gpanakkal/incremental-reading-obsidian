## Testing

Make sure to run the Obsidian setup script at least once on the machine before running E2E tests.

Debug flaky tests: `npm run e2e:repeat`. Some handy arguments (these don't work on Windows):

- Choose the run count `npm run e2e:repeat -- --repeat-each <count>`
- Filter by test name `-- -g <grep>`
