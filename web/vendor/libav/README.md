# libav.js — `clave-legacy` variant

Built from [Yahweasel/libav.js](https://github.com/Yahweasel/libav.js) at tag `v6.10.9.0`
(FFmpeg 9.0), with `scripts/build-libav.sh` in this repository.

FFmpeg is licensed under the LGPL. The built libraries carry their own license headers, and the
corresponding sources are the upstream tag above configured with exactly these fragments:

```json
[
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
]
```

Nothing here is modified; it is an unpatched upstream build with a narrower feature set. It contains
demuxers and decoders only — no muxers, no encoders, no CLI — because mediabunny muxes and WebCodecs
encodes.
