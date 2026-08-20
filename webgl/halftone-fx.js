/*
 * <halftone-fx> — crisp, GPU-accelerated square halftone as a drop-in custom element.
 *
 * Usage:
 *   <script src="halftone-fx.js"></script>
 *   <halftone-fx src="clip.mp4" grid="80" shape="square" threshold="50"
 *                mark-size="42" brightness="12"
 *                dot-color="#ff3110" background="transparent"
 *                style="width:100%;height:60vh"></halftone-fx>
 *
 * Attributes (all live-reactive):
 *   src          — image or video URL (video detected by extension, or force with type="video")
 *   grid         — cell size in CSS px (default 80)
 *   shape        — square | circle (default square)
 *   threshold    — hide marks smaller than this percentage, 0..100 (default 50)
 *   mark-size    — scale every visible mark, 0..100 (default 42)
 *   dot-color    — hex color of marks (default #ff3110)
 *   background   — hex color, or "transparent" (default transparent)
 *   brightness   — -100..100 (default 12)
 *   contrast     — -100..100 (default 0)
 *   gamma        — 0.1..3 (default 1)
 *   dither       — none | bayer4 | bayer8 | grain | noise (default none; noise animates)
 *                  bayer4/bayer8: ordered, temporally stable, retro-print look
 *                  grain: interleaved gradient noise — blue-noise-like, stable, organic
 *                  noise: white noise re-seeded ~30fps — deliberate film-grain flicker
 *   multicolor   — present = rainbow marks by brightness
 *   paused       — present = freeze rendering
 *
 * JS API: el.play(), el.pause(), el.snapshot(), el.source = <img|video|canvas element>
 *
 * How it works (2 GPU passes, no CPU pixel work):
 *   1. Downsample: source → tiny texture with one texel per halftone cell;
 *      mipmap filtering computes each cell's average brightness in hardware.
 *   2. Marks: fullscreen shader — each pixel texelFetches its cell value and
 *      draws an anti-aliased square (or legacy circle). Renders at
 *      devicePixelRatio for crispness.
 */
