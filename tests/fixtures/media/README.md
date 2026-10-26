# Media reader fixtures

Generated inside the Kosmozoo project VM with:

```sh
python tests/make-media-fixtures.py
```

Requires ffmpeg (H.264/libx264 and VP9/libvpx-vp9) and Pillow. Neither is a
runtime dependency. Each fixture is below 100 KB; videos are three-second
160×96 test patterns. All carry the same executed prompt (seed42, SaveVideo
node92), editor workflow and `kz` lineage.

| File | Container metadata |
|---|---|
| workflow.png | PNG tEXt prompt/workflow/kz |
| animated.png | APNG with ComfyUI private comf keyword-NUL-JSON chunks after IDAT |
| workflow.webp | Animated WebP; EXIF IFD0 Model0x0110 `prompt:…`, Make0x010f `workflow:…`, ImageDescription0x010e `kz:…` |
| workflow.mp4 | H.264; trailing moov/udta/meta, mdta keys + indexed ilst/data |
| workflow.mov | H.264; qt brand, faststart moov/udta/meta, same mdta layout |
| workflow.webm | VP9; Tags/Tag/SimpleTag PROMPT/WORKFLOW/KZ |
| comment.mp4 | H.264; moov/udta/meta/ilst/©cmt/data JSON envelope |
| comment.webm | VP9; SimpleTag COMMENT JSON envelope |

The real user-provided MiniMax video is external evidence and is never part
of the fixtures or repository.

Audio fixtures are generated separately inside the VM with
`python tests/make-audio-fixtures.py` (ffmpeg/ffprobe only). They are three-second
440 Hz mono tones, each below 100 KB, carrying a ComfyUI-shaped SaveAudio prompt
(seed42, text “A singing cosmic zoo”), editor workflow and the same `kz` lineage.

| File | Container metadata |
|---|---|
| workflow.flac | Native FLAC block4 Vorbis comments: prompt/workflow/kz |
| workflow.mp3 | ID3v2.4 TXXX, encoding3 (UTF8), description=prompt/workflow/kz |
| workflow.opus | Ogg OpusTags vendor/count/length-prefixed comments: prompt/workflow/kz |
| workflow.wav | RIFF LIST/INFO/ICMT NUL-terminated UTF8 JSON envelope with prompt/workflow/kz |

The generator supplies `-metadata prompt=… -metadata workflow=… -metadata kz=…`.
For WAV it also supplies `-metadata comment=<envelope>` because ffmpeg's fixed
RIFF INFO vocabulary drops arbitrary keys. ffprobe read-back confirms the three
named tags in FLAC/MP3, stream tags in Opus, and the `comment` envelope in WAV.
Stock ComfyUI AudioSaveHelper sets the same named PyAV container metadata for
FLAC/MP3/Opus; it currently does not offer WAV.
