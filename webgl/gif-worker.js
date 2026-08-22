import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js?v=15';

let gif = null;
let width = 0;
let height = 0;
let delay = 100;
let frameNumber = 0;

self.addEventListener('message', event => {
  try {
    const message = event.data;

    if (message.type === 'start') {
      width = message.width;
      height = message.height;
      delay = message.delay;
      frameNumber = 0;
      gif = GIFEncoder();
      self.postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'frame') {
      if (!gif) throw new Error('GIF encoder has not been started');
      const pixels = new Uint8ClampedArray(message.buffer);
      const palette = quantize(pixels, 128, { format: 'rgb444' });
      const indexed = applyPalette(pixels, palette, 'rgb444');
      const frameDelay = Number.isFinite(message.delay) ? message.delay : delay;
      gif.writeFrame(indexed, width, height, {
        palette,
        delay: frameDelay,
        repeat: 0,
      });
      frameNumber += 1;
      self.postMessage({ type: 'frame', frameNumber });
      return;
    }

    if (message.type === 'finish') {
      if (!gif || frameNumber === 0) throw new Error('No GIF frames were encoded');
      gif.finish();
      const bytes = gif.bytes();
      gif = null;
      self.postMessage({ type: 'done', buffer: bytes.buffer }, [bytes.buffer]);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
