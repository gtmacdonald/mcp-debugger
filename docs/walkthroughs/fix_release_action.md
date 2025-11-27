# Fix Release Action Failure

## Issue Analysis
The release workflow failed with the following error:
```
[Test] Rust binary not found at .../examples/rust/hello_world/target/debug/hello_world. Run 'cargo build' in examples/rust/hello_world first.
```

This occurred because the `test:ci-no-python` script includes Rust integration tests, but the CI environment did not build the required Rust binary.

## Fix
We updated `.github/workflows/release.yml` to include a step that builds the Rust example project before running the tests.

```yaml
    - name: Build Rust example
      run: |
        cd examples/rust/hello_world
        cargo build
```

## Verification
We reproduced the issue locally by temporarily removing the binary and running the tests, confirming they fail. Restoring the binary made them pass. The CI fix ensures the binary is present.
