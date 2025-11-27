# Zig Debug Harness

A simple Zig project for testing the mcp-debugger Zig adapter.

## Building

```bash
zig build
```

The binary is output to `zig-out/bin/zig-harness`.

## Running

```bash
./zig-out/bin/zig-harness
```

Expected output:
```
Hello, world! x=11, y=21, z=32
i=0, value=0, total=0
i=1, value=2, total=2
...
i=9, value=18, total=90
Final total: 90
```

## Debugging

This project is designed for testing:
- Breakpoint setting and hitting
- Variable inspection (integers, computed values)
- Stepping through loops
- Stack trace inspection
- Conditional breakpoints

### Key Debugging Points

| Line | Code | Good For |
|------|------|----------|
| 8 | `x += 1;` | Simple variable mutation |
| 11 | `const z = x + y;` | Computed value inspection |
| 20 | `const value = i * 2;` | Loop iteration, conditional breakpoints |
| 21 | `total += value;` | Accumulator inspection |

### Variables Available

- `x` (i32) - Starts at 10, incremented to 11
- `y` (i32) - Starts at 20, incremented to 21
- `z` (i32) - Computed sum of x + y (32)
- `i` (usize) - Loop counter 0-9
- `value` (usize) - Computed as i * 2
- `total` (usize) - Running sum, ends at 90

### Test Scenarios

#### Basic Breakpoint Test
1. Set breakpoint at line 11
2. Start debugging
3. Continue to breakpoint
4. Inspect variables: x=11, y=21
5. Step over to see z computed

#### Conditional Breakpoint Test
1. Set breakpoint at line 20 with condition `i > 5`
2. Start debugging
3. Program should stop at i=6 (first time condition is true)
4. Continue - should stop at i=7, i=8, i=9
5. Continue - program completes

#### Loop Stepping Test
1. Set breakpoint at line 20
2. Start debugging
3. Step over repeatedly to watch i increment
4. Inspect total growing: 0, 2, 6, 12, 20, 30, 42, 56, 72, 90

## Prerequisites

- Zig 0.11+ (`zig version`)
- LLVM with lldb-dap (`lldb-dap --version`)

See [Zig Setup Guide](../../docs/zig-setup.md) for installation instructions.
