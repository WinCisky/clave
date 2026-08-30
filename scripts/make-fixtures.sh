#!/usr/bin/env bash
#
# Build the test media the player's self-test runs against.
#
# One file per playback route, so a failure is attributable. Finding a torrent that happens to
# contain Xvid with an AC-3 track, or MP3-in-MP4, and then hoping the swarm is alive, is not a test
# — it is a coincidence you wait for. These are synthetic, deterministic and take a minute to make.
#
#   bash scripts/make-fixtures.sh
#   node scripts/devserver.mjs
#   open http://localhost:8080/selftest.html

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p fixtures/media
cd fixtures/media

short="-f lavfi -i testsrc2=size=640x360:rate=25:duration=30 -f lavfi -i sine=frequency=440:duration=30"
long="-f lavfi -i testsrc2=size=640x360:rate=25:duration=150 -f lavfi -i sine=frequency=440:duration=150"
q="-loglevel error -y"

# Route A — copy both streams.
ffmpeg $q $short -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -movflags +faststart h264-aac.mp4
# The same, with `moov` at the end: the layout that makes a torrent's tail bootstrap load-bearing.
ffmpeg $q $short -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac h264-aac-nofaststart.mp4

# Route B — audio Chrome has no decoder for.
ffmpeg $q $short -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a eac3 -ac 6 h264-eac3.mkv
ffmpeg $q $short -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a dca -strict -2 -ac 2 h264-dts.mkv

# Video no browser will decode without hardware, to check the refusal is legible.
ffmpeg $q $short -c:v libx265 -preset veryfast -pix_fmt yuv420p -tag:v hvc1 -c:a aac hevc-aac.mp4

# Route C — containers and codecs mediabunny cannot parse at all.
ffmpeg $q $short -c:v mpeg4 -vtag XVID -qscale:v 5 -c:a ac3 -ac 6 xvid-ac3.avi
ffmpeg $q $short -c:v libtheora -qscale:v 6 -c:a libvorbis theora-vorbis.ogv
ffmpeg $q $short -c:v mpeg2video -qscale:v 5 -c:a mp2 mpeg2-mp2.mpg

# A static picture, so libtheora encodes most frames as zero-length "same as the last one" packets.
# Those are what `avcodec_send_packet` reads as a drain signal, and this file is the regression case:
# without the empty-packet filter its video track decodes exactly one frame.
ffmpeg $q -f lavfi -i "color=c=blue:size=320x180:rate=25:duration=20" \
  -f lavfi -i "sine=frequency=440:duration=20" \
  -c:v libtheora -qscale:v 7 -c:a libvorbis theora-dupframes.ogv
ffmpeg $q $short -c:v wmv2 -qscale:v 5 -c:a wmav2 wmv2-wmav2.wmv

# Embedded text subtitles.
cat > subs.srt <<'SRT'
1
00:00:01,000 --> 00:00:04,000
First line <i>italic</i>

2
00:00:05,500 --> 00:00:08,250
Second line & an ampersand

3
00:00:10,000 --> 00:00:12,000
Third line
SRT
ffmpeg $q -i h264-eac3.mkv -i subs.srt -map 0 -map 1 -c copy -c:s srt \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title=English h264-eac3-subs.mkv
rm -f subs.srt

# The Matroska language trap, and the files that pin it.
#
# mkvmerge has written a `LanguageIETF` element on every track it muxes since 2020, and mediabunny
# hands that element's primary subtag back unvalidated — so a track tagged `en-US` arrives as `"en"`,
# and the MP4 muxer rejects it before a single fragment is written. ffmpeg will not emit that element
# (it refuses `en` and writes `und`), so it is patched in afterwards. The patch is a rename plus a
# same-length value, which is why it needs no EBML rewriting: `22 B5 9C` is `Language` and
# `22 B5 9D` is `LanguageBCP47`, and `eng` becomes `en-`, whose primary subtag is the invalid `en`.
patch_language() {
  node -e '
    const fs = require("fs");
    const bytes = fs.readFileSync(process.argv[1]);
    const language = Buffer.from([0x22, 0xB5, 0x9C, 0x83, 0x65, 0x6E, 0x67]);  // Language = "eng"
    let at = 0, patched = 0;
    while ((at = bytes.indexOf(language, at)) !== -1) {
      bytes[at + 2] = 0x9D;                       // -> LanguageBCP47
      bytes[at + 6] = process.argv[3].charCodeAt(2);
      patched++;
      at += language.length;
    }
    if (patched === 0) throw new Error("no Language element found in " + process.argv[1]);
    fs.writeFileSync(process.argv[2], bytes);
  ' "$1" "$2" "$3"
}

# An ordinary H.264 file that would not play at all: nothing wrong with it but the language string.
ffmpeg $q $short -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
  -metadata:s:v:0 language=eng -metadata:s:a:0 language=eng h264-lang.mkv
patch_language h264-lang.mkv h264-langietf.mkv "en-"

# 10-bit HEVC with a 5.1 E-AC-3 track — the shape of the x265 releases that failed. Made twice from
# the same bytes, differing only in the language string, so a failure can be attributed to that and
# nothing else.
ffmpeg $q $short -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -x265-params log-level=none \
  -c:a eac3 -ac 6 -b:a 384k -metadata:s:v:0 language=eng -metadata:s:a:0 language=eng \
  hevc10-eac3.mkv
patch_language hevc10-eac3.mkv hevc10-eac3-ietf.mkv "en-"
patch_language hevc10-eac3.mkv hevc10-eac3-eng.mkv "eng"
rm -f hevc10-eac3.mkv h264-lang.mkv

# HEVC with a soundtrack nothing here can decode — mediabunny does not even recognise `A_TRUEHD`.
# This is the file that used to be refused as "unplayable HEVC" when the video was never the problem;
# it must now play, silently, and say so.
ffmpeg $q $short -strict -2 -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le \
  -x265-params log-level=none -c:a truehd -ac 6 -strict -2 \
  -metadata:s:v:0 language=eng -metadata:s:a:0 language=eng hevc10-truehd.mkv

# Long enough that the relay's head and tail bootstrap windows cover only a fraction of it, which is
# what makes the self-test's trickle mode actually block a read and then resume.
ffmpeg $q $long -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -c:a aac -movflags +faststart long-h264-aac.mp4
ffmpeg $q $long -c:v mpeg4 -vtag XVID -qscale:v 6 -c:a ac3 -ac 2 long-xvid-ac3.avi

ls -la
