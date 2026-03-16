# Tools for Agent — Design Reference

Summary of community best practices for implementing file operation tools in LLM agents.

---

## Tool Surface Area

Keep it small. Five categories cover most needs: file operations, search, execution, web, and code intelligence. The LLM is a suggester — the harness validates and applies. Never give the model direct filesystem access.

---

## list_files

- **Respect `.gitignore` by default** — use ripgrep under the hood (inherits gitignore rules automatically). Support a project-specific ignore file (e.g. `.aiignore`).
- **Include metadata** — file size and line count so the agent can decide whether to read before issuing a read call.
- **Depth limit** — default 2–3 levels; let the agent explicitly request deeper traversal.
- **Always skip** `.git`, `node_modules`, build artifacts, even if not in gitignore.

---

## view_file (read_file)

- **Never load full large files** — implement `offset` (1-based line) + `limit` (max lines). Soft default ~500 lines.
- **Show line numbers** — required for the agent to construct correct edit targets (cat -n style).
- **Show truncation notice** — explicitly tell the agent "Showing lines X–Y of Z total." Without this, the agent may assume it has the full file.
- **Support `goto <line>`** — jumping directly to a target area outperforms chaining scroll operations (SWE-agent finding).
- **Binary detection** — check first 8000 bytes for NUL bytes (git's heuristic) before any read/edit. Return a clear error for binaries.

---

## edit_file

Edit format choice is the highest-ROI decision. Aider benchmarks show it can swing task success by **30+ percentage points** on the same model.

### Recommended format: search/replace blocks

```
<<<<<<< SEARCH
<exact lines to find>
=======
<replacement lines>
>>>>>>> REPLACE
```

- Model only returns changed sections (token-efficient)
- Works across all models without fine-tuning
- Primary failure mode: whitespace/indentation mismatch in SEARCH block

### Matching strategy (layered fallback)

1. Exact string match
2. Whitespace-insensitive match (trim per line)
3. Indentation-preserving fuzzy match
4. Levenshtein-distance fuzzy match with similarity threshold
5. Feed failure back to model with actual file content and ask it to rewrite

### Other rules

- **Require unique SEARCH blocks** — reject if `old_str` matches more than once (force model to add more context)
- **Require context lines** — unchanged lines around the target make the match unique
- **Syntax validation gate** — run a linter/parser after applying; reject with the error message if invalid
- **Checkpoint before editing** — git stage or snapshot; enables instant revert
- **Reject lazy elision** — whole-file replacement encourages models to write `# ... rest unchanged ...`, silently deleting code. Prefer search/replace.

---

## summarize_file

No major tool implements a dedicated summarize endpoint. The standard patterns are:

- **Signatures-only mode** — return function/class/type signatures extracted via Tree-sitter, no body content. Most token-efficient "summary."
- **Head preview + targeted reads** — for non-code files (logs, docs): read first N lines/bytes, then agent issues ranged reads as needed.
- **Semantic index** (large codebases only) — pre-compute embeddings for files; inject a repo overview (structure, key packages, core files) at session start. Only worth the overhead above ~1,000 files.

---

## Context Management

- **Track token budget before reads** — check remaining context before loading a file. Truncate to available budget with a notice.
- **The large-file brick problem** — a file exceeding the remaining context window can't be dropped by normal summarization (it's in a recent message). Mitigation: pre-check file size, enforce ignore rules for known large generated files (lock files, build headers).
- **Verbose search results hurt** — SWE-agent found that returning only filenames with matches (not match content) consistently outperforms returning full match context. Counter-intuitive but reliable.

---

## Implementation Checklist

| Concern | Decision |
|---|---|
| Edit format | search/replace blocks (`<<<<<<< SEARCH`) |
| Line numbers in output | always |
| Read limit | 500 lines soft, configurable hard cap |
| Truncation notice | always explicit |
| Gitignore handling | respected by default |
| Binary detection | NUL-byte heuristic before read/edit |
| Edit matching | layered fallback (exact → whitespace → fuzzy → LLM retry) |
| Unique SEARCH enforcement | reject multi-match, ask for more context |
| Post-edit validation | syntax check, reject on failure |
| Directory depth cap | 2–3 levels default |
| Metadata in listings | size + line count |
