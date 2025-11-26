# Proposal: Zig Support for mcp-debugger

## Executive Summary
This proposal outlines the plan to extend `mcp-debugger` with first-class Zig support, leveraging `lldb-dap` for the debugging backend.

## Proposed Architecture

### 1. Core Zig Adapter (`ZigAdapter`)
*   **Description**: A new TypeScript class `ZigAdapter` that implements the `IAdapter` interface (or equivalent) from `mcp-debugger`.
*   **Backend**: We will use `lldb-dap` (part of the LLVM project) as the Debug Adapter Protocol server. It provides robust support for Zig's DWARF debug info.
*   **Mechanism**: The adapter will spawn `lldb-dap`, manage the stdio communication, and translate MCP requests (step, next, scopes) into DAP messages.

### 2. Zig Debug Harness
*   **Description**: A canonical "Hello World" Zig project in `examples/zig-harness`.
*   **Components**:
    *   `main.zig`: Contains variables, structs, and function calls to test stepping and inspection.
    *   `build.zig`: Standard build file to ensure debug symbols are generated (`-Doptimize=Debug`).

### 3. Configuration & Discovery
*   **Description**: Update `mcp-debugger`'s configuration loader to recognize `.zig` files or a `zig.toml` config.
*   **Feature**: Auto-detection of `lldb-dap` path or a configuration option to specify it.

### 4. Integration Tests
*   **Description**: End-to-end tests that launch the Zig harness, set a breakpoint, and verify the stack trace.

## Suggested Roadmap

1.  **Setup**: Clone `mcp-debugger` and explore the existing adapter interface.
2.  **Harness**: Create the Zig project first to have a target.
3.  **Adapter**: Implement `ZigAdapter` and get basic stepping working.
4.  **Polish**: Docs and Tests.

## User Action Required
*   **Approval**: Do you agree with using `lldb-dap`?
