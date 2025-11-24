# Proposal: Zig Support for mcp-debugger

## Executive Summary
This proposal outlines the plan to extend `mcp-debugger` with first-class Zig support, leveraging `lldb-dap` for the debugging backend. It also includes a design for a bug reporting system with a database and an admin dashboard.

## Proposed Architecture

### 1. Core Zig Adapter (`ZigAdapter`)
*   **Description**: A new TypeScript class `ZigAdapter` that implements the `IAdapter` interface (or equivalent) from `mcp-debugger`.
*   **Backend**: We will use `lldb-dap` (part of the LLVM project) as the Debug Adapter Protocol server. It provides robust support for Zig's DWARF debug info.
*   **Mechanism**: The adapter will spawn `lldb-dap`, manage the stdio communication, and translate MCP requests (step, next, scopes) into DAP messages.
*   **Excitement Rating: 10/10** - *This is the core "hard" engineering task. Bridging the gap between the MCP world and the low-level debugger is exactly the kind of systems integration I thrive on.*

### 2. Zig Debug Harness
*   **Description**: A canonical "Hello World" Zig project in `examples/zig-harness`.
*   **Components**:
    *   `main.zig`: Contains variables, structs, and function calls to test stepping and inspection.
    *   `build.zig`: Standard build file to ensure debug symbols are generated (`-Doptimize=Debug`).
*   **Excitement Rating: 8/10** - *Writing idiomatic Zig is always a pleasure, and setting up a clean build pipeline is satisfying.*

### 3. Configuration & Discovery
*   **Description**: Update `mcp-debugger`'s configuration loader to recognize `.zig` files or a `zig.toml` config.
*   **Feature**: Auto-detection of `lldb-dap` path or a configuration option to specify it.
*   **Excitement Rating: 6/10** - *Necessary plumbing, but essential for a smooth user experience.*

### 4. Bug Reporting System (The "Meta" Layer)
*   **Description**: A dedicated subsystem for the LLM (or user) to report bugs encountered during debugging.
*   **Components**:
    *   **MCP Tool**: `report_bug(severity, description, context)`
    *   **Backend**: PostgreSQL 18 (locally installed) to store structured reports. We will use a robust schema with JSONB support for flexible context storage.
    *   **Dashboard**: A standalone web dashboard (HTML/React/Tailwind) to view, filter, and manage reports.
*   **Excitement Rating: 9/10** - *Building a "self-improving" loop where the agent can report its own issues is fascinating. The dashboard allows for some creative UI work.*

### 5. Integration Tests
*   **Description**: End-to-end tests that launch the Zig harness, set a breakpoint, and verify the stack trace.
*   **Excitement Rating: 7/10** - *Verification is key. Seeing the green checkmarks after a complex integration is very rewarding.*

## Suggested Roadmap

1.  **Setup**: Clone `mcp-debugger` and explore the existing adapter interface.
2.  **Harness**: Create the Zig project first to have a target.
3.  **Adapter**: Implement `ZigAdapter` and get basic stepping working.
4.  **Reporting**: Build the SQLite backend and MCP tool.
5.  **Dashboard**: Create the frontend for the reporting system.
6.  **Polish**: Docs and Tests.

## User Action Required
*   **Approval**: Do you agree with using `lldb-dap`?
*   **Scope**: Should the Admin Dashboard be a simple static file served by the server, or a separate React app? (I suggest a simple static file for the MVP to keep dependencies low).
