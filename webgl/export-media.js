(() => {
  'use strict';

  const SCRIPT_URL = new URL(document.currentScript.src);
  const SCRIPT_BASE = new URL('.', SCRIPT_URL);
  const VIDEO_FPS = 30;
  const GIF_FPS = 10;
  const VIDEO_MAX_SIZE = 1080;
  const GIF_MAX_SIZE = 480;
  const VIDEO_BITRATE = 6_000_000;

  const VIDEO_MIMES = {
    mp4: [
      'video/mp4;codecs=avc1.42E028',
      'video/mp4;codecs=avc1.4D4028',
      'video/mp4;codecs=avc1',
    ],
    webm: [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ],
  };

  function assetUrl(name) {
    const url = new URL(name, SCRIPT_BASE);
    url.search = SCRIPT_URL.search;
    return url;
  }

  function abortError(message = 'Export cancelled') {
    return new DOMException(message, 'AbortError');
  }

  function visibilityError() {
    const error = new Error('Export stopped because the tab was hidden. Keep it visible and try again.');
    error.name = 'VisibilityError';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || abortError();
  }

  function abortable(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason || abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  function supportsMime(type) {
    try {
      return typeof MediaRecorder !== 'undefined' &&
        typeof MediaRecorder.isTypeSupported === 'function' &&
        MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }

  function nextVisibleFrame(signal) {
    return new Promise((resolve, reject) => {
      let raf = 0;

      const cleanup = () => {
        if (raf) cancelAnimationFrame(raf);
        signal?.removeEventListener('abort', onAbort);
        document.removeEventListener('visibilitychange', onVisibility);
      };
      const fail = error => {
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(signal.reason || abortError());
      const onVisibility = () => {
        if (document.hidden) fail(visibilityError());
      };

      if (signal?.aborted) return onAbort();
      if (document.hidden) return onVisibility();

      signal?.addEventListener('abort', onAbort, { once: true });
      document.addEventListener('visibilitychange', onVisibility);
      raf = requestAnimationFrame(now => {
        cleanup();
        resolve(now);
      });
    });
  }

  async function waitUntilFrame(targetTime, signal) {
    throwIfAborted(signal);
    if (document.hidden) throw visibilityError();
    let now = performance.now();
    while (now < targetTime) now = await nextVisibleFrame(signal);
    if (document.hidden) throw visibilityError();
    return now;
  }

  function requestWorker(worker, message, transfer, signal, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onMessage = event => {
        if (event.data?.type === 'error') {
          cleanup();
          reject(new Error(event.data.message || 'GIF encoding failed'));
          return;
        }
        cleanup();
        resolve(event.data);
      };
      const onError = event => {
        cleanup();
        reject(new Error(event.message || 'GIF worker failed'));
      };
      const onAbort = () => {
        cleanup();
        worker.terminate();
        reject(signal.reason || abortError());
      };

      if (signal?.aborted) return onAbort();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs) timer = setTimeout(() => {
        cleanup();
        reject(new Error('GIF worker did not start in time'));
      }, timeoutMs);
      try {
        worker.postMessage(message, transfer || []);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  class MimonoMediaExporter {
    constructor(effect, options = {}) {
      this.effect = effect;
      this.getMatte = options.getMatte || (() => '#f3f3f3');
    }

    static capabilities() {
      const capture = typeof HTMLCanvasElement !== 'undefined' &&
        typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
        typeof MediaRecorder !== 'undefined';
      return {
        mp4: capture && VIDEO_MIMES.mp4.some(supportsMime),
        webm: capture && VIDEO_MIMES.webm.some(supportsMime),
        gif: typeof Worker !== 'undefined',
      };
    }

    static async gifSupported() {
      if (typeof Worker === 'undefined') return false;
      let worker;
      try {
        worker = new Worker(assetUrl('gif-worker.js'), { type: 'module' });
        const response = await requestWorker(worker, {
          type: 'start', width: 2, height: 2, delay: 100,
        }, [], undefined, 3000);
        return response?.type === 'ready';
      } catch {
        return false;
      } finally {
        worker?.terminate();
      }
    }

    async export(format, options = {}) {
      const duration = Math.max(1, Math.min(12, Number(options.duration) || 3));
      const signal = options.signal;
      const onProgress = options.onProgress || (() => {});
      throwIfAborted(signal);
      await abortable(this.effect.whenReady?.(), signal);
      throwIfAborted(signal);

      if (format === 'png') {
        onProgress({ stage: 'rendering', format });
        const blob = await this.effect.snapshot();
        throwIfAborted(signal);
        return { blob, extension: 'png', mimeType: 'image/png' };
      }
      const finishCapture = this.effect.beginCapture?.() || (() => {});
      try {
        if (format === 'gif') {
          return await this._exportGif(Math.min(duration, 6), onProgress, signal);
        }
        if (format === 'mp4' || format === 'webm') {
          return await this._exportVideo(format, duration, onProgress, signal);
        }
      } finally {
        finishCapture();
      }
      throw new Error(`Unknown export format: ${format}`);
    }

    _surface(maxSize, willReadFrequently = false) {
      const captureSource = this.effect.source;
      const source = this.effect.renderNow({ advanceMotion: true });
      if (!source.width || !source.height) throw new Error('The preview is not ready to export yet.');

      const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
      const even = value => Math.max(2, Math.round(value * scale / 2) * 2);
      const canvas = document.createElement('canvas');
      canvas.width = even(source.width);
      canvas.height = even(source.height);
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently });
      if (!context) throw new Error('Could not create the export canvas.');

      const draw = () => {
        if (this.effect.source !== captureSource) {
          throw new Error('The source changed during export. Try again with the new source.');
        }
        const current = this.effect.renderNow({ advanceMotion: true });
        context.fillStyle = this.getMatte();
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(current, 0, 0, canvas.width, canvas.height);
      };

      return { canvas, context, draw };
    }

    _createRecorder(stream, format) {
      if (typeof MediaRecorder === 'undefined') return null;
      for (const mimeType of VIDEO_MIMES[format]) {
        if (!supportsMime(mimeType)) continue;
        try {
          const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: VIDEO_BITRATE,
          });
          return { recorder, mimeType };
        } catch {
          // A browser can report support and still reject the codec at runtime.
        }
      }
      return null;
    }

    async _exportVideo(format, duration, onProgress, signal) {
      const surface = this._surface(VIDEO_MAX_SIZE);
      if (typeof surface.canvas.captureStream !== 'function') {
        throw new Error('Video export is not available in this browser.');
      }

      surface.draw();
      let stream;
      try {
        stream = surface.canvas.captureStream(VIDEO_FPS);
      } catch (error) {
        if (error?.name === 'SecurityError') {
          throw new Error('This source cannot be recorded because its host does not allow canvas export.');
        }
        throw error;
      }

      const choice = this._createRecorder(stream, format);
      if (!choice) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error(`${format.toUpperCase()} export is not available in this browser.`);
      }

      const { recorder, mimeType } = choice;
      const chunks = [];
      let recorderError = null;
      recorder.addEventListener('dataavailable', event => {
        if (event.data?.size) chunks.push(event.data);
      });
      recorder.addEventListener('error', event => {
        recorderError = event.error || new Error(`${format.toUpperCase()} recording failed.`);
      });
      const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));

      let captureError = null;
      let started = false;
      try {
        recorder.start(250);
        started = true;
        const start = performance.now();
        const frameInterval = 1000 / VIDEO_FPS;
        let lastDraw = start;
        let elapsed = 0;
        while (elapsed < duration) {
          const now = await nextVisibleFrame(signal);
          if (recorderError) throw recorderError;
          if (recorder.state === 'inactive') throw new Error(`${format.toUpperCase()} recording stopped early.`);
          elapsed = Math.min(duration, (now - start) / 1000);
          if (elapsed < duration && now - lastDraw < frameInterval - 1) continue;
          surface.draw();
          lastDraw = now;
          onProgress({ stage: 'recording', format, elapsed, duration });
        }
      } catch (error) {
        captureError = error;
      }

      try {
        if (started && !captureError) onProgress({ stage: 'finalizing', format });
        if (started && recorder.state !== 'inactive') recorder.stop();
        if (started) await stopped;
      } finally {
        stream.getTracks().forEach(track => track.stop());
      }

      if (captureError) throw captureError;
      if (recorderError) throw recorderError;
      throwIfAborted(signal);
      if (!chunks.length) throw new Error(`No ${format.toUpperCase()} video data was recorded.`);

      const type = (recorder.mimeType || mimeType).split(';')[0];
      if (format === 'mp4' && type !== 'video/mp4') {
        throw new Error('The browser did not produce a real MP4 file.');
      }
      return {
        blob: new Blob(chunks, { type }),
        extension: format,
        mimeType: type,
      };
    }

    async _exportGif(duration, onProgress, signal) {
      const surface = this._surface(GIF_MAX_SIZE, true);
      const frameCount = Math.round(duration * GIF_FPS);
      const frameDelay = 1000 / GIF_FPS;
      let worker;
      try {
        worker = new Worker(assetUrl('gif-worker.js'), { type: 'module' });
      } catch {
        throw new Error('GIF export could not start in this browser.');
      }
      try {
        try {
          await requestWorker(worker, {
            type: 'start',
            width: surface.canvas.width,
            height: surface.canvas.height,
            delay: frameDelay,
          }, [], signal);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw new Error('GIF export could not start in this browser.');
        }

        const start = performance.now();
        let logicalIndex = 0;
        let pendingFrame = null;
        let pendingIndex = 0;

        while (logicalIndex < frameCount) {
          throwIfAborted(signal);
          const now = await waitUntilFrame(start + logicalIndex * frameDelay, signal);
          const sampledIndex = Math.min(frameCount - 1, Math.max(
            logicalIndex, Math.floor((now - start) / frameDelay),
          ));
          surface.draw();
          let frame;
          try {
            frame = surface.context.getImageData(
              0, 0, surface.canvas.width, surface.canvas.height,
            ).data;
          } catch (error) {
            if (error?.name === 'SecurityError') {
              throw new Error('This source cannot be recorded because its host does not allow canvas export.');
            }
            throw error;
          }

          if (pendingFrame) {
            const delay = (sampledIndex - pendingIndex) * frameDelay;
            await requestWorker(worker, {
              type: 'frame', buffer: pendingFrame.buffer, delay,
            }, [pendingFrame.buffer], signal);
          }
          pendingFrame = frame;
          pendingIndex = sampledIndex;
          logicalIndex = sampledIndex + 1;
          onProgress({ stage: 'capturing', format: 'gif', current: logicalIndex, total: frameCount });
        }

        if (!pendingFrame) throw new Error('No GIF frames were captured.');
        await requestWorker(worker, {
          type: 'frame',
          buffer: pendingFrame.buffer,
          delay: (frameCount - pendingIndex) * frameDelay,
        }, [pendingFrame.buffer], signal);
        onProgress({ stage: 'finalizing', format: 'gif' });
        const result = await requestWorker(worker, { type: 'finish' }, [], signal);
        throwIfAborted(signal);
        const blob = new Blob([result.buffer], { type: 'image/gif' });
        if (!blob.size) throw new Error('No GIF data was encoded.');
        return { blob, extension: 'gif', mimeType: 'image/gif' };
      } finally {
        worker.terminate();
      }
    }
  }

  window.MimonoMediaExporter = MimonoMediaExporter;
})();
