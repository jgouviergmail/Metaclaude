#!/usr/bin/env bash
# Fetch the embedding model the runtime will load offline.
#
# The container never downloads anything (`allowRemoteModels` is false in the
# API), so the model ships in the image: the Dockerfile's `model` stage runs
# this, and a developer runs it once to measure retrieval locally
# (`scripts/eval-retrieval.mjs`). One script for both, so the two cannot ship
# different files.
#
# Files land in the layout `@huggingface/transformers` reads back:
#   <dir>/<owner>/<model>/{config.json,tokenizer.json,tokenizer_config.json}
#   <dir>/<owner>/<model>/onnx/model_quantized.onnx
#
# The revision is pinned per model. Hugging Face serves `main` mutably; an
# image built next month must load the vectors this one wrote, and the
# profile floors in `retrieval.ts` were measured against exactly this file.
#
#   deploy/fetch-embedding-model.sh Xenova/bge-m3 /opt/metaclaude/models
set -euo pipefail

MODEL="${1:-Xenova/bge-m3}"
DIR="${2:-./models}"

case "$MODEL" in
  Xenova/bge-m3) REVISION="4de13258303883538bd53b696b452bf8099f0858" ;;
  *)
    # Unpinned models are allowed for experiments, at `main`, and say so.
    REVISION="main"
    echo "warning: no pinned revision for $MODEL — fetching main, which can change under you" >&2
    ;;
esac

TARGET="$DIR/$MODEL"
mkdir -p "$TARGET/onnx"

fetch() {
  local file="$1"
  local url="https://huggingface.co/$MODEL/resolve/$REVISION/$file"
  local out="$TARGET/$file"
  if [ -s "$out" ]; then
    echo "have    $file"
    return
  fi
  echo "fetch   $file"
  # Retries cover a flaky mirror; `-f` turns an HTML error page into a failure
  # instead of a 200-byte "model" that fails to parse at boot.
  curl -fsSL --retry 5 --retry-delay 3 -o "$out.part" "$url"
  [ -s "$out.part" ] || { echo "error: $file came back empty" >&2; rm -f "$out.part"; exit 1; }
  mv "$out.part" "$out"
}

for file in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do
  fetch "$file"
done

du -sh "$TARGET" | sed 's/^/total   /'
