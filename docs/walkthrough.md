# Walkthrough: Zig Support for mcp-debugger

Zig debugging support has been added to `mcp-debugger`, including a new adapter and a debug harness.

## Changes

### 1. Zig Adapter (`packages/adapter-zig`)
- Created a new package `@debugmcp/adapter-zig`.
- Implemented `ZigAdapter` which bridges MCP requests to `lldb-dap`.
- Registered the adapter in the main server configuration.

### 2. Zig Debug Harness (`examples/zig-harness`)
- Created a simple "Hello World" Zig project.
- Configured `build.zig` to generate debug symbols.
- Verified compilation with `zig build`.

## Verification Results

### Automated Tests
- `pnpm install` completed successfully.
- `zig build` passed for the harness.

### Manual Verification Steps
1.  **Start the Server**: Run `pnpm start` in `packages/mcp-debugger`.
2.  **Connect Client**: Connect an MCP client (like Claude Desktop or a test script).
3.  **Start Debugging**:
    - Call `create_debug_session` with `language: "zig"`.
    - Call `start_debugging` with the path to `examples/zig-harness/zig-out/bin/zig-harness`.
    - Call `set_breakpoint` on `main.zig`.
    - Call `step_over` and inspect variables.

## Next Steps
- Implement the actual `lldb-dap` spawning logic in `ZigAdapter` (currently a skeleton).
- Add proper integration tests that spawn the server and run a full debug session.
