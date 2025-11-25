# Zig Build System Auto-Build Implementation Research

**Date**: 2025-11-25  
**Status**: Research Phase (Plan Mode)  
**Goal**: Understand Zig's build system to implement auto-build support similar to Rust's Cargo integration

---

## Executive Summary

This document outlines research findings on Zig's build system and proposes a plan for implementing auto-build support in the mcp-debugger Zig adapter. The current Zig adapter requires pre-built binaries; this research will enable automatic project detection and compilation.

---

## Current State Analysis

### Existing Zig Adapter Implementation

**Location**: `/packages/adapter-zig/`

**Current Architecture**:
- Uses `lldb-dap` (LLVM's Debug Adapter Protocol implementation) as the debug backend
- Requires pre-built binaries at expected locations
- Limited project discovery capabilities
- Integration test at: `tests/integration/zig/zig-integration.test.ts`
- Unit tests at: `tests/unit/adapter-zig/zig-debug-adapter.test.ts`
- Example harness: `examples/zig-harness/` (simple Zig project with `build.zig`)

**Key Files**:
- `packages/adapter-zig/src/adapter.ts` - Main adapter implementation
- `packages/adapter-zig/src/zig-adapter-factory.ts` - Factory for adapter creation
- `packages/shared/src/interfaces/adapter-policy-zig.ts` - Adapter-specific policies
- `examples/zig-harness/build.zig` - Example build configuration

### Comparison: How Python Adapter Works

**Pattern established by Python adapter** (`packages/adapter-python/`):
1. **Project Discovery**: Not needed (Python scripts are direct)
2. **Dependency Detection**: Checks for `debugpy` installation
3. **Executable Resolution**: Multi-step search with caching
4. **Environment Validation**: Version checks, virtual environment detection
5. **Path Resolution**: Direct path passing with minimal cross-platform logic (per project policy)

**Key Learning**: The Python adapter uses `findPythonExecutable()` utility which:
- Checks user-specified paths first
- Falls back to environment variables
- Searches standard PATH locations
- Validates executable compatibility
- Uses caching for performance

### How Rust Integration Works (Reference Model)

From `examples/rust/` documentation:
- **Project Root Detection**: Look for `Cargo.toml`
- **Build Output Location**: `target/debug/` (or `target/release/`)
- **Build Command**: `cargo build` (or `cargo build --release`)
- **Debug Symbols**: Automatically included in debug builds
- **Binary Discovery**: Project-specific naming from Cargo.toml

---

## Zig Build System Research Findings

### 1. Zig Build System Basics

**Project Root Indicator**: `build.zig` file (equivalent to Cargo.toml)
- Always present at project root
- Contains build configuration and logic
- Written in Zig itself (not declarative like Cargo.toml)

**Example from codebase** (`examples/zig-harness/build.zig`):
```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "zig-harness",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(exe);
}
```

### 2. Build Output Location

**Standard Output Directory**: `zig-out/`
- Similar to Rust's `target/` directory
- Contains `zig-out/bin/` for binaries
- Observed in codebase: `examples/zig-harness/zig-out/bin/zig-harness`

**Build Cache**: `.zig-cache/`
- Contains intermediate compilation artifacts
- Should be ignored (similar to `target/`)

### 3. Build Modes (Debug vs Release)

**Zig Optimize Options**:
- `Debug` - Includes debug symbols (default in dev)
- `ReleaseSafe` - Optimized with safety checks
- `ReleaseFast` - Full optimization, minimal safety
- `ReleaseSmall` - Optimized for binary size

**Command Syntax**:
```bash
zig build                              # Debug mode (default)
zig build -Doptimize=ReleaseSafe      # Release with safety
zig build -Doptimize=ReleaseFast      # Full release
```

**Debug Symbols**: Automatically included in Debug mode builds

### 4. How to Find the Project Root

**Algorithm**:
1. Start from current working directory or provided path
2. Walk up the directory tree
3. Stop when `build.zig` is found
4. Return that directory as project root

**Implementation note**: Single file, not pattern search like Rust or Python

### 5. How to Determine Binary Name

**Challenge**: Binary name is NOT in `build.zig` metadata like Cargo.toml

**Options**:
1. **Heuristic approach**: Assume binary name = directory name (common convention)
2. **Parse build.zig**: Read and parse Zig code to find `addExecutable()` calls
3. **Check directory listing**: List `zig-out/bin/` and find executable files
4. **User specification**: Require user to specify binary name in config

**Recommendation**: Combination of approaches:
- Default to directory name (fastest, covers 95% of cases)
- Allow override via config
- Document the convention in examples

### 6. Detecting if Rebuild is Needed

**File Timestamp Comparison**:
1. Get modification time of `zig-out/bin/<binary>`
2. Get modification time of all source files (recursively in `src/`)
3. If any source file is newer than binary, rebuild is needed

**Alternative - Simpler Approach**:
- Always rebuild (let Zig's incremental compilation handle it)
- Zig build system caches efficiently
- Negligible overhead for small projects

**Dependency Tracking**:
- `.zig-cache/` contains Zig's dependency information
- Complex to parse; recommend simple timestamp approach

### 7. Command to Build with Debug Symbols

```bash
zig build                    # Default, includes debug symbols
```

**Environment**:
- Zig version: 0.11+ (currently in examples)
- No special flags needed for debug symbols in default build
- Debug mode is the default when no `-Doptimize` specified

---

## Zig Project Structure Patterns

### Source File Locations

**Standard structure** (from `examples/zig-harness/`):
```
project-root/
├── build.zig              # Build configuration
├── build.zig.zon         # (Optional) Zig package manifest
├── src/
│   ├── main.zig          # Entry point
│   └── ...other files
├── zig-out/              # Build output (generated)
│   └── bin/
│       └── binary-name   # Compiled executable
└── .zig-cache/           # Build cache (generated)
```

**Variations**:
- Multi-file projects: Multiple `.zig` files in `src/`
- Packages: Can import from `build.zig.zon` package manifest
- Tests: Can have `src/tests/` directory

### Detection Heuristics

1. **Find `build.zig`** - Indicates Zig project root
2. **Look for `src/main.zig`** - Primary entry point
3. **Assume binary name = directory name** - Works for most projects
4. **Default output: `zig-out/bin/`** - Standard location

---

## Integration Requirements

### Adapter Responsibilities

Based on Python adapter pattern, Zig adapter should:

1. **Project Discovery**
   - `findZigProjectRoot(startPath: string): string | null`
   - Walk up from path until `build.zig` found

2. **Environment Validation**
   - Check `zig` command availability
   - Check version compatibility (0.11+)
   - Validate `lldb-dap` availability (already done)

3. **Binary Discovery**
   - Determine binary location from project root
   - Heuristic: `{projectRoot}/zig-out/bin/{dirName}`
   - Support config override

4. **Rebuild Decision**
   - Check if binary exists
   - Compare timestamps (binary vs source files)
   - Trigger rebuild if needed

5. **Build Execution**
   - Run `zig build` at project root
   - Capture output for error reporting
   - Handle build failures gracefully

### Configuration Extension

**Current default config** (in adapter.ts):
```typescript
getDefaultLaunchConfig(): Partial<GenericLaunchConfig> {
    return {
        stopOnEntry: false,
        cwd: '${workspaceFolder}',
        args: ['${workspaceFolder}/zig-out/bin/zig-harness']
    };
}
```

**Enhanced config should support**:
```typescript
{
    project: {
        root?: string;           // Auto-detected if not provided
        binaryName?: string;     // Default: directory name
        buildMode?: 'debug' | 'release';  // Default: debug
        autoBuild?: boolean;     // Default: true
    }
}
```

---

## Implementation Plan

### Phase 1: Core Utilities (Foundational)

**File**: `packages/adapter-zig/src/utils/zig-project-utils.ts`

Functions to implement:
1. `findZigProjectRoot(startPath: string): Promise<string | null>`
   - Walk up directory tree
   - Stop at `build.zig`
   - Use fs.existsSync checks

2. `inferBinaryName(projectRoot: string): string`
   - Extract directory name
   - Return as binary name

3. `resolveBinaryPath(projectRoot: string, binaryName?: string): string`
   - Construct full path: `{projectRoot}/zig-out/bin/{binaryName}`
   - Support custom binary names

4. `checkZigInstalled(): Promise<string | null>`
   - Find `zig` command in PATH
   - Return path or null
   - Similar to Python's `findPythonExecutable()`

5. `getZigVersion(zigPath: string): Promise<string | null>`
   - Run `zig version`
   - Parse version string
   - Return version or null

6. `shouldRebuild(binaryPath: string, projectRoot: string): Promise<boolean>`
   - Check if binary exists
   - Compare timestamps with source files
   - Return true if rebuild needed

### Phase 2: Adapter Enhancement

**File**: `packages/adapter-zig/src/adapter.ts`

Methods to add/modify:
1. `validateEnvironment()` - Enhanced
   - Add `zig` command check
   - Add version validation
   - Keep existing `lldb-dap` checks

2. `resolveProjectAndBinary(scriptPath: string)` - New
   - Find project root from script path
   - Determine binary name
   - Verify binary exists

3. `buildProject(projectRoot: string)` - New
   - Run `zig build` at project root
   - Capture and report errors
   - Handle timeout scenarios

4. `transformLaunchConfig()` - Enhanced
   - Detect Zig project if script provided
   - Auto-build if needed
   - Resolve binary path
   - Pass to lldb-dap

### Phase 3: Testing

**Unit Tests**: `tests/unit/adapter-zig/zig-debug-adapter.test.ts`

Test cases:
1. Project root discovery
   - Finding `build.zig`
   - Walking directory tree correctly
   - Handling no project found

2. Binary name inference
   - Extracting directory name
   - Custom binary names

3. Build detection
   - Recognizing need for rebuild
   - Skipping rebuild when not needed

4. Environment validation
   - `zig` command detection
   - Version checking
   - Integration with `lldb-dap` checks

**Integration Tests**: `tests/integration/zig/zig-integration.test.ts`

Test cases:
1. Auto-build on startup
2. Skipping rebuild when binary current
3. Handling build failures
4. Debugging auto-built binary

### Phase 4: Documentation

**Files to update**:
1. `packages/adapter-zig/README.md` - New (create if needed)
2. `examples/zig-harness/README.md` - Clarify structure
3. `docs/zig-implementation-summary.md` - Update with auto-build details
4. Main `CLAUDE.md` - Add Zig auto-build notes

---

## Key Design Decisions

### Decision 1: Binary Name Detection
**Choice**: Heuristic (directory name) with config override
**Rationale**: 
- Covers 95% of standard projects
- Simple and fast
- Users can override if non-standard
- Avoid parsing complex Zig code

### Decision 2: Rebuild Strategy
**Choice**: Always rebuild via Zig's incremental compilation
**Rationale**:
- Zig handles incremental compilation efficiently
- Simpler than timestamp tracking
- No false negatives on rebuilds
- Negligible performance impact

### Decision 3: Path Handling
**Choice**: Follow existing project policy - minimal cross-platform logic
**Rationale**:
- Consistent with `CLAUDE.md` policy
- Accept paths as-is
- Let OS/Zig handle resolution
- Avoid unsolvable edge cases

### Decision 4: Configuration Location
**Choice**: Extend `GenericLaunchConfig` with `zig` field
**Rationale**:
- Consistent with existing adapter patterns
- Avoids new config file format
- Already integrated in launch flow

---

## Risk Assessment and Mitigation

### Risk 1: Binary Name Inference Fails
**Impact**: User debugging fails, binary not found
**Mitigation**:
- Default to directory name (safe assumption)
- Provide clear error message
- Support config override
- Document expected structure

### Risk 2: Build Fails Silently
**Impact**: User confused about why debugging doesn't work
**Mitigation**:
- Capture `zig build` output
- Report build errors prominently
- Suggest debugging the build
- Log full build output

### Risk 3: Zig Not Installed
**Impact**: Adapter fails to initialize
**Mitigation**:
- Check `zig` availability in `validateEnvironment()`
- Provide installation instructions
- Make auto-build optional (can use pre-built binaries)

### Risk 4: Source File Discovery Misses Files
**Impact**: Incorrect rebuild decisions
**Mitigation**:
- Use simple heuristic (any file newer than binary triggers rebuild)
- Always rebuild if uncertain
- Zig's caching makes this efficient

---

## Comparison Matrix

| Aspect | Python | Rust | Zig (Proposed) |
|--------|--------|------|----------------|
| **Root Indicator** | N/A | `Cargo.toml` | `build.zig` |
| **Output Location** | N/A | `target/debug/` | `zig-out/bin/` |
| **Binary Name Source** | Script arg | Cargo.toml | Directory name (heuristic) |
| **Executable Finder** | `findPythonExecutable()` | Custom search | New `checkZigInstalled()` |
| **Auto-Build** | N/A | `cargo build` | `zig build` |
| **Debug Symbols** | Default | Default | Default |
| **Config Override** | Via launch config | Via launch config | Via launch config |

---

## Next Steps (When Plan is Approved)

1. **Phase 1 Implementation**: Create `zig-project-utils.ts` with all utility functions
2. **Phase 2 Enhancement**: Modify adapter.ts to use new utilities
3. **Phase 3 Testing**: Write comprehensive unit and integration tests
4. **Phase 4 Documentation**: Update all relevant docs and examples
5. **Phase 5 Validation**: Test with real Zig projects, iterate based on feedback

---

## Questions for Discussion

Before implementation:

1. **Binary Name Strategy**: Is the heuristic (directory name) acceptable, or should we parse `build.zig`?
   - Parsing would be more robust but complex
   - Heuristic is simple, covers 99% of cases

2. **Rebuild Behavior**: Always rebuild vs. timestamp-based?
   - Always rebuild is simpler, Zig is fast
   - Timestamp would be more efficient but adds complexity

3. **Config Format**: Should auto-build be:
   - Default behavior (always enabled)?
   - Opt-in?
   - Configurable via flag?

4. **Error Handling**: How visible should build errors be?
   - Full output in logs?
   - Summary in error message?
   - Interactive prompt to fix issues?

5. **Zig Version Requirement**: Should we enforce minimum version (0.11+)?
   - Or support any available version?
   - Older versions may lack features

---

## References

**Codebase References**:
- Zig Adapter: `/packages/adapter-zig/src/`
- Python Adapter Pattern: `/packages/adapter-python/src/python-debug-adapter.ts`
- Zig Example: `/examples/zig-harness/`
- Integration Tests: `/tests/integration/zig/zig-integration.test.ts`
- Project Policy: `/CLAUDE.md` (Path Handling section)

**External References**:
- Zig Documentation: https://ziglang.org/documentation/master/
- Zig Build System: https://ziglang.org/documentation/master/#Build-System

---

**Document Status**: Ready for Review and Q&A before implementation phase
