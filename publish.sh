#!/bin/bash
# Build, check and publish windscout to npm. Bump "version" in package.json first.
# Arguments go to npm publish, e.g. ./publish.sh --dry-run or ./publish.sh --otp 123456
set -euo pipefail
cd "$(dirname "$0")"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

npm ci --no-audit --no-fund                # the locked TypeScript toolchain
npm pack --pack-destination "$T"           # runs prepack: clean dist/, compile src/, chmod +x dist/cli.js
TGZ=$(echo "$T"/windscout-*.tgz)
# install the tarball the way users get it and run the command: proves the files list, bin link, shebang and exec bit
npm install --global --prefix "$T/global" --no-audit --no-fund "$TGZ" >/dev/null
"$T/global/bin/windscout" --version
npm publish "$TGZ" "$@"                    # the exact tarball tested above (publishing a tarball doesn't rebuild)
