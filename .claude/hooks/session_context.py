"""SessionStart hook: regenerates the project map and injects a digest into context.

Full map files (~0.5 MB + 1.5 MB) exceed the 10k-char hook output cap,
so only a digest goes into context; the full files are referenced by path.
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "project_context.py"
OUT_DIR = ROOT / "_claude_context"
MD = OUT_DIR / "PROJECT_CONTEXT_MAP.md"
JSON_PATH = OUT_DIR / "project_context_map.json"
BUDGET = 9500


def main() -> None:
    lines: list[str] = []
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=ROOT, capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=110,
    )
    if proc.returncode != 0:
        lines.append(f"WARNING: project_context.py failed (exit {proc.returncode}): {proc.stderr[-500:]}")

    lines.append("# Project context map (auto-generated at session start)")
    lines.append(f"Full map: {MD} (navigation map; grep/Read sections as needed, do not read whole).")
    lines.append(f"Full JSON (per-file functions/classes/imports/deps): {JSON_PATH}")

    try:
        data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        lines.append(f"Could not read JSON map: {exc}")
        emit(lines)
        return

    files = data.get("files", [])
    lines.append(f"Generated: {data.get('generated_at')} | files: {len(files)}")
    lines.append("")
    lines.append("## Code files by directory (file: top functions)")

    by_dir: dict[str, list[dict]] = defaultdict(list)
    for f in files:
        # functions/lib/ is compiled output mirroring functions/src/ 1:1.
        if f.get("kind") in ("markdown", "config") or f["path"].startswith(("DOCS/", "tests/", "functions/lib/")):
            continue
        by_dir[str(Path(f["path"]).parent).replace("\\", "/")].append(f)

    priority = ("functions/src", "public")
    dirs = sorted(by_dir, key=lambda d: (not d.startswith(priority), d))

    def dir_line(d: str, n_fns: int) -> str:
        if n_fns < 0:
            return f"- {d}/: {len(by_dir[d])} files"
        parts = []
        for f in sorted(by_dir[d], key=lambda x: x["path"]):
            fns = [fn.get("name", fn) if isinstance(fn, dict) else fn for fn in f.get("functions", [])][:n_fns]
            name = Path(f["path"]).name
            parts.append(f"{name}({', '.join(fns)})" if fns else name)
        return f"- {d}/: " + "; ".join(parts)

    # Every directory must appear. Start at file names only (0 functions per file),
    # then spend leftover budget on function names: priority dirs first, up to 4 each.
    # If even names-only overflows, non-priority dirs collapse to a file count.
    caps = {d: 0 for d in dirs}

    def size() -> int:
        return len("\n".join(lines)) + sum(len(dir_line(d, caps[d])) + 1 for d in dirs)

    for d in reversed(dirs):
        if size() <= BUDGET:
            break
        if not d.startswith(priority):
            caps[d] = -1

    tiers = [[d for d in dirs if d.startswith(priority)], [d for d in dirs if not d.startswith(priority)]]
    for tier in tiers:
        for n in range(1, 5):
            for d in tier:
                if caps[d] != n - 1:
                    continue
                caps[d] = n
                if size() > BUDGET:
                    caps[d] = n - 1

    lines.extend(dir_line(d, caps[d]) for d in dirs)
    emit(lines)


def emit(lines: list[str]) -> None:
    text = "\n".join(lines)
    if len(text) > BUDGET:
        text = text[:BUDGET] + "\n... [digest truncated — see full map files above]"
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
