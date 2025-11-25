# System Handoff Document: mcp-debugger

**Date:** 2025-11-25
**Project:** mcp-debugger
**Version:** 0.17.0+ (Dev)
**Status:** Stable / Active Development

---

## 1. Executive Summary

You are picking up the development of `mcp-debugger`, a Model Context Protocol (MCP) server designed to give AI agents "debugging superpowers." It acts as a bridge between LLMs and the Debug Adapter Protocol (DAP), allowing agents to launch, control, and inspect debug sessions for various programming languages.

**Current State:**
The project has just completed a significant milestone: the addition of **Zig language support** (Alpha) and the implementation of the **`pause_execution`** tool. The codebase is stable, builds successfully, and passes all relevant unit tests. The next phase of development focuses on refining the debugging experience, specifically improving expression evaluation and conditional breakpoints.

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

### 3.1 Pause Execution Feature
The `pause_execution` feature was non-trivial because the DAP `pause` request requires a `threadId`, but the `SessionManager` might not know the active thread ID if the program is running freely.

*   **Solution:** In `SessionManagerOperations.pause()`, we implemented a fallback mechanism.
    1.  Check if we already have a `currentThreadId`.
    2.  If not, send a `threads` DAP request to the adapter to fetch active threads.
    3.  Use the first returned thread ID.
    4.  If that fails (some adapters don't respond to `threads` while running), default to `threadId: 1`.
*   **Status:** Verified with unit tests covering all these scenarios.

### 3.2 Zig Adapter
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

The immediate goal is to reach feature parity for **Expression Evaluation**.

### 7.1 Expression Evaluation Parity (`evaluate_expression`)
*   **Current State:** Implemented for Python but basic.
*   **Goal:** Make it robust and user-friendly.
*   **Requirements:**
    *   **Object Previews:** Instead of just returning `[Object object]`, return a meaningful preview (e.g., `{ id: 1, name: "foo" }`).
    *   **Truncation:** Handle large objects gracefully. Don't return 10MB of JSON; truncate deep or long structures.
    *   **Error Handling:** If evaluation fails (e.g., syntax error in the expression), return a structured error that helps the agent correct its mistake, rather than a generic "Failed".
    *   **Context:** Ensure it works correctly in different stack frames (already partially supported, but verify).

### 7.2 Conditional Breakpoints Polish
*   **Current State:** Functional but feedback is poor.
*   **Goal:** Better verification.
*   **Requirements:** If a user sets a condition `x > 5` but `x` doesn't exist, the breakpoint might just fail silently or stay "unverified". We need to bubble up validation errors from the adapter if possible.

---

## 8. The Prompt for the Next Agent

**Copy and paste the following prompt to start the next session:**

```text
You are an expert software engineer working on the `mcp-debugger` project.

**Context:**
We have just successfully implemented Zig language support and the `pause_execution` feature. The codebase is in a stable state with all tests passing. Your primary objective for this session is to improve the **Expression Evaluation** capabilities of the debugger to reach feature parity across supported languages.

**Your Mission:**
1.  **Analyze**: Review `src/session/session-manager-operations.ts`, specifically the `evaluateExpression` method. Understand how it currently handles DAP responses.
2.  **Plan**: Design a strategy to improve result rendering. We need:
    *   Rich object previews (not just type names).
    *   Smart truncation for large results to avoid overwhelming the context window.
    *   Structured error reporting for invalid expressions.
3.  **Implement**: Modify `evaluateExpression` to implement these improvements. You may need to update `packages/shared` if you change the return types.
4.  **Verify**: Add unit tests in `tests/core/unit/session/session-manager-dap.test.ts` to cover complex object evaluation and error cases.
5.  **Refine**: If time permits, look at `Roadmap.md` item #2: "Conditional breakpoints polish" and see if you can improve the verification feedback loop.

**Constraints:**
*   Run tests using `npx vitest run <file>` to avoid Docker build issues.
*   Maintain strict type safety and linting standards (no unused vars, avoid `any`).
*   Update `Roadmap.md` if you complete the expression evaluation work.

**Resources:**
*   `next_session_prompt.md` (this file) contains the full system context.
*   `src/session/session-manager-operations.ts` is your main workspace.

Start by exploring the current `evaluateExpression` implementation.
```
