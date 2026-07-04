# Halftone Dithering FX

A browser-based halftone / dithering effect generator — the "OpenAI ad" dithering look and beyond. Drop in an image or video and it renders a live halftone-dot preview you can tune and export to PNG, SVG, or WebM video.

No build step, no dependencies — just static HTML/CSS/JS.

Two flavors:

- **`/` (root)** — the original CPU canvas tool: upload, tune, and *export* PNG / SVG / WebM.
- **`/webgl`** — `<halftone-fx>`, a GPU-accelerated custom element for using the effect **live on a website** (hero backgrounds, section art). Crisp at any DPI, ~zero CPU cost.

## `<halftone-fx>` — live effect for your site

Copy `webgl/halftone-fx.js` into your project and:

```html
<script src="halftone-fx.js"></script>

<halftone-fx src="clip.mp4" grid="14" dot-color="#000" background="#fff"
             style="width:100%;height:60vh"></halftone-fx>
```

Why it's cheap: instead of reading pixels back to JS every frame, it runs two GPU passes — (1) the source is downsampled to one texel per halftone cell (mipmap filtering computes the cell averages in hardware), (2) a fullscreen shader draws one anti-aliased dot per cell. No `getImageData`, no per-pixel JS loops, renders at `devicePixelRatio` so it stays sharp on retina/4K, and it auto-pauses when scrolled offscreen.

Attributes (all reactive): `src`, `grid`, `dot-color`, `background` (hex or `transparent`), `brightness`, `contrast`, `gamma`, `dither`, `multicolor`, `paused`. JS API: `el.play()`, `el.pause()`, `el.source = <img|video|canvas>`.

**Live demo:** <https://playbox-dev.github.io/halftone-dithering-fx/webgl/>

### Picking a dither mode for animation

For moving sources, temporal stability is the whole game — a dither pattern that changes per frame reads as shimmer. All modes here are stable except `noise`, which flickers on purpose:

| `dither` | Look | Notes |
|---|---|---|
| `none` | Smooth tonal halftone | Dot *size* carries the tone (classic "OpenAI ad" look). Best default. |
| `bayer4` | Coarse retro print / CRT | 4×4 ordered matrix, chunky crosshatch |
| `bayer8` | Finer retro, more tonal steps | 8×8 ordered matrix |
| `grain` | Organic, editorial | Interleaved gradient noise (blue-noise-like), no crosshatch pattern |
| `noise` | Animated film grain | Re-seeded ~30fps; deliberate flicker |

Error-diffusion algorithms (Floyd–Steinberg, JJN, Stucki, Burkes) are deliberately **not** in the live component: they're inherently sequential (each cell's error feeds the next, so they can't parallelize to a shader) and they're temporally unstable — a few changed pixels re-route error across the whole frame, which reads as crawling/shimmering on video. They live in the root export tool for stills.

### Embedding in site builders (STUDIO, Wix, etc.)

`webgl/embed.html` is a full-viewport page configured entirely by URL params — no code editing needed:

```
https://playbox-dev.github.io/halftone-dithering-fx/webgl/embed.html?grid=12&dither=grain&dot=ffffff&bg=0a0a0f
```

Params: `src` (media URL; add `type=video` for extension-less video URLs), `grid`, `dot` / `bg` (hex, `#` optional), `brightness`, `contrast`, `gamma`, `dither`, `multicolor`. Point `src` at any CORS-accessible clip, or commit your clip under `webgl/assets/` in this repo — GitHub Pages serves it with the right headers.

**STUDIO (studio.design):** add an 埋め込みボックス (Embed box) and paste a standalone iframe — a lone `<iframe>` tag gets STUDIO's clean "iframe type" embed rather than the restricted sandbox:

```html
<iframe src="https://playbox-dev.github.io/halftone-dithering-fx/webgl/embed.html?grid=12"
        style="width:100%;height:100%;border:0;pointer-events:none"
        allow="autoplay" loading="lazy" title="halftone background"></iframe>
```

`pointer-events:none` lets clicks/scroll pass through when it's used as a background layer; drop it if the embed should be interactive.

> Tip for websites: since the halftone destroys fine detail anyway, a small source video (e.g. 480p, heavily compressed) looks identical to a 1080p one — the dots stay razor sharp because they're drawn by the shader, not the video.

## Features

- Live preview for images **and** video (frame-by-frame)
- Adjustable grid size, brightness, contrast, gamma, and smoothing
- Multiple dithering algorithms: Floyd–Steinberg, Jarvis-Judice-Ninke, Stucki, Burkes, Ordered (Bayer), Noise, or none
- Custom dot color, background color, or rainbow multicolor dots
- Export as **PNG**, **SVG**, or **WebM video** (records the live canvas)
- Light / dark mode

## Run it

Because the app reads pixel data from `<canvas>` (which browsers block over `file://` for cross-origin reasons), serve it over a local HTTP server rather than opening the file directly.

Any of these work — pick one:

```bash
# Python 3 (built in on macOS)
python3 -m http.server 8000

# Node
npx serve

# PHP
php -S localhost:8000
```

Then open <http://localhost:8000> in your browser.

## Credits

Original code idea by [Mike Bespalov](https://codepen.io/Mikhail-Bespalov/pen/dPyyZed). Updates and additions by [Bogdan Rosu](https://bogdanrosu.com).
