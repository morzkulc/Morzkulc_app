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
        if f.get("kind") in ("markdown", "config") or f["path"].startswith(("DOCS/", "tests/")):
            continue
        by_dir[str(Path(f["path"]).parent).replace("\\", "/")].append(f)

    priority = ("functions/src", "public")
    dirs = sorted(by_dir, key=lambda d: (not d.startswith(priority), d))
    for d in dirs:
        parts = []
        for f in sorted(by_dir[d], key=lambda x: x["path"]):
            fns = [fn.get("name", fn) if isinstance(fn, dict) else fn for fn in f.get("functions", [])][:4]
            name = Path(f["path"]).name
            parts.append(f"{name}({', '.join(fns)})" if fns else name)
        lines.append(f"- {d}/: " + "; ".join(parts))

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
