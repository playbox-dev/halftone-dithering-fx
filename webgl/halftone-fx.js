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
 *   aspect       — source (default) | square | a ratio such as 16/9
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
 *   motion       — off | pulse | radial | sweep | interference | scan (default off)
 *   amount       — motion depth, 0..100 (default 35)
 *   speed        — motion rate, 0..100; 0 freezes the field (default 35)
 *   phase        — starting motion pose in radians (normally emitted by the exporter)
 *   overdrive / flux / seed — deprecated aliases retained for older embeds
 *   paused       — present = freeze rendering
 *
 * JS API: el.play(), el.pause(), el.whenReady(), el.sourceDimensions,
 *         el.renderNow(), el.snapshot(), el.source = <img|video|canvas element>
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
  uniform int uMotion;        // 0 off, 1–5 Motion modes, 6 deprecated Overdrive path
  uniform float uMotionAmount;
  uniform float uMotionPhase;
  uniform float uSeed;        // legacy phase offset for old seeded embeds
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
    // Legacy Overdrive mirrored its dither pattern. New Motion modes leave the
    // source/dither result untouched and only resize its marks.
    ivec2 patternCell = uMotion == 6 ? min(cell, uCellDims - 1 - cell) : cell;
    float v = texelFetch(uCells, cell, 0).r;

    if (uDither == 1) {
      v = v < bayer4(patternCell) ? 0.0 : 1.0;
    } else if (uDither == 2) {
      v = v < bayer8(patternCell) ? 0.0 : 1.0;
    } else if (uDither == 3) {
      v = v < ign(vec2(patternCell)) ? 0.0 : 1.0;
    } else if (uDither == 4) {
      // Animated grain, stepped at ~30fps like film.
      float n = hash(vec2(patternCell) + floor(uTime * 30.0) * vec2(13.7, 7.3)) - 0.5;
      v = (v + n * 0.4) < 0.5 ? 0.0 : 1.0;
    }

    float baseMarkSize = 1.0 - v;
    float markSize = baseMarkSize;
    if (uMotion == 6) {
      // Exact rendering path for embeds exported before Motion replaced Overdrive.
      float rate = mix(0.22, 1.15, uMotionAmount);
      float phase = uMotionPhase * rate + uSeed * 0.017;
      vec2 p = vec2(cell) + 0.5;
      vec2 fieldCenter = vec2(uCellDims) * 0.5;
      vec2 legacyQ = abs(p - fieldCenter);
      float wave = 0.5
        + 0.25 * sin(legacyQ.x * 0.31 + phase)
        + 0.25 * cos(legacyQ.y * 0.27 - phase * 0.83);
      float orbit = 0.5 + 0.5 * sin(length(legacyQ) * 0.45 - phase * 0.57);
      float field = mix(wave, orbit, 0.35) - 0.5;
      markSize = clamp(markSize + field * mix(0.18, 0.52, uMotionAmount), 0.0, 1.0);
    } else if (uMotion > 0 && uMotionAmount > 0.0) {
      const float TAU = 6.28318530718;
      vec2 canvasSize = vec2(uCellDims) * uCellSize;
      vec2 cellCenter = (vec2(cell) + 0.5) * uCellSize;
      // Normalize both axes by the same physical distance so circular and
      // square motion fields stay geometric on portrait and landscape frames.
      vec2 q = abs(cellCenter - canvasSize * 0.5) / (min(canvasSize.x, canvasSize.y) * 0.5);
      float phase = uMotionPhase + uSeed * 0.017;
      float field = 0.0;

      if (uMotion == 1) {
        // Pulse: the source breathes as a single printing plate.
        field = sin(phase);
      } else if (uMotion == 2) {
        // Radial: concentric circular fronts.
        field = sin(TAU * 1.25 * length(q) - phase);
      } else if (uMotion == 3) {
        // Sweep: a square front moves from the centre to the edge.
        field = sin(TAU * 0.85 * max(q.x, q.y) - phase);
      } else if (uMotion == 4) {
        // Interference: perpendicular waves form a changing lattice.
        field = sin(TAU * 1.35 * q.x - phase)
              * sin(TAU * 1.10 * q.y - phase * 0.79);
      } else if (uMotion == 5) {
        // Scan: a thin mirrored cross travels outwards and back.
        float position = 0.5 + 0.5 * sin(phase - 1.57079632679);
        float bandX = 1.0 - smoothstep(0.04, 0.16, abs(q.x - position));
        float bandY = 1.0 - smoothstep(0.04, 0.16, abs(q.y - position));
        field = max(bandX, bandY) * 1.35 - 0.35;
      }

      // Motion changes existing marks only; it never invents source detail.
      float scale = max(0.1, 1.0 + field * uMotionAmount * 0.65);
      markSize = clamp(baseMarkSize * scale, 0.0, 1.0);
    }
    float halfSize = min(uCellSize.x, uCellSize.y) * 0.5 * markSize * uMarkScale;
    vec2 center = (vec2(cell) + 0.5) * uCellSize;
    vec2 delta = abs(fc - center);
    float d = uShape == 1 ? length(delta) : max(delta.x, delta.y);
    float m;
    float thresholdSize = uMotion == 6 ? markSize : baseMarkSize;
    if (thresholdSize < uThreshold || v >= 0.999) {
      m = 0.0; // Pure white must not leave a sub-pixel speck.
    } else if (uMotion == 0 && uShape == 0 && v <= 0.001 && uMarkScale >= 0.999) {
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

  // Kept solely so already-published Overdrive URLs preserve their old motion.
  function seedPhase(seed, channel) {
    let x = ((seed >>> 0) + Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    return (x / 4294967296) * Math.PI * 2;
  }

  function wrapPhase(value) {
    if (!Number.isFinite(value)) return Math.PI * 0.5;
    const tau = Math.PI * 2;
    return ((value % tau) + tau) % tau;
  }

  const VIDEO_RE = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i;

  class HalftoneFX extends HTMLElement {
    static get observedAttributes() {
      return ['src', 'type', 'aspect', 'grid', 'shape', 'threshold', 'mark-size', 'dot-color', 'background', 'brightness',
              'contrast', 'gamma', 'dither', 'multicolor', 'motion', 'amount', 'speed', 'phase',
              'overdrive', 'flux', 'seed', 'paused'];
    }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        :host {
          display: block;
          overflow: hidden;
          aspect-ratio: var(--halftone-frame-aspect, var(--halftone-source-aspect, 1));
        }
        canvas { display: block; width: 100%; height: 100%; }
      </style><canvas></canvas>`;
      this._canvas = root.querySelector('canvas');
      this._media = null;          // HTMLImageElement | HTMLVideoElement | canvas
      this._isVideo = false;
      this._raf = 0;
      this._onceRaf = 0;
      this._visible = true;
      this._cellW = 0;
      this._cellH = 0;
      this._srcDirty = true;       // media needs (re)upload
      this._motionPhase = Math.PI * 0.5;
      this._motionElapsed = 0;
      this._lastMotionTime = 0;
      this._captureCount = 0;
      this._loadGeneration = 0;
      this._sourceReady = Promise.resolve();
      this._resolveSourceReady = null;
      this._sourceError = null;
      this._sourceWidth = 0;
      this._sourceHeight = 0;
      this._assignedSourceCleanup = null;
      this._sourceAssigned = false;
      this._preferAssignedSource = false;
      this._motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this._reduceMotion = this._motionQuery.matches;
      this._onMotionChange = event => {
        this._reduceMotion = event.matches;
        this._lastMotionTime = 0;
        this._requestRender();
        this._syncLoop();
      };
    }

    connectedCallback() {
      this._reduceMotion = this._motionQuery.matches;
      const gl = this._canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false,
      });
      if (!gl) {
        this.shadowRoot.innerHTML = '<p style="color:#888;font:13px sans-serif">WebGL2 not available</p>';
        return;
      }
      this._gl = gl;
      const initialPhase = parseFloat(this.getAttribute('phase'));
      this._motionPhase = wrapPhase(initialPhase);
      this._motionElapsed = 0;
      this._lastMotionTime = 0;
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
          motion: gl.getUniformLocation(this._progMain, 'uMotion'),
          motionAmount: gl.getUniformLocation(this._progMain, 'uMotionAmount'),
          motionPhase: gl.getUniformLocation(this._progMain, 'uMotionPhase'),
          seed: gl.getUniformLocation(this._progMain, 'uSeed'),
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
      this._motionQuery.addEventListener('change', this._onMotionChange);
      this._io = new IntersectionObserver(entries => {
        this._visible = entries[0].isIntersecting;
        this._syncLoop();
      });
      this._io.observe(this);

      this._updateAspectRatio();
      this._resize();
      if (this._preferAssignedSource) {
        if (this._media) {
          const assignedSource = this._media;
          this.source = assignedSource;
        }
      } else if (this.hasAttribute('src')) {
        this._loadSrc(this.getAttribute('src'));
      }
    }

    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      cancelAnimationFrame(this._onceRaf);
      this._raf = 0;
      this._onceRaf = 0;
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      this._motionQuery.removeEventListener('change', this._onMotionChange);
      if (this._assignedSourceCleanup) {
        this._assignedSourceCleanup();
        this._assignedSourceCleanup = null;
      }
      if (!this._sourceAssigned && this._isVideo && this._media) this._media.pause();
      if (this._gl) {
        this._gl.deleteTexture(this._srcTex);
        this._gl.deleteTexture(this._cellTex);
        this._gl.deleteFramebuffer(this._fbo);
        this._gl.deleteProgram(this._progDown);
        this._gl.deleteProgram(this._progMain);
        this._srcTex = null;
        this._cellTex = null;
        this._fbo = null;
        this._progDown = null;
        this._progMain = null;
        this._u = null;
        this._gl = null;
        this._cellW = 0;
        this._cellH = 0;
        this._srcDirty = true;
      }
    }

    attributeChangedCallback(name, _old, value) {
      if (name === 'src' && value) this._preferAssignedSource = false;
      if (!this._gl) return; // connectedCallback handles initial state
      if (name === 'src') this._loadSrc(value);
      else if (name === 'grid') this._resize();
      else if (name === 'aspect') this._updateAspectRatio();
      else this._requestRender();
      if (name === 'phase') {
        const phase = parseFloat(value);
        this._motionPhase = wrapPhase(phase);
        this._lastMotionTime = 0;
      } else if (name === 'motion' || name === 'overdrive' || name === 'seed') {
        this._motionPhase = wrapPhase(parseFloat(this.getAttribute('phase')));
        this._motionElapsed = 0;
        this._lastMotionTime = 0;
      }
      this._syncLoop();
    }

    /** Assign an existing <img>, <video>, or <canvas> as the source. */
    set source(el) {
      const previousWasAssigned = this._sourceAssigned;
      const previousMedia = this._media;
      const previousWasVideo = this._isVideo;
      this._assignedSourceCleanup?.();
      this._assignedSourceCleanup = null;
      if (!previousWasAssigned && previousWasVideo && previousMedia) previousMedia.pause();
      this._sourceAssigned = true;
      this._preferAssignedSource = true;
      this._resolveSourceReady?.();
      const generation = ++this._loadGeneration;
      this._resolveSourceReady = null;
      this._sourceError = null;
      this._media = el;
      this._isVideo = el instanceof HTMLVideoElement;
      this._srcDirty = true;

      if (!el) {
        this._sourceReady = Promise.resolve();
        this._updateAspectRatio();
        this._requestRender();
        this._syncLoop();
        return;
      }

      let settled = false;
      const isReady = () => this._isVideo
        ? el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0
        : !(el instanceof HTMLImageElement) || (el.naturalWidth > 0 && el.naturalHeight > 0);
      this._sourceReady = isReady()
        ? Promise.resolve()
        : new Promise(resolve => { this._resolveSourceReady = resolve; });

      const update = (error = null, ready = true) => {
        if (generation !== this._loadGeneration || this._media !== el) return;
        this._sourceError = error;
        this._srcDirty = !error;
        this._updateAspectRatio();
        if ((ready || error) && !settled) {
          settled = true;
          this._resolveSourceReady?.();
          this._resolveSourceReady = null;
        }
        if (!ready && !error) {
          this._requestRender();
          return;
        }
        this.dispatchEvent(new CustomEvent(error ? 'source-error' : 'source-ready', {
          detail: {
            src: null,
            error,
            width: this._sourceWidth,
            height: this._sourceHeight,
            aspectRatio: this.sourceAspectRatio,
          },
        }));
        this._requestRender();
        this._syncLoop();
      };
      const onError = () => update(new Error('halftone-fx: assigned media failed to load'));

      if (el instanceof HTMLVideoElement) {
        const onMetadata = () => update(null, false);
        const onReady = () => update();
        const onResize = () => update(null, isReady());
        const onPlayback = () => {
          this._requestRender();
          this._syncLoop();
        };
        el.addEventListener('loadedmetadata', onMetadata);
        el.addEventListener('loadeddata', onReady);
        el.addEventListener('resize', onResize);
        el.addEventListener('play', onPlayback);
        el.addEventListener('pause', onPlayback);
        el.addEventListener('ended', onPlayback);
        el.addEventListener('seeked', onPlayback);
        el.addEventListener('error', onError);
        this._assignedSourceCleanup = () => {
          el.removeEventListener('loadedmetadata', onMetadata);
          el.removeEventListener('loadeddata', onReady);
          el.removeEventListener('resize', onResize);
          el.removeEventListener('play', onPlayback);
          el.removeEventListener('pause', onPlayback);
          el.removeEventListener('ended', onPlayback);
          el.removeEventListener('seeked', onPlayback);
          el.removeEventListener('error', onError);
        };
      } else if (el instanceof HTMLImageElement && !isReady()) {
        const onReady = () => update();
        el.addEventListener('load', onReady, { once: true });
        el.addEventListener('error', onError, { once: true });
        this._assignedSourceCleanup = () => {
          el.removeEventListener('load', onReady);
          el.removeEventListener('error', onError);
        };
      }

      if (isReady()) update();
    }
    get source() { return this._media; }
    get sourceWidth() { return this._sourceWidth; }
    get sourceHeight() { return this._sourceHeight; }
    get sourceAspectRatio() {
      return this._sourceWidth > 0 && this._sourceHeight > 0
        ? this._sourceWidth / this._sourceHeight : 1;
    }
    get sourceDimensions() {
      return {
        width: this._sourceWidth,
        height: this._sourceHeight,
        aspectRatio: this.sourceAspectRatio,
      };
    }

    play() { this.removeAttribute('paused'); }
    pause() { this.setAttribute('paused', ''); }
    get motionPhase() { return this._motionPhase; }

    /** Wait until the most recently requested source is ready. */
    async whenReady() {
      while (true) {
        const generation = this._loadGeneration;
        await this._sourceReady;
        if (generation === this._loadGeneration) break;
      }
      if (this._sourceError) throw this._sourceError;
      if (!this._media) throw new Error('halftone-fx: no source is ready');
      return this;
    }

    /** Temporarily stop the preview loop while an external capture clock renders frames. */
    beginCapture() {
      this._captureCount += 1;
      this._syncLoop();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        this._captureCount = Math.max(0, this._captureCount - 1);
        this._lastMotionTime = 0;
        this._syncLoop();
      };
    }

    /** Render immediately and return the component's live WebGL canvas. */
    renderNow({ advanceMotion = false } = {}) {
      if (!this._gl || !this._media) {
        throw new Error('halftone-fx: no source is ready to render');
      }
      // Aspect changes can land before ResizeObserver's next callback. Sync the
      // backing canvas now so an immediate download has the visible frame ratio.
      this._resize(false);
      this._render(performance.now() / 1000, advanceMotion);
      this._gl.flush();
      return this._canvas;
    }

    /** Capture the current full-resolution WebGL frame as an image Blob. */
    async snapshot(type = 'image/png', quality) {
      await this.whenReady();
      return new Promise((resolve, reject) => {
        if (!this._gl || !this._media) {
          reject(new Error('halftone-fx: no source is ready to capture'));
          return;
        }
        const canvas = this.renderNow();
        this._gl.finish();
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('halftone-fx: snapshot failed'));
        }, type, quality);
      });
    }

    // --- internals -----------------------------------------------------

    _loadSrc(url) {
      if (!url) return;
      const previousWasAssigned = this._sourceAssigned;
      this._preferAssignedSource = false;
      this._assignedSourceCleanup?.();
      this._assignedSourceCleanup = null;
      // A URL replaces a caller-owned source immediately, but never pauses it.
      // Clearing the fallback keeps failed/in-flight loads from reclassifying
      // external media as component-owned during a disconnect.
      if (previousWasAssigned) {
        this._media = null;
        this._isVideo = false;
        this._sourceAssigned = false;
        this._srcDirty = true;
        this._updateAspectRatio();
      }
      this._resolveSourceReady?.();
      const generation = ++this._loadGeneration;
      this._sourceError = null;
      this._sourceReady = new Promise(resolve => { this._resolveSourceReady = resolve; });
      const settle = error => {
        if (generation !== this._loadGeneration) return false;
        this._sourceError = error || null;
        this._resolveSourceReady?.();
        this._resolveSourceReady = null;
        this.dispatchEvent(new CustomEvent(error ? 'source-error' : 'source-ready', {
          detail: {
            src: url,
            error: error || null,
            width: this._sourceWidth,
            height: this._sourceHeight,
            aspectRatio: this.sourceAspectRatio,
          },
        }));
        return true;
      };
      const isVideo = this.getAttribute('type') === 'video' || VIDEO_RE.test(url);
      if (!previousWasAssigned && this._isVideo && this._media) this._media.pause();
      if (isVideo) {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.src = url;
        const syncPlayback = () => {
          if (generation !== this._loadGeneration || !this.isConnected) return;
          this._requestRender();
          this._syncLoop();
        };
        v.addEventListener('play', syncPlayback);
        v.addEventListener('pause', syncPlayback);
        v.addEventListener('ended', syncPlayback);
        v.addEventListener('seeked', syncPlayback);
        v.addEventListener('loadeddata', () => {
          if (generation !== this._loadGeneration || !this.isConnected) {
            v.pause();
            return;
          }
          this._media = v;
          this._isVideo = true;
          this._srcDirty = true;
          this._updateAspectRatio();
          v.play().catch(() => {});
          settle();
          this._requestRender();
          this._syncLoop();
        });
        v.addEventListener('error', () => {
          const error = new Error(`halftone-fx: video failed to load: ${url}`);
          if (settle(error)) console.error(error);
        });
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.addEventListener('load', () => {
          if (generation !== this._loadGeneration || !this.isConnected) return;
          this._media = img;
          this._isVideo = false;
          this._srcDirty = true;
          this._updateAspectRatio();
          settle();
          this._requestRender();
          this._syncLoop();
        });
        img.addEventListener('error', () => {
          const error = new Error(`halftone-fx: image failed to load: ${url}`);
          if (settle(error)) console.error(error);
        });
        img.src = url;
      }
    }

    _updateAspectRatio() {
      const media = this._media;
      const width = media?.videoWidth || media?.naturalWidth || media?.width || 0;
      const height = media?.videoHeight || media?.naturalHeight || media?.height || 0;
      this._sourceWidth = Number.isFinite(width) && width > 0 ? width : 0;
      this._sourceHeight = Number.isFinite(height) && height > 0 ? height : 0;
      if (this._sourceWidth && this._sourceHeight) {
        this.style.setProperty('--halftone-source-aspect', `${this._sourceWidth} / ${this._sourceHeight}`);
      } else {
        this.style.removeProperty('--halftone-source-aspect');
      }

      const raw = (this.getAttribute('aspect') || 'source').trim().toLowerCase();
      let forced = '';
      if (raw === 'square' || raw === '1:1') {
        forced = '1 / 1';
      } else if (!['', 'source', 'auto', 'original'].includes(raw)) {
        const parts = raw.split(/[/:]/).map(Number);
        const ratio = parts.length === 2 && parts[0] > 0 && parts[1] > 0
          ? parts[0] / parts[1] : Number(raw);
        if (Number.isFinite(ratio) && ratio > 0) forced = String(ratio);
      }
      if (forced) this.style.setProperty('--halftone-frame-aspect', forced);
      else this.style.removeProperty('--halftone-frame-aspect');
    }

    _gridPx() {
      const dpr = window.devicePixelRatio || 1;
      const g = parseFloat(this.getAttribute('grid')) || 80;
      return Math.max(1, g) * dpr;
    }

    _resize(requestRender = true) {
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
      if (requestRender) this._requestRender();
    }

    _motionSettings() {
      const MOTION_CODES = { off: 0, none: 0, pulse: 1, radial: 2, sweep: 3, interference: 4, scan: 5 };
      const explicitMode = this.getAttribute('motion');
      const legacy = explicitMode === null && this.hasAttribute('overdrive');
      const code = explicitMode === null
        ? (legacy ? 6 : 0)
        : (MOTION_CODES[explicitMode.toLowerCase()] || 0);

      const rawFlux = parseFloat(this.getAttribute('flux'));
      const legacyValue = Math.min(10, Math.max(1, Number.isFinite(rawFlux) ? rawFlux : 5)) * 10;
      const rawAmount = parseFloat(this.getAttribute('amount'));
      const rawSpeed = parseFloat(this.getAttribute('speed'));
      const amount = Math.min(100, Math.max(0,
        Number.isFinite(rawAmount) ? rawAmount : (legacy ? legacyValue : 35))) / 100;
      const speed = Math.min(100, Math.max(0,
        Number.isFinite(rawSpeed) ? rawSpeed : (legacy ? legacyValue : 35))) / 100;
      const rawSeed = parseInt(this.getAttribute('seed'), 10);
      const seed = legacy ? (Number.isFinite(rawSeed) ? rawSeed >>> 0 : 1) : 0;
      return { code, amount, speed, seed, legacy };
    }

    _animating() {
      if (!this.isConnected || this._captureCount || this.hasAttribute('paused') || !this._visible || !this._media) return false;
      const motion = this._motionSettings();
      const movingField = motion.code > 0 && motion.amount > 0 && motion.speed > 0 && !this._reduceMotion;
      const animatedNoise = this.getAttribute('dither') === 'noise' && !this._reduceMotion;
      const playingVideo = this._isVideo && !this._media.paused && !this._media.ended;
      return playingVideo || animatedNoise || movingField;
    }

    _syncLoop() {
      if (this._animating()) {
        if (!this._raf) {
          cancelAnimationFrame(this._onceRaf);
          this._onceRaf = 0;
          const tick = (t) => {
            this._raf = this._animating() ? requestAnimationFrame(tick) : 0;
            this._render(t / 1000);
          };
          this._raf = requestAnimationFrame(tick);
        }
      } else {
        const wasAnimating = !!this._raf;
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        if (wasAnimating) this._requestRender();
      }
    }

    _requestRender() {
      // One-shot render for static states (loop handles animated ones).
      if (!this.isConnected || this._captureCount || this._raf || this._onceRaf || !this._gl || !this._media) return;
      this._onceRaf = requestAnimationFrame(t => {
        this._onceRaf = 0;
        if (!this._raf) this._render(t / 1000);
      });
    }

    _render(time, advanceWhileHidden = false) {
      const gl = this._gl;
      const media = this._media;
      if (!gl || !media) return;
      if (this._isVideo && media.readyState < 2) return;

      const motion = this._motionSettings();
      const movingField = motion.code > 0 && motion.amount > 0 && motion.speed > 0 && !this._reduceMotion;
      const advanceMotion = movingField && !this.hasAttribute('paused') &&
        (this._visible || advanceWhileHidden);
      if (advanceMotion) {
        if (this._lastMotionTime > 0) {
          const delta = Math.min(0.1, Math.max(0, (time || 0) - this._lastMotionTime));
          if (motion.legacy) {
            this._motionElapsed += delta;
          } else {
            const cyclesPerSecond = 0.025 + motion.speed * motion.speed * 0.375;
            this._motionPhase = (this._motionPhase + delta * cyclesPerSecond * Math.PI * 2) % (Math.PI * 2);
          }
        }
        this._lastMotionTime = time || 0;
      } else {
        this._lastMotionTime = 0;
      }
      const renderMotion = motion.legacy
        ? motion.code
        : (this._reduceMotion || motion.amount <= 0 ? 0 : motion.code);
      const legacyDrift = this._motionElapsed * (0.16 + motion.amount * 0.5);
      const legacySignal = channel => Math.sin(
        legacyDrift * (1 + channel * 0.137) + seedPhase(motion.seed, channel));

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
      const baseBrightness = Number.isFinite(brightness) ? brightness : 12;
      const effectiveBrightness = motion.legacy
        ? Math.min(100, Math.max(-100, baseBrightness + legacySignal(0) * (6 + motion.amount * 22)))
        : baseBrightness;
      gl.uniform1f(this._u.down.brightness, effectiveBrightness / 255);
      const baseContrast = parseFloat(this.getAttribute('contrast')) || 0;
      const effectiveContrast = motion.legacy
        ? Math.min(100, Math.max(-100, baseContrast + legacySignal(1) * (10 + motion.amount * 34)))
        : baseContrast;
      gl.uniform1f(this._u.down.contrast,
        (259 * (effectiveContrast + 255)) / (255 * (259 - effectiveContrast)));
      const baseGamma = parseFloat(this.getAttribute('gamma')) || 1;
      const effectiveGamma = motion.legacy
        ? Math.min(3, Math.max(0.1, baseGamma + legacySignal(2) * (0.12 + motion.amount * 0.42)))
        : baseGamma;
      gl.uniform1f(this._u.down.gamma, effectiveGamma);
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
      const baseThreshold = Math.min(100, Math.max(0, Number.isFinite(threshold) ? threshold : 50)) / 100;
      const effectiveThreshold = motion.legacy
        ? Math.min(0.95, Math.max(0, baseThreshold + legacySignal(3) * (0.04 + motion.amount * 0.2)))
        : baseThreshold;
      gl.uniform1f(this._u.main.threshold, effectiveThreshold);
      const markSize = parseFloat(this.getAttribute('mark-size'));
      const baseMarkScale = Math.min(100, Math.max(0, Number.isFinite(markSize) ? markSize : 42)) / 100;
      const effectiveMarkScale = motion.legacy
        ? Math.min(1, Math.max(0.05, baseMarkScale + legacySignal(4) * (0.06 + motion.amount * 0.2)))
        : baseMarkScale;
      gl.uniform1f(this._u.main.markScale, effectiveMarkScale);
      gl.uniform1i(this._u.main.motion, renderMotion);
      gl.uniform1f(this._u.main.motionAmount, motion.amount);
      gl.uniform1f(this._u.main.motionPhase, motion.legacy ? this._motionElapsed : this._motionPhase);
      gl.uniform1f(this._u.main.seed, motion.seed % 10000);
      gl.uniform1f(this._u.main.time, motion.legacy ? this._motionElapsed : (time || 0));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  customElements.define('halftone-fx', HalftoneFX);
})();
