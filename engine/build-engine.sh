#!/usr/bin/env bash
# Build the onefile desktop engine for the platform this script is running on.
#
# Python freezing is not cross-compilation: build each OS on that OS. The
# resulting file is named transcriber-engine-<target-triple> so a Tauri sidecar
# can select it without a post-build rename.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

python_cmd="${PYTHON:-}"
if [[ -z "$python_cmd" && -x "$root/.venv/bin/python" ]]; then
  python_cmd="$root/.venv/bin/python"
fi
if [[ -z "$python_cmd" && -x "$root/.venv/Scripts/python.exe" ]]; then
  python_cmd="$root/.venv/Scripts/python.exe"
fi
if [[ -z "$python_cmd" ]]; then
  python_cmd="$(command -v python3 || command -v python || true)"
fi
if [[ -z "$python_cmd" ]]; then
  echo "ERROR: Python is required to build the frozen engine." >&2
  exit 1
fi

if ! "$python_cmd" -c 'import PyInstaller' >/dev/null 2>&1; then
  echo "ERROR: PyInstaller is not installed for $python_cmd." >&2
  echo "Install it with: $python_cmd -m pip install -r requirements-build.txt" >&2
  exit 1
fi

target_triple=""
if command -v rustc >/dev/null 2>&1; then
  target_triple="$(rustc -vV | awk '$1 == "host:" { print $2 }')"
fi
if [[ -z "$target_triple" ]]; then
  target_triple="$($python_cmd - <<'PY'
import platform
import sys

architecture = {
    "amd64": "x86_64",
    "arm64": "aarch64",
    "aarch64": "aarch64",
    "x86_64": "x86_64",
}.get(platform.machine().casefold())
if architecture is None:
    raise SystemExit(f"Unsupported host architecture: {platform.machine()}")
if sys.platform == "linux":
    print(f"{architecture}-unknown-linux-gnu")
elif sys.platform == "darwin":
    print(f"{architecture}-apple-darwin")
elif sys.platform == "win32":
    print(f"{architecture}-pc-windows-msvc")
else:
    raise SystemExit(f"Unsupported host operating system: {sys.platform}")
PY
  )"
fi

if [[ -z "$target_triple" ]]; then
  echo "ERROR: Could not determine the host target triple." >&2
  exit 1
fi

dist_dir="${TRANSCRIBER_DIST_DIR:-$root/dist}"
work_dir="${TRANSCRIBER_PYINSTALLER_WORKDIR:-$root/.build/pyinstaller/$target_triple}"
mkdir -p "$dist_dir" "$work_dir"
export TRANSCRIBER_TARGET_TRIPLE="$target_triple"

"$python_cmd" -m PyInstaller \
  --clean \
  --noconfirm \
  --distpath "$dist_dir" \
  --workpath "$work_dir" \
  "$root/transcriber-engine.spec"

artifact="$dist_dir/transcriber-engine-$target_triple"
if [[ "$target_triple" == *windows* ]]; then
  artifact="$artifact.exe"
fi
if [[ ! -f "$artifact" ]]; then
  echo "ERROR: PyInstaller did not produce $artifact" >&2
  exit 1
fi
"$artifact" --help >/dev/null
smoke_output="$work_dir/smoke.ndjson"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"drafting_reference","arguments":{}}}' \
  | "$artifact" mcp-server --workspace "$root" >"$smoke_output"
"$python_cmd" - "$smoke_output" "$root/../package.json" <<'PYCODE'
import json
import sys
from pathlib import Path

responses = {item["id"]: item for item in map(json.loads, Path(sys.argv[1]).read_text(encoding="utf-8").splitlines())}
app_version = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["version"]
assert responses[1]["result"]["serverInfo"]["version"] == app_version
reference = responses[2]["result"]
assert not reference["isError"], reference
assert reference["content"][0]["text"].strip(), reference
print("Frozen engine initialization and editorial reference: passed")
PYCODE
echo "Built $artifact"
