#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: bash $0 HERMES_INCLUDE FRAMEWORK_DIRECTORY HERMESC reflection|internal-test-methods [SIMULATOR_UDID]" >&2
  exit 2
fi

include_dir="$1"
framework_dir="$(cd "$2" && pwd)"
compiler="$3"
mode="$4"
simulator="${5:-}"
if [[ ! -f "$include_dir/hermes/hermes.h" || ! -f "$include_dir/jsi/jsi.h" || ! -f "$framework_dir/hermesvm.framework/hermesvm" || ! -x "$compiler" ]]; then
  echo "Provide matching Hermes/JSI headers, a hermesvm.framework directory and a hermesc executable." >&2
  exit 2
fi
if [[ "$mode" != reflection && "$mode" != internal-test-methods ]]; then
  echo "Choose reflection or internal-test-methods." >&2
  exit 2
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/capix-hermes-inspection.XXXXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

sdk=macosx
flags=(-std=c++20)
if [[ -n "$simulator" ]]; then
  sdk=iphonesimulator
  flags+=(-target "$(uname -m)-apple-ios17.0-simulator")
fi

"$compiler" -emit-binary -out "$build_dir/strict-inspection.hbc" "$source_dir/strict-inspection.js"
xcrun --sdk "$sdk" clang++ "${flags[@]}" \
  -isystem "$include_dir" -F"$framework_dir" -Wl,-rpath,"$framework_dir" -framework hermesvm \
  "$source_dir/hermes-inspection.cpp" -o "$build_dir/hermes-inspection"

if [[ -n "$simulator" ]]; then
  xcrun simctl spawn "$simulator" "$build_dir/hermes-inspection" "$build_dir/strict-inspection.hbc" "$mode"
else
  "$build_dir/hermes-inspection" "$build_dir/strict-inspection.hbc" "$mode"
fi
