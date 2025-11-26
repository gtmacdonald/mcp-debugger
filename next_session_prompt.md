# System Handoff Document: mcp-debugger

**Date:** 2025-11-25
**Project:** mcp-debugger
**Version:** 0.17.0+ (Dev)
**Status:** Stable / Active Development

---

## 1. Executive Summary

You are picking up the development of `mcp-debugger`, a Model Context Protocol (MCP) server designed to give AI agents "debugging superpowers." It acts as a bridge between LLMs and the Debug Adapter Protocol (DAP), allowing agents to launch, control, and inspect debug sessions for various programming languages.

**Current State:**
The project has just completed a significant milestone: **Expression Evaluation Improvements**. The `evaluate_expression` tool now provides:
- Rich object previews with automatic property expansion (depth 1, up to 5 properties)
- Smart truncation for large results (200 char strings, 3 array items preview)
- Structured error reporting with error category, message, and actionable suggestions

The codebase is stable, builds successfully, and passes all 71+ unit tests. The next phase focuses on verifying cross-language support and polishing conditional breakpoints.

---

## 2. System Architecture Deep Dive

The system is built on a modular **Adapter Pattern** to support multiple languages without cluttering the core logic.

### 2.1 Core Components

*   **`src/server.ts` (The Brain):**
    *   This is the MCP server entry point. It defines the tools exposed to the AI agent (e.g., `create_debug_session`, `step_over`, `get_variables`).
    *   It routes requests to the `SessionManager`.
    *   **Recent Change:** The `pause_execution` tool definition was updated to remove the "(Not Implemented)" tag, and a `handlePause` method was added.

*   **`src/session/session-manager.ts` & `session-manager-operations.ts` (The Orchestrator):**
    *   Manages the lifecycle of debug sessions.
    *   `SessionManagerOperations` contains the business logic for DAP commands. It handles the complexity of mapping high-level MCP intents (like "pause") to low-level DAP requests.
    *   **Key Logic:** It maintains the state of each session (`PAUSED`, `RUNNING`, `STOPPED`) and ensures valid transitions.

*   **`src/proxy/proxy-manager.ts` (The Bridge):**
    *   Spawns and manages the child processes for debug adapters (e.g., `debugpy`, `lldb-dap`).
    *   Handles the JSON-RPC communication over stdio or sockets.
    *   It abstracts the transport layer, so the `SessionManager` doesn't care if the adapter is a local process or a remote socket.

### 2.2 The Adapter Pattern (`packages/adapter-*`)

Each supported language has its own package that implements the `IDebugAdapter` interface. This allows for language-specific logic (like building binaries or finding executables) to be encapsulated.

*   **`packages/adapter-zig` (NEW):**
    *   **Implementation:** Uses `lldb-dap` (part of LLVM) as the backend.
    *   **Auto-Build:** Includes logic to automatically detect `.zig` files and run `zig build` if necessary before starting the debug session. This is a critical convenience feature for agents that might simply point to a source file.
    *   **Policy:** Defined in `packages/shared/src/interfaces/adapter-policy-zig.ts`, it tells the core system how to handle Zig-specific quirks (e.g., variable scoping, thread events).

---

## 3. Recent Implementation Details

### 3.1 Expression Evaluation Improvements (Just Completed)
The `evaluate_expression` tool has been significantly enhanced in `src/session/session-manager-operations.ts`:

**Rich Object Previews:**
- When DAP returns a `variablesReference > 0`, we automatically expand the object to show its properties
- Uses `buildObjectPreview()` to fetch children via the `variables` DAP request
- Detects arrays vs objects based on type hints and variable names
- Filters internal properties (e.g., `__class__`, `__dict__`, `_private`) for cleaner output

**Smart Truncation:**
- Constants defined at top of file: `PREVIEW_MAX_PROPERTIES = 5`, `PREVIEW_MAX_STRING_LENGTH = 200`, `PREVIEW_MAX_ARRAY_ITEMS = 3`
- Array preview: `[1, 2, 3, ... (100 total)]`
- Object preview: `{ id: 1, name: "Alice", ... (2 more) }`

**Structured Error Reporting:**
- New `EvaluateErrorInfo` interface with `category`, `message`, `suggestion`, `originalError`
- `parseEvaluationError()` detects: SyntaxError, NameError, TypeError, AttributeError, IndexError, KeyError, ValueError, RuntimeError
- Provides actionable suggestions like "Use get_local_variables to see available variables in scope"

### 3.2 Pause Execution Feature
The `pause_execution` feature was non-trivial because the DAP `pause` request requires a `threadId`, but the `SessionManager` might not know the active thread ID if the program is running freely.

