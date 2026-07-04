# Halftone Dithering FX

A browser-based halftone / dithering effect generator — the "OpenAI ad" dithering look and beyond. Drop in an image or video and it renders a live halftone-dot preview you can tune and export to PNG, SVG, or WebM video.

No build step, no dependencies — just static HTML/CSS/JS.

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
