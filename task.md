# Task: Fix CI Failures

- [x] Analyze failing tests (Rust integration, Zig unit test)
- [x] Fix `build:ci` script to include `vendor:adapters`
- [x] Robustify `rust-integration.test.ts` to skip if `codelldb` missing
- [x] Robustify `conditional-breakpoints.test.ts` to skip if `codelldb` missing
- [x] Fix Zig unit test platform assumptions
- [x] Fix TypeScript lint error in `CustomLaunchRequestArguments`
- [x] Improve `SessionManager.startDebugging` to fail fast on adapter exit
- [x] Fix memory leak in `SessionManager.startDebugging`
- [x] Fix Rust integration test platform detection and path passing <!-- New -->
- [x] Push changes to CI
- [ ] Verify CI pass (User to confirm)