(() => {
  'use strict';

  const VS = `#version 300 es
  out vec2 vUv;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  // Pass 1: grayscale + brightness/contrast/gamma, auto-averaged per cell via mip LOD.
  const FS_DOWN = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform float uBrightness, uContrast, uGamma;
  uniform float uSrcAspect, uDstAspect;
  in vec2 vUv;
  out vec4 o;
  void main() {
    // Cover-crop the source into the output so square canvases never stretch it.
    vec2 uv = vUv;
    if (uSrcAspect > uDstAspect) {
      uv.x = (uv.x - 0.5) * (uDstAspect / uSrcAspect) + 0.5;
    } else {
      uv.y = (uv.y - 0.5) * (uSrcAspect / uDstAspect) + 0.5;
    }
    vec3 c = texture(uSrc, uv).rgb;
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    g = uContrast * (g - 0.5) + 0.5 + uBrightness;
    g = clamp(g, 0.0, 1.0);
    g = pow(g, 1.0 / uGamma);
    o = vec4(g, g, g, 1.0);
  }`;

  // Pass 2: one anti-aliased mark per cell.
  const FS_MAIN = `#version 300 es
  precision highp float;
  uniform sampler2D uCells;
  uniform vec2 uCellSize;     // fitted device px per cell; tiles the canvas exactly
  uniform ivec2 uCellDims;
  uniform vec3 uDotColor;
  uniform vec4 uBg;
  uniform int uMulticolor;    // 0/1
  uniform int uDither;        // 0 none, 1 bayer4, 2 bayer8, 3 grain, 4 noise
  uniform int uShape;         // 0 square, 1 circle
  uniform float uThreshold;   // minimum normalized mark size
  uniform float uMarkScale;   // spacing: maximum fraction of each cell occupied
  uniform float uTime;
  out vec4 o;

  float bayer4(ivec2 p) {
    int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    return (float(m[(p.y & 3) * 4 + (p.x & 3)]) + 0.5) / 16.0;
  }
  float bayer8(ivec2 p) {
    int m[64] = int[64](
       0, 32,  8, 40,  2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44,  4, 36, 14, 46,  6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
       3, 35, 11, 43,  1, 33,  9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47,  7, 39, 13, 45,  5, 37,
      63, 31, 55, 23, 61, 29, 53, 21);
    return (float(m[(p.y & 7) * 8 + (p.x & 7)]) + 0.5) / 64.0;
  }
  // Interleaved gradient noise (Jimenez) — blue-noise-like, temporally stable.
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  vec3 hue2rgb(float h) {
    h = fract(h);
    return clamp(vec3(abs(h * 6.0 - 3.0) - 1.0,
                      2.0 - abs(h * 6.0 - 2.0),
                      2.0 - abs(h * 6.0 - 4.0)), 0.0, 1.0);
  }

  void main() {
    vec2 fc = gl_FragCoord.xy;
    ivec2 cell = clamp(ivec2(floor(fc / uCellSize)), ivec2(0), uCellDims - 1);
    float v = texelFetch(uCells, cell, 0).r;

    if (uDither == 1) {
      v = v < bayer4(cell) ? 0.0 : 1.0;
    } else if (uDither == 2) {
      v = v < bayer8(cell) ? 0.0 : 1.0;
    } else if (uDither == 3) {
      v = v < ign(vec2(cell)) ? 0.0 : 1.0;
    } else if (uDither == 4) {
      // Animated grain, stepped at ~30fps like film.
      float n = hash(vec2(cell) + floor(uTime * 30.0) * vec2(13.7, 7.3)) - 0.5;
      v = (v + n * 0.4) < 0.5 ? 0.0 : 1.0;
    }

    float markSize = 1.0 - v;
    float halfSize = min(uCellSize.x, uCellSize.y) * 0.5 * markSize * uMarkScale;
    vec2 center = (vec2(cell) + 0.5) * uCellSize;
    vec2 delta = abs(fc - center);
    float d = uShape == 1 ? length(delta) : max(delta.x, delta.y);
    float m;
    if (markSize < uThreshold || v >= 0.999) {
      m = 0.0; // Pure white must not leave a sub-pixel speck.
    } else if (uShape == 0 && v <= 0.001 && uMarkScale >= 0.999) {
      m = 1.0; // Full black squares tile cleanly without grid seams.
    } else {
      m = 1.0 - smoothstep(halfSize - 0.75, halfSize + 0.75, d);
    }

    vec3 dotc = uMulticolor == 1 ? hue2rgb(v) : uDotColor;
    // Premultiplied output (correct for opaque and transparent backgrounds).
    o = vec4(mix(uBg.rgb * uBg.a, dotc, m), mix(uBg.a, 1.0, m));
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('halftone-fx shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('halftone-fx link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function hexToRgba(str, fallback) {
    if (!str) return fallback;
    if (str.trim().toLowerCase() === 'transparent') return [0, 0, 0, 0];
    const m = str.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return fallback;
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, c => c + c);
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }

  const VIDEO_RE = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i;

  class HalftoneFX extends HTMLElement {
    static get observedAttributes() {
      return ['src', 'type', 'grid', 'shape', 'threshold', 'mark-size', 'dot-color', 'background', 'brightness',
              'contrast', 'gamma', 'dither', 'multicolor', 'paused'];
    }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        :host { display: block; overflow: hidden; aspect-ratio: 1; }
        canvas { display: block; width: 100%; height: 100%; }
      </style><canvas></canvas>`;
      this._canvas = root.querySelector('canvas');
      this._media = null;          // HTMLImageElement | HTMLVideoElement | canvas
      this._isVideo = false;
      this._raf = 0;
      this._visible = true;
      this._cellW = 0;
      this._cellH = 0;
      this._srcDirty = true;       // media needs (re)upload
    }

    connectedCallback() {
      const gl = this._canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false,
      });
      if (!gl) {
        this.shadowRoot.innerHTML = '<p style="color:#888;font:13px sans-serif">WebGL2 not available</p>';
        return;
      }
      this._gl = gl;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      this._progDown = program(gl, FS_DOWN);
      this._progMain = program(gl, FS_MAIN);
      this._u = {
        down: {
          src: gl.getUniformLocation(this._progDown, 'uSrc'),
          brightness: gl.getUniformLocation(this._progDown, 'uBrightness'),
          contrast: gl.getUniformLocation(this._progDown, 'uContrast'),
          gamma: gl.getUniformLocation(this._progDown, 'uGamma'),
          srcAspect: gl.getUniformLocation(this._progDown, 'uSrcAspect'),
          dstAspect: gl.getUniformLocation(this._progDown, 'uDstAspect'),
        },
        main: {
          cells: gl.getUniformLocation(this._progMain, 'uCells'),
          cellSize: gl.getUniformLocation(this._progMain, 'uCellSize'),
          cellDims: gl.getUniformLocation(this._progMain, 'uCellDims'),
          dotColor: gl.getUniformLocation(this._progMain, 'uDotColor'),
          bg: gl.getUniformLocation(this._progMain, 'uBg'),
          multicolor: gl.getUniformLocation(this._progMain, 'uMulticolor'),
          dither: gl.getUniformLocation(this._progMain, 'uDither'),
          shape: gl.getUniformLocation(this._progMain, 'uShape'),
          threshold: gl.getUniformLocation(this._progMain, 'uThreshold'),
          markScale: gl.getUniformLocation(this._progMain, 'uMarkScale'),
          time: gl.getUniformLocation(this._progMain, 'uTime'),
        },
      };

      this._srcTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this._cellTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._cellTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this._fbo = gl.createFramebuffer();

      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this);
      this._io = new IntersectionObserver(entries => {
        this._visible = entries[0].isIntersecting;
        this._syncLoop();
      });
      this._io.observe(this);

      this._resize();
      if (this.hasAttribute('src')) this._loadSrc(this.getAttribute('src'));
    }

    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this._isVideo && this._media) this._media.pause();
    }

    attributeChangedCallback(name, _old, value) {
      if (!this._gl) return; // connectedCallback handles initial state
      if (name === 'src') this._loadSrc(value);
      else if (name === 'grid') this._resize();
      else this._requestRender();
      this._syncLoop();
    }

    /** Assign an existing <img>, <video>, or <canvas> as the source. */
    set source(el) {
      this._media = el;
      this._isVideo = el instanceof HTMLVideoElement;
      this._srcDirty = true;
      this._requestRender();
      this._syncLoop();
    }
    get source() { return this._media; }

    play() { this.removeAttribute('paused'); }
    pause() { this.setAttribute('paused', ''); }

    /** Capture the current full-resolution WebGL frame as an image Blob. */
    snapshot(type = 'image/png', quality) {
      return new Promise((resolve, reject) => {
        if (!this._gl || !this._media) {
          reject(new Error('halftone-fx: no source is ready to capture'));
          return;
        }
        this._render(performance.now() / 1000);
        this._gl.finish();
        this._canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('halftone-fx: snapshot failed'));
        }, type, quality);
      });
    }

    // --- internals -----------------------------------------------------

    _loadSrc(url) {
      if (!url) return;
      const isVideo = this.getAttribute('type') === 'video' || VIDEO_RE.test(url);
      if (this._isVideo && this._media) this._media.pause();
      if (isVideo) {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.src = url;
        v.addEventListener('loadeddata', () => {
          this._media = v;
          this._isVideo = true;
          this._srcDirty = true;
          v.play().catch(() => {});
          this._requestRender();
          this._syncLoop();
        });
        v.addEventListener('error', e => console.error('halftone-fx: video failed', e));
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.addEventListener('load', () => {
          this._media = img;
          this._isVideo = false;
          this._srcDirty = true;
          this._requestRender();
          this._syncLoop();
        });
        img.addEventListener('error', e => console.error('halftone-fx: image failed', e));
        img.src = url;
      }
    }

    _gridPx() {
      const dpr = window.devicePixelRatio || 1;
      const g = parseFloat(this.getAttribute('grid')) || 80;
      return Math.max(1, g) * dpr;
    }

    _resize() {
      const gl = this._gl;
      if (!gl) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.clientHeight * dpr));
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
      }
      const grid = this._gridPx();
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const cw = Math.min(maxTex, Math.max(1, Math.ceil(w / grid)));
      const ch = Math.min(maxTex, Math.max(1, Math.ceil(h / grid)));
      if (cw !== this._cellW || ch !== this._cellH) {
        this._cellW = cw;
        this._cellH = ch;
        gl.bindTexture(gl.TEXTURE_2D, this._cellTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      this._requestRender();
    }

    _animating() {
      if (this.hasAttribute('paused') || !this._visible || !this._media) return false;
      return this._isVideo || this.getAttribute('dither') === 'noise';
    }

    _syncLoop() {
      if (this._animating()) {
        if (!this._raf) {
          const tick = (t) => {
            this._raf = this._animating() ? requestAnimationFrame(tick) : 0;
            this._render(t / 1000);
          };
          this._raf = requestAnimationFrame(tick);
        }
      } else {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      }
    }

    _requestRender() {
      // One-shot render for static states (loop handles animated ones).
      if (this._raf || !this._gl || !this._media) return;
      requestAnimationFrame(t => { if (!this._raf) this._render(t / 1000); });
    }

    _render(time) {
      const gl = this._gl;
      const media = this._media;
      if (!gl || !media) return;
      if (this._isVideo && media.readyState < 2) return;

      // Upload source frame (every frame for video, once for images).
      if (this._isVideo || this._srcDirty) {
        gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, media);
        gl.generateMipmap(gl.TEXTURE_2D);
        this._srcDirty = false;
      }

      // Pass 1: average brightness per cell.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._cellTex, 0);
      gl.viewport(0, 0, this._cellW, this._cellH);
      gl.useProgram(this._progDown);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
      gl.uniform1i(this._u.down.src, 0);
      const brightness = parseFloat(this.getAttribute('brightness'));
      gl.uniform1f(this._u.down.brightness, (Number.isFinite(brightness) ? brightness : 12) / 255);
      const c = parseFloat(this.getAttribute('contrast')) || 0;
      gl.uniform1f(this._u.down.contrast, (259 * (c + 255)) / (255 * (259 - c)));
      gl.uniform1f(this._u.down.gamma, parseFloat(this.getAttribute('gamma')) || 1);
      const srcW = media.videoWidth || media.naturalWidth || media.width || 1;
      const srcH = media.videoHeight || media.naturalHeight || media.height || 1;
      gl.uniform1f(this._u.down.srcAspect, srcW / srcH);
      gl.uniform1f(this._u.down.dstAspect, this._canvas.width / this._canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass 2: evenly fitted marks. Exact tiling keeps opposite edges symmetric.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this._canvas.width, this._canvas.height);
      gl.useProgram(this._progMain);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._cellTex);
      gl.uniform1i(this._u.main.cells, 0);
      gl.uniform2f(this._u.main.cellSize,
        this._canvas.width / this._cellW,
        this._canvas.height / this._cellH);
      gl.uniform2i(this._u.main.cellDims, this._cellW, this._cellH);
      gl.uniform3fv(this._u.main.dotColor, hexToRgba(this.getAttribute('dot-color'), [1, 49 / 255, 16 / 255, 1]).slice(0, 3));
      gl.uniform4fv(this._u.main.bg, hexToRgba(this.getAttribute('background'), [0, 0, 0, 0]));
      gl.uniform1i(this._u.main.multicolor, this.hasAttribute('multicolor') ? 1 : 0);
      const DITHER_CODES = { none: 0, bayer: 1, bayer4: 1, bayer8: 2, grain: 3, noise: 4 };
      gl.uniform1i(this._u.main.dither, DITHER_CODES[this.getAttribute('dither')] || 0);
      gl.uniform1i(this._u.main.shape, this.getAttribute('shape') === 'circle' ? 1 : 0);
      const threshold = parseFloat(this.getAttribute('threshold'));
      gl.uniform1f(this._u.main.threshold,
        Math.min(100, Math.max(0, Number.isFinite(threshold) ? threshold : 50)) / 100);
      const markSize = parseFloat(this.getAttribute('mark-size'));
      gl.uniform1f(this._u.main.markScale,
        Math.min(100, Math.max(0, Number.isFinite(markSize) ? markSize : 42)) / 100);
      gl.uniform1f(this._u.main.time, time || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  customElements.define('halftone-fx', HalftoneFX);
})();
