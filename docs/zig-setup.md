# Zig Support for MCP Debugger - Setup Guide

## Prerequisites

- **Zig**: Install from [ziglang.org](https://ziglang.org/download/)
- **LLDB with DAP support**: `lldb-dap` must be in your PATH
  - On macOS with Homebrew: `brew install llvm` (lldb-dap is included)
  - Add to PATH: `export PATH="/opt/homebrew/opt/llvm/bin:$PATH"`

## Quick Start

1. **Build the project**:
   ```bash
   cd mcp-debugger
   pnpm install
   pnpm build
   ```

2. **Build the Zig harness**:
   ```bash
   cd examples/zig-harness
   zig build -Doptimize=Debug
   ```

3. **Start the MCP server**:
   ```bash
   cd ../..
   pnpm start
   ```

## Using the Zig Adapter

Connect an MCP client (like Claude Desktop) and use these tools:

1. **Create a Zig debug session**:
   ```json
   {
     "tool": "create_debug_session",
     "arguments": {
       "language": "zig",
       "name": "my-zig-session"
     }
   }
   ```

2. **Start debugging**:
   ```json
   {
     "tool": "start_debugging",
     "arguments": {
       "sessionId": "<session-id>",
       "scriptPath": "/path/to/zig-harness/zig-out/bin/zig-harness"
     }
   }
   ```

3. **Set breakpoints, step, inspect variables** - same as other languages

## Architecture

- **Adapter**: `packages/adapter-zig` - Implements `IDebugAdapter` interface
- **Backend**: Uses `lldb-dap` for DAP protocol communication

## Next Steps

The current implementation is a skeleton. To make it fully functional:

1. Implement actual `lldb-dap` spawning in `ZigAdapter`
2. Add DAP message translation (MCP → DAP)
3. Create integration tests
4. Enhance error handling and validation
