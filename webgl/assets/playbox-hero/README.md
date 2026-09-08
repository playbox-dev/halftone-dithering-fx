# playbox homepage hero assets

Derived from the public media already used by the playbox homepage on 2026-09-08:

https://kscnqkuxhelifwdwsvmp.supabase.co/storage/v1/object/public/halftone-media/u/2026-08/2de15cd8-2882-410e-8edd-be303c4fd6d9.mp4

- Original: 19,031,561 bytes; H.264, 1280 × 720, 30 fps, about 10.03 seconds, with an AAC audio track.
- `hero-960.mp4`: 877,691 bytes; H.264, 960 × 540, 24 fps, about 10.04 seconds, no audio. Same footage and duration; CRF 29, slow preset, yuv420p, faststart. Video bytes reduced by 95.39%.
- `poster.webp`: 7,682 bytes; 1440 × 810 lossless WebP. Static frame from 0.4 seconds, rendered with the hero's red square marks and Bayer4 treatment (grid 3; mark-size 42; brightness 100; contrast 45; gamma 3). This is a generated static approximation of the WebGL treatment, independent of WebGL or JavaScript availability.

The optimized entry point is `webgl/playbox-hero.html`. It fetches the video only after the poster paints, the frame intersects the viewport, and playback is wanted. Reduced-motion and Save-Data start with the static poster and allow intentional playback from the visible button. Pausing, scrolling offscreen, or hiding the tab pauses the actual video as well as the effect.

The generic `embed.html`, custom element, editor and exporter are unchanged.
