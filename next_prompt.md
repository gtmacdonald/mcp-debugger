# Session Task: Release Preparation & Roadmap Update

**Priority**: Medium
**Date**: 2025-11-26
**Estimated Scope**: Documentation + minor code review

---

## Objective

Prepare for the next release by updating documentation to reflect recent work and ensuring the codebase is release-ready.

---

## Background

Recent sessions completed significant work:
- Expression evaluation verified across all 4 languages (Python, JavaScript, Rust, Zig)
- Conditional breakpoints tested and documented for all languages
- Comprehensive Zig documentation added
- CLAUDE.md updated with all language requirements

The Roadmap.md and CHANGELOG.md need updates to reflect this completed work.

---

## Tasks

### 1. Update Roadmap.md

Current state shows some items as pending that are now complete:
- Conditional breakpoints: Add checkmarks for Rust/Zig testing
- Update "Last updated" date
- Move completed items to "Recently Delivered"

### 2. Update CHANGELOG.md

Add unreleased section entries for:
- Conditional breakpoint integration tests (Python, JS, Rust, Zig)
- Zig documentation expansion
- Language-specific condition syntax documentation
- examples/zig-harness/README.md

### 3. Review Test Coverage

Run test coverage and verify new tests are properly integrated:
```bash
npm run test:coverage:summary
```

Check that conditional breakpoint tests show up in coverage.

### 4. Verify All Tests Pass

```bash
npm test
```

Ensure no regressions from recent changes.

### 5. Consider Version Bump

Current unreleased work includes:
- Zig adapter (Alpha)
- Pause execution support
- Expression evaluation improvements
- Conditional breakpoint verification

This could warrant a minor version bump (0.18.0).

---

## Files to Update

1. `Roadmap.md` - Status updates, dates
2. `CHANGELOG.md` - New entries for unreleased work
3. `package.json` - Version bump if releasing

---

## Success Criteria

- [ ] Roadmap reflects current completion status
- [ ] CHANGELOG has entries for all recent work
- [ ] All tests pass
- [ ] Test coverage is acceptable
- [ ] Ready for version bump/release

---

## Alternative Tasks (if release prep not needed)

If release is not imminent, consider instead:

### Source Context Improvements
From Roadmap: "Returns limited context today; needs streaming + caching for large files"
- Investigate current `get_source_context` limitations
- Design streaming approach for large files
- Add LRU caching for repeated reads

### Condition Syntax Pre-validation
From Roadmap: "Pre-validation of condition syntax (some adapters only fail at runtime)"
- Research what validation is possible per adapter
- Add client-side syntax checks where feasible
- Improve error messages for invalid conditions
