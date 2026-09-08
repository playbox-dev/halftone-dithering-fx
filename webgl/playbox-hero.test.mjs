import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPlaybackController, mountHero} from './playbox-hero.mjs';

test('mounts without a playback button and respects reduced motion',async() => {
  const poster = {decode:async() => {}};
  const document = {
    getElementById:id => id === 'poster' ? poster : null,
    documentElement:{dataset:{}},
    hidden:false,
    addEventListener() {},
  };
  const window = {
    navigator:{},
    matchMedia:() => ({matches:true,addEventListener() {}}),
    addEventListener() {},
    requestAnimationFrame:callback => callback(),
    requestIdleCallback:callback => callback(),
    IntersectionObserver:class {
      constructor(callback) {this.callback = callback;}
      observe() {this.callback([{isIntersecting:true}]);}
    },
  };
  const controller = await mountHero(document,window);
  assert.deepEqual(controller.getState(),{
    wanted:false,visible:true,pageVisible:true,ready:true,
  });
  assert.equal(document.documentElement.dataset.animationReady,undefined);
});

function fixture(options = {}) {
  const calls = {loads:0,plays:0,pauses:0};
  const media = {play:async() => {calls.plays++;},pause:() => {calls.pauses++;}};
  const controller = createPlaybackController({load:async() => {calls.loads++;return media;},...options});
  return {calls,media,controller};
}
const eligible = {visible:true,pageVisible:true,ready:true};
const defer = () => {
  let resolve,reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
};

test('reduced motion or save-data initial state does not load video',async() => {
  const {calls,controller} = fixture({wanted:false});
  await controller.update(eligible);
  assert.equal(calls.loads,0);
  await controller.update({wanted:true});
  assert.equal(calls.loads,1);
  assert.equal(calls.plays,1);
});

test('waits for poster readiness and intersection before loading',async() => {
  const {calls,controller} = fixture();
  await controller.update({ready:true});
  assert.equal(calls.loads,0);
  await controller.update({visible:true});
  assert.equal(calls.loads,1);
});

test('offscreen and hidden-tab states pause actual video and resume without reloading',async() => {
  const {calls,controller} = fixture();
  await controller.update(eligible);
  await controller.update({visible:false});
  assert.equal(calls.pauses,1);
  await controller.update({visible:true});
  await controller.update({pageVisible:false});
  assert.equal(calls.pauses,2);
  await controller.update({pageVisible:true});
  assert.equal(calls.loads,1);
  assert.equal(calls.plays,3);
});

test('explicit pause persists when scrolling back or returning to tab',async() => {
  const {calls,controller} = fixture();
  await controller.update(eligible);
  await controller.update({wanted:false});
  await controller.update({visible:false,pageVisible:false});
  await controller.update({visible:true,pageVisible:true});
  assert.equal(calls.plays,1);
  assert.equal(controller.getState().wanted,false);
});

test('scrolling away during async loading cannot start background playback',async() => {
  const loading = defer();
  const {controller,media,calls} = fixture({load:() => loading.promise});
  const starting = controller.update(eligible);
  await controller.update({visible:false});
  loading.resolve(media);
  await starting;
  assert.equal(calls.plays,0);
  assert.equal(calls.pauses,1);
});

test('pause during pending play is re-applied after the browser resolves play',async() => {
  const playing = defer();
  const {controller,media,calls} = fixture();
  media.play = () => playing.promise;
  const starting = controller.update(eligible);
  await new Promise(resolve => setImmediate(resolve));
  await controller.update({wanted:false});
  playing.resolve();
  await starting;
  assert.equal(calls.pauses,2);
});

test('failed media load leaves a stopped state and can be retried',async() => {
  let attempts = 0, errors = 0;
  const {controller,media,calls} = fixture({
    load:async() => {if (++attempts === 1) throw new Error('network');return media;},
    onError:() => {errors++;},
  });
  await controller.update(eligible);
  assert.equal(controller.getState().wanted,false);
  assert.equal(errors,1);
  await controller.update({wanted:true});
  assert.equal(attempts,2);
  assert.equal(calls.plays,1);
});

test('a cancelled rejected load does not poison the next request',async() => {
  const loading = defer();
  let attempts = 0;
  const {controller,media,calls} = fixture({load:() => ++attempts === 1 ? loading.promise : media});
  const starting = controller.update(eligible);
  await new Promise(resolve => setImmediate(resolve));
  await controller.update({visible:false});
  loading.reject(new Error('network'));
  await starting;
  await controller.update({visible:true});
  assert.equal(attempts,2);
  assert.equal(calls.plays,1);
});
