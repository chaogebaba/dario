#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
#
# dario sits between untrusted parties on both sides of the wire: clients hand
# it arbitrary /v1/messages and /v1/chat/completions bodies, and the upstream
# hands back SSE streams and rejection bodies that dario parses, translates,
# and rewrites. Each target feeds hostile bytes into one of those parsers and
# asserts its fail-safe contract — see the header of each fuzz/*.fuzz.js.

cd "$SRC/dario"

# --frozen-lockfile verifies the install matches the committed lockfile
# (Scorecard Pinned-Dependencies).
bun install --frozen-lockfile

# Jazzer.js is installed build-side rather than as a devDependency so the
# published package's dependency tree stays exactly as committed. It comes
# from its own lockfile (.clusterfuzzlite/bun.lock) so every byte is
# integrity-checked, then gets merged into the project node_modules where
# compile_javascript_fuzzer expects to resolve it.
#
# --cwd, not --prefix: bun has no --prefix, and rather than erroring it
# reinterprets the whole command as `bun add .clusterfuzzlite`, which
# mutates the root package.json and installs nothing here.
bun install --frozen-lockfile --cwd .clusterfuzzlite
cp -r .clusterfuzzlite/node_modules/. node_modules/

# The fuzz targets exercise the compiled output (dist/), same as the test
# suite — build it first.
bun run build

for target in sse_translate reject_parsers cch_stamp; do
  compile_javascript_fuzzer dario "fuzz/${target}.fuzz.js" --sync
done
