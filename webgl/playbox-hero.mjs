// Keep media ownership here: pausing the effect alone only freezes its canvas.
export function createPlaybackController({load, onChange = () => {}, onError = () => {}, wanted = true}) {
  const state = {wanted, visible:false, pageVisible:true, ready:false};
  let media;
  let pending;
  let revision = 0;
  const shouldPlay = () => state.wanted && state.visible && state.pageVisible && state.ready;
  async function update(patch = {}) {
    Object.assign(state, patch);
    const current = ++revision;
    onChange({...state});
    if (!shouldPlay()) {
      media?.pause();
      return;
    }
    try {
      if (!media) {
        pending ||= Promise.resolve().then(load).then(result => (media = result)).catch(error => {
          pending = undefined;
          throw error;
        });
        await pending;
      }
      // A pause, hidden tab, or offscreen event may arrive during media loading.
      if (current !== revision || !shouldPlay()) {
        if (!shouldPlay()) media.pause();
        return;
      }
      await media.play();
      if (!shouldPlay()) media.pause();
    } catch (error) {
      // Ignore a cancelled attempt when a newer state already owns playback.
      if (current !== revision) return;
      pending = undefined;
      state.wanted = false;
      media?.pause();
      onChange({...state});
      onError(error);
    }
  }
  return {update, getState:() => ({...state})};
}

export async function mountHero(document, window) {
  const poster = document.getElementById('poster');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = Boolean(window.navigator.connection?.saveData);
  let fx;
  let video;

  async function loadMedia() {
    await import('./halftone-fx.js?v=15');
    fx ||= document.createElement('halftone-fx');
    const attributes = {aspect:'16:9',grid:'3',shape:'square',threshold:'50',
      'mark-size':'42','dot-color':'#ff3110',background:'#ffffff',
      brightness:'100',contrast:'45',gamma:'3',dither:'bayer4',paused:''};
    for (const [name,value] of Object.entries(attributes)) fx.setAttribute(name,value);
    fx.setAttribute('aria-hidden','true');
    if (!fx.isConnected) document.body.append(fx);
    // If WebGL is unavailable, the HTML poster remains the complete visual.
    if (!fx.shadowRoot?.querySelector('canvas')) throw new Error('WebGL unavailable');
    video ||= document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    // This loader only runs after poster paint and the visibility/motion gates.
    // Fetch a decodable first frame now; metadata alone can stall loadeddata.
    video.preload = 'auto';
    video.src = './assets/playbox-hero/hero-960.mp4';
    fx.source = video;
    let timeout;
    try {
      await Promise.race([
        fx.whenReady(),
        new Promise((_,reject) => {timeout=window.setTimeout(() => reject(new Error('Media timed out')),15000);}),
      ]);
    } catch (error) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      fx.source = null;
      throw error;
    } finally { window.clearTimeout(timeout); }
    return {
      async play() {
        await video.play();
        fx.play();
        await fx.renderNow();
        document.documentElement.dataset.animationReady = '';
      },
      pause() { video.pause(); fx.pause(); },
    };
  }

  const controller = createPlaybackController({
    load:loadMedia,
    wanted:!reduceMotion.matches && !saveData,
    onError() {
      delete document.documentElement.dataset.animationReady;
    },
  });
  reduceMotion.addEventListener('change',event => {
    if (!event.matches) return;
    controller.update({wanted:false});
    delete document.documentElement.dataset.animationReady;
  });
  document.addEventListener('visibilitychange',() => controller.update({pageVisible:!document.hidden}));
  window.addEventListener('pagehide',() => controller.update({pageVisible:false}));
  window.addEventListener('pageshow',() => controller.update({pageVisible:!document.hidden}));
  if ('IntersectionObserver' in window) {
    const observer = new window.IntersectionObserver(entries => {
      controller.update({visible:entries.some(entry => entry.isIntersecting)});
    });
    observer.observe(document.documentElement);
  } else {
    controller.update({visible:true});
  }

  // Show the lightweight poster before competing for bandwidth or the GPU.
  try { await poster.decode(); } catch {}
  await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  const start = () => controller.update({ready:true,pageVisible:!document.hidden});
  if ('requestIdleCallback' in window) window.requestIdleCallback(start,{timeout:1200});
  else window.setTimeout(start,200);
  return controller;
}

if (typeof document !== 'undefined') mountHero(document,window);