*   **Solution:** In `SessionManagerOperations.pause()`, we implemented a fallback mechanism.
    1.  Check if we already have a `currentThreadId`.
    2.  If not, send a `threads` DAP request to the adapter to fetch active threads.
    3.  Use the first returned thread ID.
    4.  If that fails (some adapters don't respond to `threads` while running), default to `threadId: 1`.
*   **Status:** Verified with unit tests covering all these scenarios.

### 3.3 Zig Adapter
*   **Discovery:** The adapter automatically searches for `lldb-dap` in common paths (Homebrew, LLVM installs).
*   **Build System:** It parses `build.zig` to find the output binary or defaults to `zig-out/bin`.
*   **Testing:** Integration tests were added to verify that the adapter can launch a Zig harness and hit breakpoints.

---

## 4. Codebase Map

*   **`src/`**: Core server logic.
    *   `server.ts`: Main MCP server.
    *   `session/`: Session management logic.
    *   `proxy/`: DAP communication layer.
*   **`packages/`**: Monorepo packages.
    *   `adapter-zig/`: **[NEW]** Zig adapter implementation.
    *   `adapter-python/`: Python adapter.
    *   `adapter-javascript/`: Node.js adapter.
    *   `shared/`: Shared interfaces and types.
*   **`tests/`**: Test suite.
    *   `core/unit/session/`: Unit tests for session logic.
    *   `adapters/*/integration/`: Integration tests for specific languages.

---

## 5. Testing Strategy & Nuances

The project uses `vitest` for testing, but there is a "gotcha" with the `npm test` command.

*   **The Docker Issue:** `npm test` is configured to build a Docker container for end-to-end tests. This often fails in local environments without a specific Docker setup.
*   **The Workaround:** Always run unit tests directly using `npx vitest`.
    *   **Command:** `npx vitest run tests/core/unit/session/session-manager-dap.test.ts`
*   **New Tests:**
    *   `tests/core/unit/session/session-manager-dap.test.ts`: Contains the new `pause` tests.
    *   `tests/integration/zig/`: Contains Zig integration tests.

---

## 6. Known Issues & Technical Debt

1.  **Thread ID Discovery:** The "fetch threads before pause" logic is a heuristic. In extremely high-load scenarios or with certain strict adapters, this might time out. Future work could involve tracking thread creation/exit events more aggressively.
2.  **Linting Strictness:** The linter is very strict about unused variables (`_` prefix required) and `any` types. We fixed the recent violations, but be mindful of this when adding new code.
3.  **Docker Dependency:** The reliance on Docker for the main test script makes CI/CD robust but local development slightly annoying. A "local-only" test script would be a good quality-of-life improvement.

---

## 7. Next Session Objectives

The immediate goal is to **verify cross-language expression evaluation** and **polish conditional breakpoints**.

### 7.1 Cross-Language Expression Evaluation Verification
*   **Current State:** Rich previews and structured errors implemented in core.
*   **Goal:** Verify the improvements work correctly across all supported adapters.
*   **Tasks:**
    *   Test `evaluate_expression` with JavaScript adapter (js-debug) - verify object previews work
    *   Test with Rust adapter (CodeLLDB) - verify struct/enum previews work
    *   Test with Zig adapter (lldb-dap) - verify basic evaluation works
    *   Add integration tests for complex object evaluation if missing

### 7.2 Conditional Breakpoints Polish
*   **Current State:** Functional but feedback is poor.
*   **Goal:** Better verification and error messaging.
*   **Requirements:**
    *   If a user sets a condition `x > 5` but `x` doesn't exist, bubble up validation errors from the adapter
    *   Capture and surface the `message` field from breakpoint verification responses
    *   Consider adding a `validateCondition` helper that pre-checks expression syntax

### 7.3 Optional: Watch Expressions Prototype
*   If time permits, explore adding a `watch` tool that maintains a list of expressions and evaluates them after each stop event
*   This would be a natural extension of the expression evaluation work

---

## 8. The Prompt for the Next Agent

**Copy and paste the following prompt to start the next session:**

```text
You are an expert software engineer working on the `mcp-debugger` project.

**Context:**
We have just completed significant improvements to expression evaluation:
- Rich object previews with automatic property expansion
- Smart truncation for large results (200 char strings, 3 array items, 5 object properties)
- Structured error reporting with categories and actionable suggestions

The codebase passes all 71+ unit tests. Your objective is to verify cross-language support and polish conditional breakpoints.

**Your Mission:**
1.  **Verify Cross-Language Support**: Test `evaluate_expression` with different adapters:
    *   JavaScript: Run `npx vitest run tests/adapters/javascript/integration/` and verify object previews
    *   Rust: Test with CodeLLDB adapter if available
    *   Zig: Test with lldb-dap adapter
2.  **Polish Conditional Breakpoints**:
    *   Review `setBreakpoint` in `session-manager-operations.ts`
    *   Improve validation error bubbling when conditions reference undefined variables
    *   Surface the `message` field from breakpoint verification responses to the user
3.  **Optional - Watch Expressions**: If time permits, prototype a `watch` tool that:
    *   Maintains a list of expressions per session
    *   Evaluates them after each stop event
    *   Returns all watch results in a single response

**Key Files:**
*   `src/session/session-manager-operations.ts` - Core operations including `evaluateExpression` and `setBreakpoint`
*   `tests/unit/session-manager-operations-coverage.test.ts` - Unit tests (71+ tests)
*   `tests/adapters/*/integration/` - Integration tests per adapter

**Constraints:**
*   Run tests using `npx vitest run <file>` to avoid Docker build issues.
*   Maintain strict type safety and linting standards (no unused vars, avoid `any`).
*   Update `Roadmap.md` with any completed work.

Start by running the JavaScript integration tests to verify expression evaluation.
```
