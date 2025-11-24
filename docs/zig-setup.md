# Zig Support for MCP Debugger - Setup Guide

## Prerequisites

- **Zig**: Install from [ziglang.org](https://ziglang.org/download/)
- **LLDB with DAP support**: `lldb-dap` must be in your PATH
  - On macOS with Homebrew: `brew install llvm` (lldb-dap is included)
  - Add to PATH: `export PATH="/opt/homebrew/opt/llvm/bin:$PATH"`
- **PostgreSQL 18**: For bug reporting system
  - On macOS: `brew install postgresql@18`

## Quick Start

1. **Build the project**:
   ```bash
   cd mcp-debugger
   pnpm install
   pnpm build
   ```

2. **Set up the database**:
   ```bash
   psql -d postgres -c "CREATE DATABASE bug_reports;"
   psql -d bug_reports -c "CREATE TABLE reports (
     id SERIAL PRIMARY KEY,
     severity TEXT,
     description TEXT,
     context JSONB,
     created_at TIMESTAMP DEFAULT NOW()
   );"
   ```

3. **Build the Zig harness**:
   ```bash
   cd examples/zig-harness
   zig build -Doptimize=Debug
   ```

4. **Start the MCP server**:
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

4. **Report bugs**:
   ```json
   {
     "tool": "report_bug",
     "arguments": {
       "severity": "high",
       "description": "Breakpoint not hit in Zig code",
       "context": {
         "file": "main.zig",
         "line": 10
       }
     }
   }
   ```

## Viewing Bug Reports

Open `public/dashboard.html` in your browser to view the bug reports dashboard.

## Architecture

- **Adapter**: `packages/adapter-zig` - Implements `IDebugAdapter` interface
- **Backend**: Uses `lldb-dap` for DAP protocol communication
- **Database**: PostgreSQL for bug report storage
- **Dashboard**: Simple HTML/JS interface for viewing reports

## Next Steps

The current implementation is a skeleton. To make it fully functional:

1. Implement actual `lldb-dap` spawning in `ZigAdapter`
2. Add DAP message translation (MCP → DAP)
3. Create integration tests
4. Add API endpoint for dashboard to fetch real data
5. Enhance error handling and validation
