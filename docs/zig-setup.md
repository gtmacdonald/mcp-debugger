# Zig Debugging Setup Guide

This guide covers setting up and using Zig debugging with mcp-debugger.

## Prerequisites

### LLVM (includes lldb-dap)

The Zig adapter uses `lldb-dap` from LLVM for Debug Adapter Protocol communication.

**macOS (Homebrew)**:
```bash
brew install llvm

# Add to PATH (Apple Silicon)
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"

# Add to PATH (Intel Mac)
export PATH="/usr/local/opt/llvm/bin:$PATH"

# Verify installation
lldb-dap --version
```

**Linux (Debian/Ubuntu)**:
```bash
sudo apt install llvm lldb

# Verify
lldb-dap --version
```

**Linux (Fedora/RHEL)**:
```bash
sudo dnf install llvm lldb

# Verify
lldb-dap --version
```

### Zig Compiler

**macOS**:
```bash
brew install zig
zig version  # Should be 0.11.0+
```

**Linux (Snap)**:
```bash
snap install zig --classic
zig version
```

**Manual Install**:
Download from [ziglang.org/download](https://ziglang.org/download/) and add to PATH.

## Quick Start

### 1. Create Debug Session

```json
{
  "tool": "create_debug_session",
  "arguments": {
    "language": "zig",
    "name": "My Zig Debug Session"
  }
}
```

### 2. Build Your Project

Ensure debug symbols are included (default in debug builds):
```bash
cd your-zig-project
zig build
```

For projects without `build.zig`, compile directly:
```bash
zig build-exe main.zig -femit-bin=main
```

### 3. Set Breakpoint

```json
{
  "tool": "set_breakpoint",
  "arguments": {
    "sessionId": "...",
    "file": "/path/to/main.zig",
    "line": 10
  }
}
```

### 4. Start Debugging

```json
{
  "tool": "start_debugging",
  "arguments": {
    "sessionId": "...",
    "scriptPath": "/path/to/zig-out/bin/my-program"
  }
}
```

### 5. Debug Operations

Once paused at a breakpoint:

- **Step over**: `step_over` tool
- **Step into**: `step_into` tool
- **Step out**: `step_out` tool
- **Continue**: `continue_execution` tool
- **Inspect variables**: `get_local_variables` or `get_variables` tools
- **Evaluate expressions**: `evaluate_expression` tool
- **View stack**: `get_stack_trace` tool

## Conditional Breakpoints

Set breakpoints that only trigger when a condition is true:

```json
{
  "tool": "set_breakpoint",
  "arguments": {
    "sessionId": "...",
    "file": "/path/to/main.zig",
    "line": 20,
    "condition": "i > 5"
  }
}
```

### Condition Syntax

Zig debugging uses LLDB, which expects C-style expressions:

```
// Simple comparisons
"i > 5"
"count == 10"

// Boolean operators (C-style)
"x > 5 && y < 10"
"status == 1 || retry_count >= 3"
"!is_valid"

// Numeric comparisons
"value >= 100"
"index < array_len"
```

**Note**: Use `&&`/`||`/`!` for boolean operators, not `and`/`or`/`not`.

## Expression Evaluation

Evaluate expressions in the current debug context:

```json
{
  "tool": "evaluate_expression",
  "arguments": {
    "sessionId": "...",
    "expression": "i * 2"
  }
}
```

LLDB evaluates expressions using C semantics. For Zig-specific types, results may show underlying representations.

## Architecture

- **Adapter**: `packages/adapter-zig` - Implements `IDebugAdapter` interface
- **Backend**: Uses `lldb-dap` (from LLVM) for DAP protocol communication
- **Connection**: TCP connection to lldb-dap in listen mode

## Troubleshooting

### lldb-dap Not Found

**Symptom**: Error "lldb-dap not found" or "Failed to start debug adapter"

**Solution**:
1. Install LLVM: `brew install llvm` (macOS) or `apt install llvm lldb` (Linux)
2. Add to PATH:
   ```bash
   # Apple Silicon Mac
   export PATH="/opt/homebrew/opt/llvm/bin:$PATH"

   # Intel Mac
   export PATH="/usr/local/opt/llvm/bin:$PATH"
   ```
3. Verify: `which lldb-dap` and `lldb-dap --version`

### Breakpoint Not Hit

**Symptom**: Breakpoint set but program runs past it

**Possible Causes**:
1. **No debug symbols**: Rebuild with `zig build` (debug mode is default)
2. **Wrong file path**: Use absolute paths
3. **Code optimized out**: Ensure you're building in debug mode, not release
4. **Line not executable**: Set breakpoint on a statement, not a declaration or blank line

**Debug symbols check**:
```bash
# Check if binary has debug info
dwarfdump --debug-info zig-out/bin/your-program | head -50
```

### Variables Not Showing

**Symptom**: Variable inspection returns empty or shows unexpected values

**Possible Causes**:
1. **Not paused**: Variables only available when paused at breakpoint
2. **Scope issue**: Variable may be optimized out or not yet in scope
3. **Zig-specific types**: Some Zig types may display differently in LLDB

### Connection Timeout

**Symptom**: "Failed to connect to debug adapter" or timeout errors

**Possible Causes**:
1. **Port conflict**: Another process using the debug port
2. **lldb-dap crash**: Check if lldb-dap process started
3. **Firewall**: Ensure localhost connections are allowed

### Build Errors

**Symptom**: Compilation errors when building Zig project

**Solution**:
1. Run `zig build` manually to see full error output
2. Fix compilation errors in your Zig code
3. Ensure `build.zig` is valid
4. Retry debugging

### Zig Version Issues

**Symptom**: Strange behavior, crashes, or incompatibilities

**Solution**:
- Ensure Zig 0.14.0 or later: `zig version`
- Update Zig: `brew upgrade zig` (macOS) or download latest from ziglang.org

## Example Project

The repository includes a test harness at `examples/zig-harness/`:

```bash
cd examples/zig-harness
zig build
# Binary at: zig-out/bin/zig-harness
```

This project is useful for:
- Testing breakpoint setting and hitting
- Variable inspection (integers, loops)
- Stepping through code
- Stack trace inspection

## See Also

- [Tool Reference](./tool-reference.md) - Complete MCP tool documentation
- [Zig Implementation Summary](./zig-implementation-summary.md) - Technical details
- [Architecture Overview](./architecture/README.md) - System design
