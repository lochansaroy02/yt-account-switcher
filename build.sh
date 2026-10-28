#!/bin/sh
# Builds dist/hover-switcher-<version>.zip for AMO / Chrome Web Store upload.
set -eu
cd "$(dirname "$0")"

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="dist/hover-switcher-$version.zip"

if grep -q '^ *const DEBUG = true;' content.js; then
  echo "build.sh: DEBUG is true in content.js; set it to false first." >&2
  exit 1
fi

mkdir -p dist
rm -f "$out"
zip -qrX "$out" manifest.json content.js styles.css icons -x '*.DS_Store'
echo "$out"
unzip -l "$out"
