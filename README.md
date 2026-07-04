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

Attributes (all reactive): `src`, `grid`, `dot-color`, `background` (hex or `transparent`), `brightness`, `contrast`, `gamma`, `dither` (`none`|`bayer`|`noise`), `multicolor`, `paused`. JS API: `el.play()`, `el.pause()`, `el.source = <img|video|canvas>`.

Demo with live controls: serve the repo and open `/webgl/`.

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
