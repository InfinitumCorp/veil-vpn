#!/bin/bash
# Build the MIT wireguard-go bridge that WireGuardKit links as libwg-go.a.
# The sources are fetched at a pinned commit and are not committed here.
# Go's 2023 runtime patch is applied when it still matches; otherwise the
# bridge is built without it (handshake timing across sleep is less precise).
set -euo pipefail

PIN="2fec12a6e1f6e3460b6ee483aa00ad29cddadab1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${ROOT}/.build/wireguard-apple"
LOCK="${ROOT}/.build/wireguard-apple.lockdir"

if ! command -v go >/dev/null 2>&1; then
  echo "error: Go is required to build the WireGuard tunnel (install Go 1.22)" >&2
  exit 1
fi
if [[ -z "${CONFIGURATION_BUILD_DIR:-}" || -z "${PLATFORM_NAME:-}" || -z "${SDKROOT:-}" ]]; then
  echo "error: run from Xcode, or set PLATFORM_NAME, SDKROOT, ARCHS and CONFIGURATION_BUILD_DIR" >&2
  exit 1
fi

mkdir -p "${ROOT}/.build"
while ! mkdir "${LOCK}" 2>/dev/null; do sleep 1; done
trap 'rmdir "${LOCK}"' EXIT

if [[ "$(git -C "${CACHE}" rev-parse HEAD 2>/dev/null || true)" != "${PIN}" ]]; then
  rm -rf "${CACHE}"
  mkdir -p "${CACHE}"
  git -C "${CACHE}" init
  git -C "${CACHE}" remote add origin https://github.com/WireGuard/wireguard-apple.git
  GIT_TERMINAL_PROMPT=0 git -C "${CACHE}" fetch --depth 1 origin "${PIN}"
  git -C "${CACHE}" checkout --detach FETCH_HEAD
fi

MAKEFILE="${CACHE}/Sources/WireGuardKitGo/Makefile"
python3 - "${MAKEFILE}" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = 'cat goruntime-*.diff | patch -p1 -f -N -r- -d "$(GOROOT)"'
extra = ' || echo "veil: Go runtime patch did not apply; continuing"'
if old in text and "veil: Go runtime patch" not in text:
    path.write_text(text.replace(old, old + extra, 1))
PY

mkdir -p "${CONFIGURATION_BUILD_DIR}"
PREBUILT="${ROOT}/.build/wg-go/${PLATFORM_NAME}/libwg-go.a"
if [[ "${VEIL_WG_REUSE:-}" == "1" && -f "${PREBUILT}" ]]; then
  # CI may point CONFIGURATION_BUILD_DIR at the cache itself; macOS cp fails on a self-copy.
  [[ "${PREBUILT}" -ef "${CONFIGURATION_BUILD_DIR}/libwg-go.a" ]] || cp "${PREBUILT}" "${CONFIGURATION_BUILD_DIR}/libwg-go.a"
  exit 0
fi

export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin"
export CC="${CC:-$(xcrun -f clang)}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-17.0}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"

FLAG_NAME=""
FLAG_ENV=""
case "${PLATFORM_NAME}" in
  iphoneos) FLAG_NAME="mios-version-min"; FLAG_ENV="IPHONEOS_DEPLOYMENT_TARGET" ;;
  iphonesimulator) FLAG_NAME="mios-simulator-version-min"; FLAG_ENV="IPHONEOS_DEPLOYMENT_TARGET" ;;
  macosx) FLAG_NAME="mmacosx-version-min"; FLAG_ENV="MACOSX_DEPLOYMENT_TARGET" ;;
esac

make -C "${CACHE}/Sources/WireGuardKitGo" \
  PLATFORM_NAME="${PLATFORM_NAME}" \
  ARCHS="${ARCHS:-arm64}" \
  SDKROOT="${SDKROOT}" \
  CONFIGURATION_BUILD_DIR="${CONFIGURATION_BUILD_DIR}" \
  CONFIGURATION_TEMP_DIR="${CONFIGURATION_TEMP_DIR:-${ROOT}/.build/wg-tmp/${PLATFORM_NAME}}" \
  DEPLOYMENT_TARGET_CLANG_FLAG_NAME="${FLAG_NAME}" \
  DEPLOYMENT_TARGET_CLANG_ENV_NAME="${FLAG_ENV}" \
  GOOS_iphonesimulator=ios

mkdir -p "$(dirname "${PREBUILT}")"
if [[ ! "${CONFIGURATION_BUILD_DIR}/libwg-go.a" -ef "${PREBUILT}" ]]; then
  cp "${CONFIGURATION_BUILD_DIR}/libwg-go.a" "${PREBUILT}"
fi
