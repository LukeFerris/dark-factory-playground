---
name: check-patterns
description: |
  **Pattern & Fallback Checker**: Audits staged git changes for duplicated patterns,
  reinvented systems, and unnecessary fallbacks or backwards-compatibility shims.
  Trigger: "/check-patterns", "check for pattern duplication", "check for fallbacks",
  or automatically via pre-commit hook instruction.
---

# Pattern & Fallback Checker

You are auditing the currently staged git changes for two categories of anti-pattern. Your job is to catch problems **before** they are committed — flag issues and ask the user how to proceed rather than silently fixing them.

## What to Check

### 1. Reinvented Patterns & Duplicated Systems

Look for staged code that replicates functionality already present elsewhere in the codebase:

- **New utility functions** that duplicate existing helpers (string formatting, date manipulation, data transformation, etc.)
- **New modules or classes** that overlap substantially with an existing module's responsibility
- **Reimplemented algorithms** or data flows that already exist in a different form
- **New abstractions** layered on top of systems that already expose the needed interface directly
- **Copy-pasted logic** that should be extracted into a shared location or should directly use the existing implementation

### 2. Unnecessary Fallbacks & Backwards Compatibility

Look for staged code that papers over upstream inconsistencies instead of fixing them at the source:

- **Fallback values** (`?? defaultValue`, `|| fallback`) where the upstream should guarantee the value exists — especially when the upstream is code we own
- **Type coercion or normalization** that compensates for inconsistent data shapes from our own services
- **Defensive null checks** for values that should never be null if the data source is correct
- **Multiple code paths** handling "old format" vs "new format" of internal data when the old format should simply be migrated
- **Adapter layers** that translate between two internal interfaces that should just be unified
- **Feature flags or conditional logic** protecting dead code paths that will never be re-enabled

## Procedure

1. **Get the staged diff:**

   ```bash
   git diff --cached --name-only
   git diff --cached
   ```

2. **For each changed file**, read the full diff and identify any new code (added lines) that falls into the categories above.

3. **Cross-reference against the codebase:**
   - For suspected duplications: search for existing implementations of the same concept. Use `grep`, file reads, and your understanding of the project structure.
   - For suspected fallbacks: trace the data flow upstream. Is the fallback compensating for a bug or inconsistency in code we control? If so, the fix belongs upstream.

4. **Report findings** — for each issue found, report:
   - The file and line range
   - What anti-pattern category it falls into
   - The existing code it duplicates OR the upstream source that should be fixed instead
   - A suggested resolution (use existing code / fix upstream / consolidate)

5. **Ask for direction** — do not auto-fix. Present your findings and ask:
   > "I found [N] potential issues in the staged changes. Should I consolidate these, or are any of them intentional?"

## When Nothing Is Found

If the staged changes look clean — no duplications, no unnecessary fallbacks:

1. Write the **hash of the current staged diff** into the stamp file. The pre-commit gate verifies this exact hash on commit, so the audit is bound to what's about to be committed — not just "any audit at any time":
   ```bash
   git diff --cached | sha256sum | awk '{print $1}' > .patterns-checked
   ```
2. Report briefly:
   > "Staged changes look clean — no duplicated patterns or unnecessary fallbacks detected. Stamp written (hash-bound to the current staged diff). Commit will proceed unless you stage more files or lint-staged mutates anything."

If the user stages more files after the audit, or lint-staged auto-fixes something during the commit run, the hash will no longer match and the gate will refuse the commit — re-run the audit at that point.

## Important Guidelines

- Only flag things you're confident about. A false positive wastes the user's time.
- "Duplicated" means substantially the same responsibility, not just superficial similarity (e.g. two functions that both loop over arrays are not duplicates just because they both loop).
- Fallbacks for **external** data (user input, third-party APIs) are legitimate. Only flag fallbacks for data flowing from code we own and control.
- Consider whether the "existing" code is actually reachable/importable from the new location. If architectural boundaries make reuse impractical, note that in your finding.
- Keep reports concise. One paragraph per finding, max.
