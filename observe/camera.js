(function () {
  'use strict';
  const face = new URLSearchParams(location.search).get('mode') === 'face';
  const revision = '0.3.25';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scene = null, paperVisible = false, videoReady = false, descriptorReady = false;
  let poseTimer = 0, yaw = 0;

  function notify(kind) {
    parent.postMessage({channel:'rbb-observation-camera', kind}, location.origin);
  }

  function loadScript(file) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = file;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function buildMonster(rig) {
    // The dimensions follow the sphere parts of the Unity Monster prefab.
    const parts = [
      ['0 .23 0',       '.30 .36 .26',    '#33ba98'],
      ['0 .39 .01',     '.24 .20 .23',    '#43c5a2'],
      ['-.075 .475 0',  '.04 .025 .04',   '#43c5a2'],
      ['.075 .475 0',   '.04 .025 .04',   '#43c5a2'],
      ['-.08 .04 .03',  '.11 .08 .16',    '#23947c'],
      ['.08 .04 .03',   '.11 .08 .16',    '#23947c'],
      ['-.052 .4 .112', '.052 .06 .026',  '#f8fff0'],
      ['.052 .4 .112',  '.052 .06 .026',  '#f8fff0'],
      ['-.052 .4 .126', '.024 .032 .012', '#172737'],
      ['.052 .4 .126',  '.024 .032 .012', '#172737'],
    ];
    for (const [position, scale, color] of parts) {
      const part = document.createElement('a-sphere');
      part.setAttribute('radius', '.5');
      part.setAttribute('segments-width', '20');
      part.setAttribute('segments-height', '14');
      part.setAttribute('position', position);
      part.setAttribute('scale', scale);
      part.setAttribute('color', color);
      rig.appendChild(part);
    }
  }

  function configurePaper(fragment) {
    const anchor = fragment.querySelector('#paper-anchor');
    const center = fragment.querySelector('#paper-center');
    const rig = fragment.querySelector('#monster-rig');
    const heading = fragment.querySelector('#monster-heading');
    const cameraData = new URL('../external/marker/camera_para.dat',location.href).href;
    const descriptor = new URL('targets/rbb-monster-observation-01',location.href).href;
    scene.setAttribute('arjs','sourceType:webcam; debugUIEnabled:false; sourceWidth:640; sourceHeight:480; maxDetectionRate:30; cameraParametersUrl:'+cameraData);
    anchor.setAttribute('url',descriptor);
    buildMonster(rig);

    const ready = () => { if (descriptorReady && videoReady && !paperVisible) notify('scanning'); };
    window.addEventListener('arjs-video-loaded', event => {
      const video = event.detail && event.detail.component;
      if (!video) return;
      video.muted = true;
      video.play().catch(() => {});
      videoReady = true;
      ready();
    },{once:true});
    window.addEventListener('arjs-nft-loaded', () => {
      descriptorReady = true;
      ready();
    },{once:true});
    window.addEventListener('arjs-nft-init-data', event => {
      const {width,height,dpi} = event.detail || {};
      if (![width,height,dpi].every(value => Number.isFinite(value) && value > 0)) return;
      const mmPerPixel = 25.4 / dpi;
      center.setAttribute('position', (width*mmPerPixel/2)+' 0 '+(-height*mmPerPixel/2));
    });
    window.addEventListener('camera-error', () => notify('error'),{once:true});
    anchor.addEventListener('markerFound', () => { paperVisible = true; notify('found'); });
    anchor.addEventListener('markerLost', () => { paperVisible = false; notify('lost'); });

    window.addEventListener('message', event => {
      const message = event.data;
      if (event.source !== parent || event.origin !== location.origin || !paperVisible ||
          !message || message.channel !== 'rbb-observation-controls') return;
      if (message.action === 'turn') {
        const next = yaw + 90;
        if (reducedMotion) heading.setAttribute('rotation','0 '+next+' 0');
        else heading.setAttribute('animation__turn','property:rotation; from:0 '+yaw+' 0; to:0 '+next+' 0; dur:310; easing:easeOutQuad');
        yaw = next;
      } else if (message.action === 'defend') {
        clearTimeout(poseTimer);
        if (reducedMotion) {
          rig.setAttribute('scale','105 68 105');
          poseTimer = setTimeout(() => rig.setAttribute('scale','95 95 95'),850);
        } else {
          rig.removeAttribute('animation__defense');
          rig.setAttribute('animation__defense','property:scale; from:95 95 95; to:105 68 105; dir:alternate; loop:2; dur:290; easing:easeInOutQuad');
        }
      }
    });
  }

  function configureFace() {
    scene.addEventListener('arReady', () => notify('scanning'));
    scene.addEventListener('arError', () => notify('error'));
    scene.addEventListener('targetFound', () => notify('found'));
    scene.addEventListener('targetLost', () => notify('lost'));
  }

  function stopStreams() {
    if (scene && face) {
      const system = scene.systems && scene.systems['mindar-face-system'];
      if (system && system.video && system.video.srcObject) {
        try { system.stop(); } catch (_) { /* Page removal releases remaining resources. */ }
      }
    }
    document.querySelectorAll('video').forEach(video => {
      if (video.srcObject && video.srcObject.getTracks) video.srcObject.getTracks().forEach(track => track.stop());
    });
  }
  window.addEventListener('pagehide', stopStreams);
  window.addEventListener('unhandledrejection', () => notify('error'));

  async function init() {
    try {
      await loadScript('vendor/aframe.min.js?v=1.6.0');
      await loadScript(face?'vendor/mindar-face-aframe.prod.js?v=1.2.5':'vendor/aframe-ar-nft.js?v=3.4.8');
      const fragment = document.getElementById(face?'face-scene':'paper-scene').content.cloneNode(true);
      scene = fragment.querySelector('a-scene');
      if (face) configureFace();
      else configurePaper(fragment);
      document.getElementById('stage').appendChild(fragment);
    } catch (_) {
      notify('error');
    }
  }
  init();
}());
