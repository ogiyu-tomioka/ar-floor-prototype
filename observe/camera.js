(function () {
  'use strict';
  const face = new URLSearchParams(location.search).get('mode') === 'face';
  document.body.dataset.mode = face ? 'face' : 'paper';
  const stage = document.getElementById('stage');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scene = null, paperVisible = false, videoReady = false, descriptorReady = false;
  let poseTimer = 0, yaw = 0, stopped = false;
  const modelRequest = face ? new AbortController() : null;

  function notify(kind, detail) {
    if (stopped) return;
    parent.postMessage({channel:'rbb-observation-camera', kind, detail}, location.origin);
  }

  function preloadScript(file) {
    const preload = document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'script';
    preload.href = file;
    document.head.appendChild(preload);
  }

  function loadScript(file) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = file;
      script.onload = resolve;
      script.onerror = () => reject(Error('ファイルを読み込めませんでした: '+file));
      document.head.appendChild(script);
    });
  }

  function watchStream(video) {
    const stream = video?.srcObject;
    for (const track of stream?.getVideoTracks() || []) {
      const ended = () => notify('error',{error:'CAMERA_ENDED'});
      track.addEventListener('ended', ended, {once:true});
      if (track.readyState === 'ended') ended();
    }
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
      function fitLayers() {
        const {videoWidth, videoHeight} = video;
        if (!videoWidth || !videoHeight) return;
        const viewport = document.documentElement;
        const scale = Math.max(viewport.clientWidth / videoWidth, viewport.clientHeight / videoHeight);
        document.body.style.setProperty('--camera-width', videoWidth * scale + 'px');
        document.body.style.setProperty('--camera-height', videoHeight * scale + 'px');
      }
      fitLayers();
      video.addEventListener('loadedmetadata', fitLayers);
      video.addEventListener('resize', fitLayers);
      window.addEventListener('resize', fitLayers);
      watchStream(video);
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

  function configureFace(fragment) {
    buildMonster(fragment.querySelector('#shoulder-monster'));
    buildMonster(fragment.querySelector('#head-monster'));
    AFRAME.registerComponent('rbb-companion',{
      init() {
        this.shoulder=this.el.querySelector('#shoulder-monster').object3D;
        this.head=this.el.querySelector('#head-monster').object3D;
        this.point=new AFRAME.THREE.Vector3();
        this.samples=[[-.15,.04],[.15,.04],[0,.49]];
        this.next=0;
        this.atShoulder=true;
      },
      tick(clock) {
        if(clock<this.next||!this.el.camera||!this.shoulder.parent.visible)return;
        this.next=clock+100;
        const rect=this.el.getBoundingClientRect();
        const width=document.documentElement.clientWidth;
        const height=document.documentElement.clientHeight;
        const margin=this.atShoulder?10:24;
        this.atShoulder=this.samples.every(([x,y])=>{
          this.point.set(x,y,0);
          this.shoulder.localToWorld(this.point).project(this.el.camera);
          const px=rect.left+(this.point.x+1)*rect.width/2;
          const py=rect.top+(1-this.point.y)*rect.height/2;
          return this.point.z>=-1&&this.point.z<=1&&px>margin&&px<width-margin&&py>65+margin&&py<height-115-margin;
        });
        this.shoulder.visible=this.atShoulder;
        this.head.visible=!this.atShoulder;
      },
    });
    scene.addEventListener('rbbFaceVideo', () => {
      watchStream(stage.querySelector('video'));
      notify('video');
    });
    scene.addEventListener('arReady', () => notify('scanning'));
    scene.addEventListener('arError', event => notify('error',event.detail));
    scene.addEventListener('targetFound', () => notify('found'));
    scene.addEventListener('targetLost', () => notify('lost'));
  }

  function stopStreams() {
    stopped = true;
    clearTimeout(poseTimer);
    modelRequest?.abort();
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
  stage.addEventListener('webglcontextlost', () => notify('error',{error:'WEBGL_CONTEXT_LOST'}), true);
  window.addEventListener('unhandledrejection', event =>
    notify('error',{error:'RUNTIME',detail:String(event.reason?.message||event.reason||'')}));

  async function init() {
    try {
      const trackingScript = face?'vendor/mindar-face-aframe.prod.js?v=1.2.5-rbb3':'vendor/aframe-ar-nft.js?v=3.4.8-rbb2';
      preloadScript(trackingScript);
      if (face) {
        // The tracker consumes the same request once its script and the scene have loaded.
        const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
        window.rbbFaceModel = fetch(modelUrl,{signal:modelRequest.signal}).then(async response => {
          if (!response.ok) throw Error('顔追跡モデル HTTP '+response.status);
          const model = await response.arrayBuffer();
          notify('progress',{stage:'face-model-ready'});
          return model;
        });
        window.rbbFaceModel.catch(error => notify('error',{error:'FACE_INIT',detail:String(error)}));
      }
      await loadScript('vendor/aframe.min.js?v=1.6.0');
      notify('progress',{stage:'aframe-ready'});
      if (stopped) return;
      await loadScript(trackingScript);
      if (stopped) return;
      notify('progress',{stage:'tracker-script-ready'});
      const fragment = document.getElementById(face?'face-scene':'paper-scene').content.cloneNode(true);
      scene = fragment.querySelector('a-scene');
      if (face) configureFace(fragment);
      else configurePaper(fragment);
      stage.appendChild(fragment);
    } catch (error) {
      notify('error',{error:'LOAD',detail:String(error?.message||error||'')});
    }
  }
  init();
}());
