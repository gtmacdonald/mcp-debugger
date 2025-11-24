# Next Session Prompt: Implementing Full Zig Debugging Support

## Context
You have successfully scaffolded Zig support for mcp-debugger, including the adapter package, debug harness, bug reporting system, and admin dashboard. The project builds successfully, but the core debugging functionality is not yet implemented - the ZigAdapter is currently a skeleton that needs to be connected to lldb-dap.

## Current State
- ✅ `packages/adapter-zig` package created and registered
- ✅ `ZigAdapter` class implements `IDebugAdapter` interface
- ✅ Zig debug harness in `examples/zig-harness` compiles with debug symbols
- ✅ Bug reporting system with PostgreSQL backend
- ✅ Admin dashboard for viewing reports
- ✅ All TypeScript compilation succeeds
- ⚠️ `lldb-dap` is installed and in PATH
- ❌ Actual DAP communication not implemented

## Primary Objective
Implement the core debugging functionality in `ZigAdapter` to enable real debugging of Zig applications through lldb-dap. This involves:

1. **Process Management**: Implement spawning and lifecycle management of the `lldb-dap` process in `ZigAdapter.buildAdapterCommand()` and related methods. Study how `PythonDebugAdapter` spawns `debugpy` for reference.

2. **DAP Protocol Bridge**: Create the bidirectional communication layer between MCP requests and DAP messages. The adapter needs to:
   - Translate MCP `start_debugging` → DAP `launch` request
   - Translate MCP `set_breakpoint` → DAP `setBreakpoints` request
   - Translate MCP `step_over/into/out` → DAP `next/stepIn/stepOut` requests
   - Handle DAP events (stopped, continued, terminated) and update session state
   - Map variable references and stack frames between protocols

3. **Configuration Transformation**: Enhance `transformLaunchConfig()` to properly convert generic MCP launch configs into lldb-dap-specific launch configurations. lldb-dap expects:
   - `program`: path to the Zig executable
   - `args`: command-line arguments
   - `cwd`: working directory
   - `stopOnEntry`: whether to break at entry point

4. **Integration Testing**: Create end-to-end tests that:
   - Build the Zig harness
   - Start a debug session
   - Set breakpoints in `main.zig`
   - Step through code
   - Inspect variables
   - Verify the bug reporting tool works

5. **Error Handling**: Implement robust error handling for:
   - lldb-dap not found in PATH
   - Zig binary not compiled with debug symbols
   - DAP protocol errors
   - Connection failures

## Secondary Objectives
1. **Dashboard API**: Create an HTTP endpoint in the MCP server to serve bug reports from PostgreSQL, replacing the mock data in `public/dashboard.html`
2. **Documentation**: Update `docs/zig-setup.md` with actual usage examples once debugging works
3. **Validation**: Add environment validation in `ZigAdapter.validateEnvironment()` to check for lldb-dap availability

## Technical Guidance
- Reference `packages/adapter-python/src/python-debug-adapter.ts` for DAP communication patterns
- The DAP protocol spec is at https://microsoft.github.io/debug-adapter-protocol/
- lldb-dap uses stdio for communication (stdin/stdout)
- Consider using the existing `ProxyManager` infrastructure if applicable
- The Zig harness at `examples/zig-harness/zig-out/bin/zig-harness` should be your test target

## Success Criteria
By the end of the next session, you should be able to:
1. Start the MCP server
2. Connect a client and create a Zig debug session
3. Set a breakpoint in `main.zig` line 12 (inside the while loop)
4. Start debugging the harness
5. Hit the breakpoint and inspect the value of variable `i`
6. Step through the loop and see `i` increment
7. Report a bug via the tool and see it in the dashboard

## Files to Focus On
- `packages/adapter-zig/src/adapter.ts` - Main implementation
- `examples/zig-harness/main.zig` - Test target
- `src/tools/report_bug.ts` - Bug reporting (may need API endpoint)
- `public/dashboard.html` - Dashboard (needs API integration)

Start by examining how `PythonDebugAdapter` handles the DAP lifecycle, then adapt that pattern for lldb-dap.
