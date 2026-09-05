#!/usr/bin/env sh
# Assay CLI installer. Usage: curl -fsSL https://raw.githubusercontent.com/weironz/assay/main/cli/install.sh | sh
set -eu

REPO="weironz/assay"
API="https://api.github.com/repos/${REPO}/releases?per_page=100"
BIN_DIR="${ASSAY_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET="x86_64-unknown-linux-musl" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m). Download a release manually." >&2; exit 1 ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need curl
need awk
need sha256sum

RELEASES="$(curl -fsSL "$API")"
TAG="$(printf '%s' "$RELEASES" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"assay-cli-v[^"]*"' | head -n 1 | sed 's/.*"\(assay-cli-v[^"]*\)"/\1/')"
[ -n "$TAG" ] || { echo "No stable assay-cli release found." >&2; exit 1; }

ASSET="assay-${TARGET}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "Installing Assay CLI ${TAG#assay-cli-v} for ${TARGET}..."
curl -fsSL "$BASE/$ASSET" -o "$TMP/assay"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
(cd "$TMP" && grep "  $ASSET$" SHA256SUMS | sed "s#  $ASSET#  assay#" | sha256sum -c -)

mkdir -p "$BIN_DIR"
install -m 0755 "$TMP/assay" "$BIN_DIR/assay"
echo "Installed: $BIN_DIR/assay"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add this directory to PATH, then open a new terminal:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
