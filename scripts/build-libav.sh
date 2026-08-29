#!/usr/bin/env bash
#
# Build the `clave-legacy` libav.js variant and drop it into web/vendor/libav/.
#
# Run once; the artefacts are committed so nobody else needs emscripten. Upstream deliberately
# ships no prebuilt variant containing the MPEG decoders, which is why this exists at all: the
# largest published variant is 6.2 MB of AV1 and Opus and has no AVI demuxer in it.
#
# The variant carries only what Chrome genuinely cannot do. No muxers, no encoders, no CLI —
# mediabunny does the muxing and WebCodecs does the encoding, so this is a demuxer and a pile of
# legacy decoders and nothing else.
#
# FFmpeg is LGPL. See web/vendor/libav/README.md for the pinned tag and exact configuration, which
# is what makes the corresponding sources obtainable.

set -euo pipefail

TAG=v6.10.9.0
VERSION=6.10.9.0
VARIANT=clave-legacy
EMSDK_IMAGE=emscripten/emsdk:4.0.6
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${LIBAVJS_WORK:-${TMPDIR:-/tmp}/clave-libavjs}"
OUT="$ROOT/web/vendor/libav"

# Containers mediabunny cannot parse at all, plus the two it can, so that a file it chokes on still
# has a second opinion from the demuxer everything else in the world uses.
#
# The names below are FFmpeg's *configure* names, which are not always the names
# `avcodec_find_decoder_by_name` answers to: `decoder-msmpeg4v3` (DivX 3) is found at runtime as
# `msmpeg4`, and `decoder-flv` is the codec FFmpeg calls `flv1`. Configure accepts an unknown
# --enable-decoder without complaining, so a wrong name here costs a codec silently — the MPEG
# program stream demuxer is `mpegps`, and asking for `mpeg` silently produced a build that could not
# open a .mpg at all. Every entry was checked against the built artefact.
FRAGMENTS='[
  "avformat", "avcodec", "swscale", "swresample", "zlib",

  "demuxer-avi", "demuxer-asf", "demuxer-flv", "demuxer-mpegps", "demuxer-mpegts",
  "demuxer-mpegvideo",
  "demuxer-matroska", "demuxer-mp4", "demuxer-ogg",

  "parser-mpeg4video", "parser-mpegvideo", "parser-h263", "parser-vc1", "parser-mjpeg",
  "parser-ac3", "parser-mpegaudio", "parser-vorbis",

  "decoder-mpeg4", "decoder-msmpeg4v1", "decoder-msmpeg4v2", "decoder-msmpeg4v3",
  "decoder-mpeg1video", "decoder-mpeg2video", "decoder-h263", "decoder-h263p", "decoder-h263i",
  "decoder-wmv1", "decoder-wmv2", "decoder-wmv3", "decoder-vc1",
  "decoder-theora", "decoder-cinepak", "decoder-msvideo1", "decoder-flv",
  "decoder-svq1", "decoder-svq3", "decoder-dvvideo", "decoder-mjpeg", "decoder-qtrle",
  "decoder-rawvideo",

  "decoder-aac", "decoder-ac3", "decoder-eac3", "decoder-dca", "decoder-truehd", "decoder-mp1", "decoder-mp2",
  "decoder-mp3", "decoder-vorbis", "decoder-opus", "decoder-flac", "decoder-alac",
  "decoder-wmav1", "decoder-wmav2", "decoder-wmapro",
  "decoder-adpcm_ms", "decoder-adpcm_ima_wav",
  "decoder-pcm_s16le", "decoder-pcm_s16be", "decoder-pcm_s24le", "decoder-pcm_s32le",
  "decoder-pcm_u8", "decoder-pcm_f32le", "decoder-pcm_alaw", "decoder-pcm_mulaw"
]'

echo "==> work tree: $WORK"
if [ ! -d "$WORK/.git" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/Yahweasel/libav.js.git "$WORK"
fi

echo "==> generating the $VARIANT configuration"
( cd "$WORK/configs" && node ./mkconfig.js "$VARIANT" "$(echo "$FRAGMENTS" | tr -d '\n')" )

echo "==> building in $EMSDK_IMAGE (this takes a while — ffmpeg is compiled from source)"
docker run --rm \
  -v "$WORK":/src -w /src \
  --user "$(id -u):$(id -g)" \
  -e HOME=/src/.home -e EM_CACHE=/src/.emcache -e npm_config_cache=/src/.npm \
  "$EMSDK_IMAGE" \
  bash -lc "
    set -e
    mkdir -p /src/.home /src/.emcache /src/.npm
    npm install --no-audit --no-fund
    make -j\$(nproc) \
      dist/libav-$VERSION-$VARIANT.mjs \
      dist/libav-$VERSION-$VARIANT.wasm.mjs \
      dist/libav.types.d.ts
  "

echo "==> installing into $OUT"
mkdir -p "$OUT"
cp "$WORK/dist/libav-$VERSION-$VARIANT.mjs" \
   "$WORK/dist/libav-$VERSION-$VARIANT.wasm.mjs" \
   "$WORK/dist/libav-$VERSION-$VARIANT.wasm.wasm" \
   "$OUT/"

cat > "$OUT/README.md" <<EOF
# libav.js — \`$VARIANT\` variant

Built from [Yahweasel/libav.js]($(echo https://github.com/Yahweasel/libav.js)) at tag \`$TAG\`
(FFmpeg 9.0), with \`scripts/build-libav.sh\` in this repository.

FFmpeg is licensed under the LGPL. The built libraries carry their own license headers, and the
corresponding sources are the upstream tag above configured with exactly these fragments:

\`\`\`json
$(echo "$FRAGMENTS")
\`\`\`

Nothing here is modified; it is an unpatched upstream build with a narrower feature set. It contains
demuxers and decoders only — no muxers, no encoders, no CLI — because mediabunny muxes and WebCodecs
encodes.
EOF

ls -la "$OUT"
echo "==> done"
