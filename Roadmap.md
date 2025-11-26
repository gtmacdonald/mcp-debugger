# mcp-debugger Roadmap

This document captures the forward-looking plan for the debugger and highlights the most recent milestones. It is meant to be a lightweight companion to the changelog.

## 🎯 Active Feature Work

Status snapshot as of **2025‑11‑25**:

### High priority

1. **Expression evaluation parity**
   - ✅ Python sessions now support `evaluate_expression`
   - ✅ Rich object previews with automatic property expansion (depth 1, up to 5 properties)
   - ✅ Smart truncation for large results (200 char strings, 3 array items preview)
   - ✅ Structured error reporting with category, message, and actionable suggestions
   - ⏳ Verify cross-language support (JS, Rust, Zig)

2. **Conditional breakpoints polish**
   - ✅ Server honours condition fields during dry runs
   - ⏳ Improve verification feedback and bring feature to every adapter (JS, Python)

### Medium priority



4. **Source context (`get_source_context`)**
   - Returns limited context today; needs streaming + caching for large files

### Lower priority

5. **Remote debugging**
   - API surface exists (host/port) but not wired up
   - Will follow once adapter transport abstraction is solidified

## ✅ Recently Delivered

- **Unreleased** – Zig adapter (Alpha), Pause execution support, Expression evaluation improvements (rich previews, truncation, structured errors)
- **v0.17.0** – Rust adapter backed by CodeLLDB plus richer stepping responses with inline source context
- **v0.16.0** – First-class JavaScript adapter with TypeScript detection, js‑debug vendoring, and adapter policy orchestration
- **v0.15.x** – Self-contained CLI bundle (npx-friendly), proxy diagnostics, Windows CI resiliency
- Earlier releases – Core debugging primitives (session lifecycle, stepping, stack/variable inspection)

## 🔭 Upcoming Milestones

### Q4 2025
- ✅ Ship GA-level expression evaluation (better previews, richer errors)
- Tighten conditional breakpoint UX across adapters
- ✅ Expose pause execution through the proxy API

### Q1 2026
- Adapter-specific hinting for common runtime failures
- Performance work for large variable payloads
- Watch expressions prototype

### Q2 2026
- Remote debugging (attach scenarios, container support)
- Debug console commands routed through adapters
- Publish adapter SDK / authoring guide

### Beyond 2026
- Additional language adapters (Java, C++, Go)
- Advanced breakpoint types (data / function)
- Time-travel debugging exploration
- IDE integrations (VS Code extension, JetBrains Gateway)

## 🤝 Contributing

Want to help? Start by:

1. Browsing [GitHub Issues](https://github.com/debugmcp/mcp-debugger/issues) for tagged roadmap items
2. Opening an issue to discuss your proposal
3. Following the [Contributing Guidelines](./CONTRIBUTING.md)

## 🧭 Implementation Notes

- **Breakpoint verification** still flips to `verified` only after the adapter confirms; UX improvements are planned.
- **Session persistence**: intermittent Windows-specific terminations are largely resolved, but more telemetry will land after pause support.
- **Path handling**: adapters now normalize workspace-relative paths, yet cross-filesystem debug sessions remain on the backlog.

## 🗓 Version History (high level)

- **v0.17.0** – Rust adapter (Alpha), inline source context in stepping tools
- **v0.16.0** – JavaScript adapter, session policy orchestration, handshake instrumentation
- **v0.15.0** – Bundled CLI distribution, Windows CI diagnostics, proxy log capture
- **v0.9.0** – Initial GA with core Python debugging
- **v0.8.0** – Beta release with foundational Python support
- **v0.7.0** – Alpha release for internal testing

---

*Last updated: 2025‑11‑25*
