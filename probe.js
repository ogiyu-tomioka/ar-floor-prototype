/* MIT License. Project code only; the XR Engine has its separate bundled license. */
(function () {
  'use strict';
  const revision = '0.3.1';
  const budgetArLoop = new URLSearchParams(location.search).get('xrloop') !== 'engine';
  const poseGuard = window.RollPoseGuard ? RollPoseGuard() : null;
  let arLoopId = 0, nextArFrame = 0, lastGuardEvent = 0, lastOrientationSample = 0;
  let deviceOrientation = null;
  const arBudget = {mode:budgetArLoop?'budget':'engine',targetFps:30,frames:0,measuredFps:0,windowFrames:0,windowStart:0};
  let tableEstimator = null;
  const recognitionLoadMode = new URLSearchParams(location.search).get('load') === 'baseline' ? 'baseline' : 'reduced';
  // SDK absolute mode estimates y=0 as ground; this is not a detected plane mesh.
  const groundSettings = {planeHeight: 0, screenX: 0.5, screenY: 0.5,
    minimumCameraHeight: 0.15, normalSeconds: 1, allowPlacementWhileMoving: true};
  const ui = {};
  ['start', 'place', 'replace', 'recenter', 'stop', 'status', 'phase', 'guidance',
    'progress', 'loading', 'metrics', 'download', 'dimensions', 'reticle', 'coaching'].forEach(function (id) {
    ui[id] = document.getElementById(id);
  });
  const canvas = document.getElementById('camera-canvas');
  const frame = new Float32Array(38);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1);
  const events = [];
  const viewHistory = [];
  let unityGl = null;
  const alphaContexts = new WeakSet();
  const unityAlpha = {enabled: true, installed: false, clearCalls: 0, alphaOnlyOpaqueClears: 0,
    preventedClears: 0, preventedDefaultClears: 0, preventedOffscreenClears: 0,
    preventedClearBufferCalls: 0, lastTarget: '', lastClearAlpha: null, error: ''};
  let xrGl = null;
  let latestCameraFrame = null;
  let manualRenderer = null;
  const cameraOnly = document.createElement('button');
  cameraOnly.textContent = 'カメラ映像だけ表示';
  cameraOnly.disabled = true;
  const redraw = document.createElement('button');
  redraw.textContent = '映像の再描画を試す';
  redraw.disabled = true;
  const feedControls = document.createElement('div');
  feedControls.className = 'feed-controls';
  feedControls.append(cameraOnly, redraw);
  document.getElementById('diagnostics').appendChild(feedControls);
  const feedNote = document.createElement('p');
  feedNote.className = 'note';
  feedNote.textContent = 'キャラの画面だけを隠して、下にある現実の映像を確認できます。配置は消しません。';
  feedControls.after(feedNote);
  const displayCheck = document.createElement('button');
  displayCheck.textContent = '平面推定を使わず表示だけ確認';
  displayCheck.disabled = true;
  document.getElementById('diagnostics').appendChild(displayCheck);
  const displayNote = document.createElement('p');
  displayNote.className = 'note';
  displayNote.textContent = 'このボタンはカメラの前にステージを仮置きします。机の認識・自動配置の確認にはなりません。';
  document.getElementById('diagnostics').appendChild(displayNote);
  document.querySelector('.eyebrow').textContent = 'Roll-by-Blow · ' + revision;
  ui.place.textContent = '自動配置を待っています';
  ui.reticle.style.left = groundSettings.screenX * 100 + '%';
  ui.reticle.style.top = groundSettings.screenY * 100 + '%';
  const state = {
    phase: 'loading', engineReady: false, unity: null, registered: false, modulesAdded: false,
    config: null, latest: null, lastPoseAt: 0, sequence: 0, normalSince: 0,
    recognition: null, recognitionHistory: [], motionPermission: [], placementHistory: [],
    candidate: null, stableOrigin: null, stableMean: null, stableCount: 0,
    stableSince: 0, lastHitAt: 0, lastHitCheck: 0,
    placed: false, pendingAt: 0, startedAt: 0, lastReport: null, firstNormalAt: 0,
    lastTracking: '', hitType: '', error: '', viewportWidth: 0, viewportHeight: 0,
    placementMode: 'table-estimate', displayRequest: false, cameraOnly: false, manualBackground: false,
    cameraFeed: {gpuFrames: 0, renderCallbacks: 0, freshVideoFrames: 0,
      texturePresent: false, textureContextMatches: null,
      textureWidth: 0, textureHeight: 0, videoWidth: 0, videoHeight: 0,
      videoTime: null, repeatFrame: null, viewport: null, canvasMatches: null,
      manualDraws: 0, manualError: ''},
    surface: {method: 'unused', reason: 'ground-estimate-mode-does-not-use-hitTest'},
    ground: {source: 'sdk-absolute-y0-plane', planeY: groundSettings.planeHeight,
      cycles: 0, accepted: 0, rejected: {}, reason: 'not-started', ray: null,
      intersection: null, distance: null, cameraHeight: null, stableSeconds: 0,
      lastReason: '', lastEventAt: 0, atPlacement: null}
  };
  const now = function () { return performance.now(); };
  const finite = function (value) { return typeof value === 'number' && Number.isFinite(value); };
  const pointValid = function (p) { return p && finite(p.x) && finite(p.y) && finite(p.z); };
  const quatValid = function (q) { return q && pointValid(q) && finite(q.w); };
  const distance = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); };
  const copyPoint = function (p) { return {x: p.x, y: p.y, z: p.z}; };

  function record(kind, detail) {
    events.push({time: new Date().toISOString(), kind: kind, detail: detail});
    if (events.length > 120) events.shift();
  }

  function message(text, guidance) {
    ui.status.textContent = text;
    if (guidance) ui.guidance.textContent = guidance;
  }

  function fail(text, error) {
    state.error = text + (error ? ' ' + String(error.message || error) : '');
    state.phase = 'error';
    stopArLoop();
    frame[1] = 0;
    frame[2] = 0;
    frame[35] = 0;
    state.candidate = null;
    try { if (window.XR8 && state.modulesAdded) XR8.stop(); } catch (_) { /* Keep the original failure. */ }
    record('error', state.error);
    message(text, '「診断を保存」で状況を残せます。再読み込みしてやり直してください。');
    ui.start.hidden = false;
    ui.start.textContent = '再読み込み';
    ui.start.disabled = false;
    updateUi();
  }

  function send(method, argument) {
    if (!state.unity || !state.registered) return;
    if (argument === undefined) state.unity.SendMessage('FloorProbe', method);
    else state.unity.SendMessage('FloorProbe', method, argument);
  }

  function useArCamera() {
    // The original 0.1.0 player has no diagnostic modes. 0.1.2 does.
    if (state.config && state.config.playerRevision === '0.1.2') send('SetRenderMode', 'ar');
  }

  function configureUnityBudget() {
    // Defer the call until Unity's registration callback has returned.
    setTimeout(function () {
      if (state.unity && state.registered && state.config.supportsRecognitionBudget)
        send('SetRecognitionLoad', recognitionLoadMode);
    }, 0);
  }

  function describeContext(gl) {
    if (!gl) return null;
    try {
      return {attributes: gl.getContextAttributes(), lost: gl.isContextLost(),
        drawingBufferWidth: gl.drawingBufferWidth, drawingBufferHeight: gl.drawingBufferHeight};
    } catch (error) { return {error: String(error)}; }
  }

  function installUnityAlphaGuard(gl) {
    if (alphaContexts.has(gl)) return;
    alphaContexts.add(gl);
    try {
      const initialMask = gl.getParameter(gl.COLOR_WRITEMASK);
      let alphaOnlyWrites = !initialMask[0] && !initialMask[1] && !initialMask[2] && initialMask[3];
      const originalColorMask = gl.colorMask;
      const originalClear = gl.clear;
      gl.colorMask = function (r, g, b, a) {
        originalColorMask.call(gl, r, g, b, a);
        alphaOnlyWrites = !r && !g && !b && !!a;
      };
      function preventOpaqueAlpha(alpha) {
        if (!alphaOnlyWrites || !Number.isFinite(alpha) || alpha < 1) return false;
        unityAlpha.alphaOnlyOpaqueClears++;
        unityAlpha.lastClearAlpha = alpha;
        if (!unityAlpha.enabled) return false;
        const offscreen = gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null;
        unityAlpha.lastTarget = offscreen ? 'offscreen' : 'canvas';
        unityAlpha.preventedClears++;
        if (offscreen) unityAlpha.preventedOffscreenClears++;
        else unityAlpha.preventedDefaultClears++;
        return true;
      }
      gl.clear = function (mask) {
        unityAlpha.clearCalls++;
        if ((mask & gl.COLOR_BUFFER_BIT) && alphaOnlyWrites
            && preventOpaqueAlpha(gl.getParameter(gl.COLOR_CLEAR_VALUE)[3])) {
          // Keep depth/stencil clearing, and leave all existing color/alpha pixels intact.
          const remaining = mask & ~gl.COLOR_BUFFER_BIT;
          if (remaining) originalClear.call(gl, remaining);
          return;
        }
        originalClear.call(gl, mask);
      };
      if (typeof gl.clearBufferfv === 'function') {
        const originalClearBuffer = gl.clearBufferfv;
        gl.clearBufferfv = function (buffer, drawbuffer, values, srcOffset) {
          if (buffer === gl.COLOR && values && values.length >= (srcOffset || 0) + 4
              && preventOpaqueAlpha(values[(srcOffset || 0) + 3])) {
            unityAlpha.preventedClearBufferCalls++;
            return;
          }
          return originalClearBuffer.apply(gl, arguments);
        };
      }
      unityAlpha.installed = true;
      record('unity-alpha-guard', 'Skip opaque alpha-only clears on this Unity context only.');
    } catch (error) {
      unityAlpha.error = String(error.message || error);
      record('unity-alpha-guard-error', unityAlpha.error);
    }
  }

  function browserRendering() {
    const layers = Array.from(document.querySelectorAll('canvas')).map(function (element) {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {id: element.id, width: element.width, height: element.height,
        rect: {x: box.x, y: box.y, width: box.width, height: box.height},
        position: style.position, zIndex: style.zIndex, display: style.display,
        visibility: style.visibility, opacity: style.opacity, background: style.backgroundColor,
        transform: style.transform};
    });
    return {layers: layers, xrContext: describeContext(xrGl), unityContext: describeContext(unityGl),
      unityAlpha: Object.assign({}, unityAlpha),
      sameContext: !!(xrGl && unityGl && xrGl === unityGl)};
  }

  function saveView(reason) {
    viewHistory.push({time: new Date().toISOString(), reason: reason,
      poseGuard: poseGuard ? poseGuard.snapshot() : null, deviceOrientation:deviceOrientation, arBudget:arBudget,
      cameraOnly: state.cameraOnly, manualBackground: state.manualBackground,
      cameraFeed: Object.assign({}, state.cameraFeed), browserRendering: browserRendering(),
      unity: state.lastReport});
    if (viewHistory.length > 12) viewHistory.shift();
  }

  function scheduleView(reason) {
    const requestedView = state.cameraOnly, requestedRedraw = state.manualBackground;
    setTimeout(function () {
      if (state.phase === 'running' && requestedView === state.cameraOnly
          && requestedRedraw === state.manualBackground) saveView(reason);
    }, 2000);
  }

  function destroyManualRenderer() {
    if (manualRenderer) {
      try { manualRenderer.destroy(); } catch (error) { record('renderer-cleanup', String(error)); }
    }
    manualRenderer = null;
    latestCameraFrame = null;
  }

  function inspectCameraFrame(result) {
    const cameraFrame = result.frameStartResult;
    if (!cameraFrame) return;
    latestCameraFrame = cameraFrame;
    const stats = state.cameraFeed;
    stats.gpuFrames++;
    stats.texturePresent = !!cameraFrame.cameraTexture;
    stats.textureContextMatches = cameraFrame.GLctx === xrGl;
    stats.textureWidth = cameraFrame.textureWidth;
    stats.textureHeight = cameraFrame.textureHeight;
    stats.repeatFrame = !!cameraFrame.repeatFrame;
    if (cameraFrame.videoTime !== stats.videoTime) stats.freshVideoFrames++;
    stats.videoTime = cameraFrame.videoTime;
  }

  function drawCameraFrame(force) {
    state.cameraFeed.renderCallbacks++;
    if ((!state.manualBackground && force !== true) || !xrGl || !latestCameraFrame
        || !latestCameraFrame.cameraTexture || state.cameraFeed.manualError || xrGl.isContextLost()) return;
    let restore;
    try {
      restore = XR8.GlTextureRenderer.getGLctxParameters(xrGl, [xrGl.TEXTURE0]);
      if (latestCameraFrame.GLctx !== xrGl) throw new Error('Camera texture uses a different WebGL context.');
      if (!manualRenderer) manualRenderer = XR8.GlTextureRenderer.create({GLctx: xrGl});
      const sdkViewport = state.cameraFeed.viewport;
      const viewport = sdkViewport && finite(sdkViewport.width) && sdkViewport.width > 0
        && finite(sdkViewport.height) && sdkViewport.height > 0 ? sdkViewport : XR8.GlTextureRenderer.fillTextureViewport(
        latestCameraFrame.textureWidth, latestCameraFrame.textureHeight,
        xrGl.drawingBufferWidth, xrGl.drawingBufferHeight);
      state.cameraFeed.manualViewport = viewport;
      manualRenderer.render({renderTexture: latestCameraFrame.cameraTexture, viewport: viewport});
      state.cameraFeed.manualDraws++;
    } catch (error) {
      state.cameraFeed.manualError = String(error.message || error);
      record('camera-redraw-error', state.cameraFeed.manualError);
    } finally {
      if (restore) {
        try { XR8.GlTextureRenderer.setGLctxParameters(xrGl, restore); }
        catch (error) { state.cameraFeed.manualError = String(error.message || error); }
      }
    }
  }

  function resetCandidate() {
    state.candidate = null;
    state.stableOrigin = null;
    state.stableMean = null;
    state.stableCount = 0;
    state.stableSince = 0;
    state.lastHitAt = 0;
    state.hitType = '';
    state.ground.stableSeconds = 0;
    frame[26] = 0;
    frame[35] = 0;
  }

  function clearPlacement() {
    state.placed = false;
    state.pendingAt = 0;
    state.placementMode = 'table-estimate';
    state.ground.reason = 'not-started';
    state.ground.atPlacement = null;
    state.displayRequest = false;
    send('ClearPlacement');
    resetCandidate();
    if (tableEstimator) tableEstimator.reset();
    if (poseGuard) poseGuard.reset();
    configureWorldPoints(true);
  }

  function setProjection(width, height) {
    if (!width || !height) return;
    const options = {cam: {pixelRectWidth: width, pixelRectHeight: height, nearClipPlane: 0.05, farClipPlane: 30}};
    // Keep the same starting reference; a viewport change must not recenter the world.
    options.origin = {x:0,y:1.5,z:0}; options.facing = {x:0,y:0,z:0,w:1};
    XR8.XrController.updateCameraProjectionMatrix(options);
  }

  function resizeCanvas() {
    const rectangle = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rectangle.width * pixelRatio));
    const height = Math.max(1, Math.round(rectangle.height * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function trackingNormal(reality) {
    return reality.trackingStatus === 'NORMAL' && reality.trackingReason !== 'INITIALIZING';
  }

  function beginRecognition(reason) {
    if (state.recognition) {
      state.recognitionHistory.push(state.recognition);
      if (state.recognitionHistory.length > 4) state.recognitionHistory.shift();
    }
    const clock = now();
    state.startedAt = clock;
    state.firstNormalAt = 0;
    state.normalSince = 0;
    state.latest = null;
    state.lastPoseAt = 0;
    state.lastTracking = '';
    state.recognition = {reason: reason, startedAt: new Date().toISOString(),
      startedClock: clock, updates: 0, invalidPoses: 0, trackingCounts: {},
      loadMode: recognitionLoadMode, firstReadySeconds: null,
      firstPoseSeconds: null, firstNormalSeconds: null, firstSample: null,
      firstNormalSample: null, samples: [], lastSampleClock: 0,
      sdkCoaching: 'not-received', motion: {events: 0, lastEventSeconds: null,
        maxRotationRate: null, maxAcceleration: null}};
    record('recognition-start', {reason: reason});
  }

  function observeRecognition(reality, poseValid, clock) {
    const stats = state.recognition;
    if (!stats) return;
    stats.updates++;
    if (!poseValid) stats.invalidPoses++;
    const elapsed = (clock - stats.startedClock) / 1000;
    const status = reality ? String(reality.trackingStatus) + '/' + String(reality.trackingReason) : 'no-reality';
    stats.trackingCounts[status] = (stats.trackingCounts[status] || 0) + 1;
    if (poseValid && stats.firstPoseSeconds === null) stats.firstPoseSeconds = elapsed;
    const firstNormal = poseValid && trackingNormal(reality) && stats.firstNormalSeconds === null;
    if (firstNormal) stats.firstNormalSeconds = elapsed;
    if (!firstNormal && stats.lastSampleClock && clock - stats.lastSampleClock < 750) return;
    stats.lastSampleClock = clock;
    const ray = poseValid ? screenRay(reality) : null;
    const height = poseValid ? reality.position.y - groundSettings.planeHeight : null;
    const sample = {seconds: elapsed, tracking: status, poseValid: poseValid,
      sdkCamera: poseValid ? copyPoint(reality.position) : null,
      sdkHeight: height,
      aimDownDegrees: ray ? Math.asin(Math.max(-1, Math.min(1, -ray.y))) * 180 / Math.PI : null,
      estimatedGroundDistance: ray && ray.y < -1e-5 && height > 0 ? -height / ray.y : null,
      motionEvents: stats.motion.events,
      unityUpdateFps: state.lastReport ? state.lastReport.fps : null,
      unityTargetFrameRate: state.lastReport ? state.lastReport.targetFrameRate : null,
      unityVSyncCount: state.lastReport ? state.lastReport.vSyncCount : null,
      rotation: poseValid ? Object.assign({},reality.rotation) : null,
      deviceOrientation:deviceOrientation,poseGuard:poseGuard ? poseGuard.snapshot().reason : 'missing'};
    if (!stats.firstSample) stats.firstSample = sample;
    if (firstNormal) {
      stats.firstNormalSample = sample;
      record('recognition-normal', sample);
    }
    stats.samples.push(sample);
    if (stats.samples.length > 120) stats.samples.shift();
  }

  function sdkCoaching(value) {
    if (state.recognition) state.recognition.sdkCoaching = value;
    record('sdk-coaching', value);
  }

  window.addEventListener('devicemotion', function (event) {
    if (state.phase !== 'running' || !state.recognition) return;
    const motion = state.recognition.motion;
    motion.events++;
    motion.lastEventSeconds = (now() - state.recognition.startedClock) / 1000;
    const rotation = event.rotationRate;
    if (rotation && finite(rotation.alpha) && finite(rotation.beta) && finite(rotation.gamma)) {
      const rate = Math.hypot(rotation.alpha, rotation.beta, rotation.gamma);
      motion.maxRotationRate = Math.max(motion.maxRotationRate || 0, rate);
    }
    const acceleration = event.acceleration;
    if (pointValid(acceleration)) {
      const amount = Math.hypot(acceleration.x, acceleration.y, acceleration.z);
      motion.maxAcceleration = Math.max(motion.maxAcceleration || 0, amount);
    }
  }, {passive: true});

  function groundReason(reason, clock) {
    state.ground.reason = reason;
    if (reason !== state.ground.lastReason && clock - state.ground.lastEventAt >= 2000) {
      record('ground-estimate', {reason: reason, source: state.ground.source,
        planeY: groundSettings.planeHeight, cameraHeight: state.ground.cameraHeight,
        ray: state.ground.ray, intersection: state.ground.intersection,
        distance: state.ground.distance, stableSeconds: state.ground.stableSeconds});
      state.ground.lastReason = reason;
      state.ground.lastEventAt = clock;
    }
  }

  function inverseProjection(matrix) {
    const rows = [];
    for (let row = 0; row < 4; row++) {
      rows[row] = [];
      for (let column = 0; column < 4; column++) rows[row][column] = matrix[column * 4 + row];
      for (let column = 0; column < 4; column++) rows[row][column + 4] = row === column ? 1 : 0;
    }
    for (let column = 0; column < 4; column++) {
      let pivot = column;
      for (let row = column + 1; row < 4; row++)
        if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
      if (Math.abs(rows[pivot][column]) < 1e-10) return null;
      const swap = rows[column]; rows[column] = rows[pivot]; rows[pivot] = swap;
      const divisor = rows[column][column];
      for (let i = 0; i < 8; i++) rows[column][i] /= divisor;
      for (let row = 0; row < 4; row++) {
        if (row === column) continue;
        const factor = rows[row][column];
        for (let i = 0; i < 8; i++) rows[row][i] -= factor * rows[column][i];
      }
    }
    return rows.map(function (row) { return row.slice(4); });
  }

  function screenRay(reality) {
    const inverse = inverseProjection(reality.intrinsics);
    if (!inverse) return null;
    // OpenGL NDC has +Y up; UI coordinates have +Y down. Unproject the near plane.
    const clip = [groundSettings.screenX * 2 - 1, 1 - groundSettings.screenY * 2, -1, 1];
    const cameraPoint = inverse.map(function (row) {
      return row.reduce(function (sum, value, index) { return sum + value * clip[index]; }, 0);
    });
    if (Math.abs(cameraPoint[3]) < 1e-10) return null;
    let vx = cameraPoint[0] / cameraPoint[3], vy = cameraPoint[1] / cameraPoint[3];
    let vz = cameraPoint[2] / cameraPoint[3];
    const length = Math.hypot(vx, vy, vz);
    const q = reality.rotation;
    const qLength = Math.hypot(q.x, q.y, q.z, q.w);
    if (length < 1e-10 || qLength < 1e-10) return null;
    vx /= length; vy /= length; vz /= length;
    const x = q.x / qLength, y = q.y / qLength, z = q.z / qLength, w = q.w / qLength;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    const direction = {x: vx + w * tx + y * tz - z * ty,
      y: vy + w * ty + z * tx - x * tz, z: vz + w * tz + x * ty - y * tx};
    return pointValid(direction) ? direction : null;
  }

  function configureWorldPoints(enabled) {
    if (!state.modulesAdded || !window.XR8) return;
    try { XR8.XrController.configure({enableWorldPoints: enabled}); }
    catch (error) { record('world-points-config', String(error)); }
  }

  function updateCandidate(reality, clock) {
    if (!tableEstimator || clock - state.lastHitCheck < 250) return;
    state.lastHitCheck = clock;
    const fit = tableEstimator.observe(reality, clock);
    state.surface = tableEstimator.snapshot();
    resetCandidate();
    if (!fit) return;
    state.candidate = fit;
    state.lastHitAt = clock;
    state.hitType = fit.type;
    frame[26] = 1;
    frame[27] = fit.position.x; frame[28] = fit.position.y; frame[29] = fit.position.z;
    frame[30] = 0; frame[31] = 0; frame[32] = 0; frame[33] = 1;
    frame[34] = fit.distance;
    frame[35] = fit.ready && clock - state.normalSince >= 1000 ? 1 : 0;
    if (frame[35] > .5 && !state.pendingAt && !state.placed && !state.cameraOnly) {
      if (state.recognition && state.recognition.firstReadySeconds === null)
        state.recognition.firstReadySeconds = (clock - state.recognition.startedClock) / 1000;
      state.placementMode = 'table-estimate';
      state.ground.atPlacement = state.surface;
      state.pendingAt = clock;
      send('PlaceFromBrowser', JSON.stringify({position:fit.position,sizeMeters:fit.sizeMeters,facing:fit.facing}));
      record('auto-place-request', {position:fit.position,sizeMeters:fit.sizeMeters,surface:state.surface});
    }
  }

  function stopArLoop() {
    if (arLoopId) cancelAnimationFrame(arLoopId);
    arLoopId = 0; nextArFrame = 0;
  }
  function startArLoop() {
    if (!budgetArLoop || arLoopId) return;
    arBudget.windowFrames = 0; arBudget.windowStart = 0;
    function tick(clock) {
      arLoopId = 0;
      if (state.phase !== 'running' || document.hidden) return;
      const period = 1000 / arBudget.targetFps;
      if (!nextArFrame || clock + .25 >= nextArFrame) {
        nextArFrame = clock + period - (nextArFrame ? Math.max(0,clock-nextArFrame)%period : 0);
        try {
          XR8.runPreRender(Date.now());
          try {
            drawCameraFrame(true);
            if (state.cameraFeed.manualError) throw new Error(state.cameraFeed.manualError);
          }
          finally { XR8.runPostRender(); }
          arBudget.frames++; arBudget.windowFrames++;
          if (!arBudget.windowStart) arBudget.windowStart = clock;
          if (clock - arBudget.windowStart >= 1000) {
            arBudget.measuredFps = arBudget.windowFrames * 1000 / (clock-arBudget.windowStart);
            arBudget.windowFrames = 0; arBudget.windowStart = clock;
          }
        } catch (error) { fail('AR処理が中断されました。', error); return; }
      }
      arLoopId = requestAnimationFrame(tick);
    }
    arLoopId = requestAnimationFrame(tick);
  }

  window.addEventListener('deviceorientation', function (event) {
    if (state.phase !== 'running' || now()-lastOrientationSample < 100) return;
    lastOrientationSample = now();
    deviceOrientation = {alpha:event.alpha,beta:event.beta,gamma:event.gamma,
      screenAngle:screen.orientation ? screen.orientation.angle : window.orientation,clock:now()};
  }, {passive:true});

  function onUpdate(result) {
    if (state.phase !== 'running') return;
    const background = result.processGpuResult && result.processGpuResult.gltexturerenderer;
    if (background && background.viewport) {
      const v = background.viewport;
      state.cameraFeed.viewport = {width: v.width, height: v.height, offsetX: v.offsetX, offsetY: v.offsetY};
    }
    const reality = result.processCpuResult && result.processCpuResult.reality;
    let projectionValid = !!(reality && reality.intrinsics && reality.intrinsics.length === 16);
    if (projectionValid) {
      for (let i = 0; i < 16; i++) {
        if (!finite(reality.intrinsics[i])) { projectionValid = false; break; }
      }
    }
    const clock = now();
    const poseValid = !!(reality && pointValid(reality.position) && quatValid(reality.rotation) && projectionValid);
    observeRecognition(reality, poseValid, clock);
    const status = reality ? String(reality.trackingStatus) + '/' + String(reality.trackingReason) : 'no-reality';
    if (status !== state.lastTracking) { record('tracking', status); state.lastTracking = status; }
    if (!poseValid) {
      if (poseGuard && state.placed) poseGuard.invalidate('invalid-pose');
      frame[1] = 0; frame[2] = 0;
      state.normalSince = 0;
      resetCandidate();
      return;
    }
    state.latest = reality;
    if (poseGuard && !poseGuard.observe(reality, clock, state.placed || !!state.pendingAt)) {
      frame[1] = 0; frame[2] = 0; state.normalSince = 0; resetCandidate();
      if (tableEstimator) tableEstimator.reset();
      const guard = poseGuard.snapshot();
      if (guard.blocked && clock-lastGuardEvent >= 2000) {
        lastGuardEvent = clock; record('pose-rejected', {guard:guard,deviceOrientation:deviceOrientation});
      }
      return;
    }
    state.lastPoseAt = clock;
    const normal = trackingNormal(reality);
    frame[0] = ++state.sequence;
    frame[1] = 1;
    frame[2] = normal ? 1 : 0;
    frame[3] = reality.position.x;
    frame[4] = reality.position.y;
    frame[5] = reality.position.z;
    frame[6] = reality.rotation.x;
    frame[7] = reality.rotation.y;
    frame[8] = reality.rotation.z;
    frame[9] = reality.rotation.w;
    for (let i = 0; i < 16; i++) frame[10 + i] = reality.intrinsics[i];
    frame[36] = canvas.width;
    frame[37] = canvas.height;
    if (normal) {
      if (!state.normalSince) state.normalSince = clock;
      if (!state.firstNormalAt) state.firstNormalAt = clock;
      if (!state.placed && !state.pendingAt) updateCandidate(reality, clock);
    } else {
      state.normalSince = 0;
      resetCandidate();
      if (tableEstimator) tableEstimator.reset();
    }
  }

  function addModules() {
    if (state.modulesAdded) return;
    XR8.XrController.configure({
      disableWorldTracking: false, enableLighting: false, enableWorldPoints: true,
      leftHandedAxes: false, mirroredDisplay: false, scale: 'absolute'
    });
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.XrController.pipelineModule(),
      {
        name: 'unity-floor-probe',
        listeners: [
          {event: 'coaching-overlay.show', process: function () { sdkCoaching('show'); }},
          {event: 'coaching-overlay.hide', process: function () { sdkCoaching('hide'); }}
        ],
        onStart: function (result) {
          destroyManualRenderer();
          xrGl = result.GLctx;
          state.cameraFeed.canvasMatches = result.canvas === canvas && !!xrGl && xrGl.canvas === canvas;
          state.cameraFeed.videoWidth = result.videoWidth;
          state.cameraFeed.videoHeight = result.videoHeight;
          state.cameraFeed.viewport = null;
          state.cameraFeed.manualError = '';
          state.viewportWidth = result.canvasWidth;
          state.viewportHeight = result.canvasHeight;
          setProjection(result.canvasWidth, result.canvasHeight);
          state.phase = 'running';
          beginRecognition('camera-start');
          startArLoop();
          record('camera-start', {width: result.canvasWidth, height: result.canvasHeight,
            cameraFeed: Object.assign({}, state.cameraFeed), browserRendering: browserRendering()});
          scheduleView('camera-started');
          message('立ったまま、床を映してください。', '胸元の高さで床へ斜めに向け、端末を前へ出して手元へ戻します。向きを変えるだけでなく、位置を動かしてください。');
          updateUi();
        },
        onUpdate: onUpdate,
        onProcessGpu: inspectCameraFrame,
        onRender: drawCameraFrame,
        onDetach: function () { stopArLoop(); destroyManualRenderer(); },
        onCanvasSizeChange: function (result) {
          if (state.phase !== 'running') return;
          if (state.viewportWidth === result.canvasWidth && state.viewportHeight === result.canvasHeight) return;
          state.viewportWidth = result.canvasWidth;
          state.viewportHeight = result.canvasHeight;
          setProjection(result.canvasWidth, result.canvasHeight);
          record('viewport-change', {width:result.canvasWidth,height:result.canvasHeight,
            preservedPlacement:state.placed,deviceOrientation:deviceOrientation});
        },
        onCameraStatusChange: function (result) {
          record('camera', {status: result.status});
          if (result.status === 'failed') fail('カメラを開始できませんでした。Safariのカメラ許可を確認してください。');
        },
        onException: function (error) { fail('AR処理でエラーが発生しました。', error); }
      }
    ]);
    state.modulesAdded = true;
  }

  async function requestMotion() {
    const requests = [];
    // Invoke both permission requests before the first await to retain the iOS user gesture.
    [window.DeviceMotionEvent, window.DeviceOrientationEvent].forEach(function (type) {
      if (type && typeof type.requestPermission === 'function') requests.push(type.requestPermission());
    });
    const results = await Promise.all(requests);
    state.motionPermission = results.slice();
    record('motion-permission', {results: results, browserPromptAvailable: requests.length > 0});
    if (results.some(function (value) { return value !== 'granted'; }))
      throw new Error('モーションの利用が許可されませんでした。Safariのサイト設定を確認してください。');
  }

  async function start() {
    if (state.phase === 'error') { window.location.reload(); return; }
    if (!state.engineReady || !state.unity || !state.registered || state.phase === 'starting') return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('HTTPSのURLで開いてください。ファイルを直接開いた場合はカメラを使えません。');
      return;
    }
    const resume = state.phase === 'paused';
    state.phase = 'starting';
    ui.start.disabled = true;
    message('カメラを準備しています。', 'カメラとモーションの利用を許可してください。');
    try {
      await requestMotion();
      clearPlacement();
      useArCamera();
      resizeCanvas();
      addModules();
      if (resume) {
        XR8.resume();
        XR8.XrController.recenter();
        state.phase = 'running';
        beginRecognition('resume');
        startArLoop();
        record('resume', 'Placement cleared; rescan required.');
      } else {
        XR8.run({canvas: canvas, webgl2: true, ownRunLoop: !budgetArLoop,
          allowedDevices: XR8.XrConfig.device().MOBILE,
          cameraConfig: {direction: XR8.XrConfig.camera().BACK},
          glContextConfig: {alpha: false, antialias: false, preserveDrawingBuffer: false}});
      }
      updateUi();
    } catch (error) { fail('ARを開始できませんでした。', error); }
  }

  function stop() {
    stopArLoop();
    if (window.XR8 && state.modulesAdded) XR8.stop();
    clearPlacement();
    frame.fill(0);
    state.latest = null;
    state.phase = 'stopped';
    state.normalSince = 0;
    record('stop', 'User stopped camera.');
    message('カメラを終了しました。', 'もう一度試す場合は「ARを開始」を押してください。');
    updateUi();
  }

  function updateUi() {
    const running = state.phase === 'running';
    const fresh = running && now() - state.lastPoseAt < 350;
    const normal = fresh && frame[2] > 0.5;
    const ready = normal && !state.placed && !state.pendingAt && frame[35] > 0.5
      && now() - state.lastHitAt < 300;
    const initializing = running && !normal && !state.firstNormalAt;
    const recognitionSeconds = state.recognition ? (now() - state.recognition.startedClock) / 1000 : 0;
    ui.coaching.hidden = !initializing || state.cameraOnly;
    document.body.classList.toggle('active', running);
    document.body.classList.toggle('placed', state.placed);
    document.body.classList.toggle('ready', ready);
    document.body.classList.toggle('camera-only', state.cameraOnly);
    cameraOnly.disabled = !running;
    cameraOnly.textContent = state.cameraOnly ? 'キャラと重ねる表示に戻す' : 'カメラ映像だけ表示';
    redraw.disabled = !running || budgetArLoop;
    redraw.textContent = budgetArLoop ? '省電力方式で映像を描画中' : state.manualBackground ? '再描画をやめる' : '映像の再描画を試す';
    ui.place.hidden = true;
    ui.place.disabled = !ready;
    ui.start.hidden = running || state.phase === 'starting';
    if (state.phase !== 'error') {
      ui.start.disabled = !state.engineReady || !state.unity || !state.registered;
      ui.start.textContent = state.phase === 'loading' ? '読み込み中…'
        : state.phase === 'paused' ? 'ARを再開' : 'ARを開始';
    }
    ui.replace.disabled = !running || !state.placed;
    ui.recenter.disabled = !running;
    ui.stop.disabled = !running && state.phase !== 'paused';
    displayCheck.disabled = !normal || state.placed || !!state.pendingAt;
    const labels = {loading: '準備中', ready: '準備完了', starting: '開始中',
      running: state.placed ? (state.placementMode === 'display-check' ? '表示確認中' : '配置済み')
        : ready ? '自動配置中' : '机を推定中',
      stopped: '終了', paused: '一時停止', error: '確認が必要'};
    ui.phase.textContent = labels[state.phase] || state.phase;
    if (running) {
      if (state.cameraOnly) message('カメラ映像だけを確認しています。', 'AR操作へ戻ると重ね合わせます。');
      else if (state.placed && !normal) message('追跡を確認しています。ゲームは一時停止中です。',
        '机を映したまま姿勢を戻してください。戻らない場合はAR操作から「認識し直す」を押してください。');
      else if (state.placed && state.placementMode === 'display-check')
        message('表示だけの確認中です。', 'この配置は机の認識結果ではありません。「置き直す」で自動推定へ戻れます。');
      else if (state.placed) message('スマホをブロアーにして球を誘導しよう。', 'スマホの位置と向きで狙い、ボタンを押している間だけ風が出ます。移動は半歩程度で。');
      else if (state.pendingAt) message('推定した場所へ自動配置しています。');
      else if (initializing) message(recognitionSeconds >= 20 ? '認識に時間がかかっています。' : '机全体を映して、端末をゆっくり前後へ。',
        '明るく模様のある机を使い、20〜30cmほど前後へ動かしてください。白一色・光沢の強い場所は推定しにくくなります。');
      else if (!normal) message('空間の追跡を待っています。', '机を映しながら端末をゆっくり動かしてください。');
      else if (state.surface.reason === 'stabilizing') message('置ける範囲を確認しています。', '机全体を画面に入れてください。条件が整うとサイズを合わせて自動配置します。');
      else message('机の水平な範囲を探しています。', '机全体を映し、半歩以内で視点を少し変えてください。配置とサイズの操作は不要です。');
    }
    const report = state.lastReport;
    const position = state.latest && state.latest.position;
    const unityPosition = report && report.camera;
    let lines = [
      '版: ' + revision,
      'AR更新: ' + (budgetArLoop ? arBudget.measuredFps.toFixed(1) + ' fps（目標 ' + arBudget.targetFps + '）' : 'SDK標準ループ'),
      '姿勢の保護: ' + (poseGuard ? poseGuard.snapshot().reason : 'missing'),
      'Unity本体: ' + (state.config ? state.config.playerRevision || '旧版' : '未受信'),
      '認識負荷: ' + (recognitionLoadMode === 'baseline' ? '比較用・通常' : '軽減'),
      'Unity目標: ' + (report && finite(report.targetFrameRate) ? report.targetFrameRate + ' fps' : '—'),
      'Unity VSync: ' + (report && finite(report.vSyncCount) ? report.vSyncCount : '—'),
      '透過補正: ' + (unityAlpha.installed ? (unityAlpha.enabled ? '有効' : '無効') : '未設定'),
      '不透明化の抑制: ' + unityAlpha.preventedClears + '回',
      '表示: ' + (state.cameraOnly ? '現実の映像のみ' : 'キャラとの重ね合わせ'),
      '映像の再描画: ' + (state.manualBackground ? '有効' : '無効'),
      '映像テクスチャ: ' + (state.cameraFeed.texturePresent ? 'あり' : '未受信'),
      '映像サイズ: ' + state.cameraFeed.textureWidth + ' × ' + state.cameraFeed.textureHeight,
      '映像更新: ' + state.cameraFeed.freshVideoFrames,
      '背景描画の機会: ' + state.cameraFeed.renderCallbacks,
      '再描画回数: ' + state.cameraFeed.manualDraws,
      '状態: ' + state.phase,
      '確認モード: ' + state.placementMode,
      '追跡: ' + state.lastTracking,
      '配置方式: 水平点群の範囲推定（机の縁・実寸は評価中）',
      '机推定: ' + JSON.stringify(state.surface),
      '地面のY座標: ' + state.ground.planeY + 'm',
      '推定カメラ高: ' + (finite(state.ground.cameraHeight) ? state.ground.cameraHeight.toFixed(2) + 'm' : '—'),
      '判定: ' + state.ground.reason,
      '安定時間: ' + state.ground.stableSeconds.toFixed(2) + '秒',
      '除外理由の累計: ' + JSON.stringify(state.ground.rejected),
      '距離: ' + (state.candidate ? state.candidate.distance.toFixed(2) + 'm' : '—'),
      'Unity更新: ' + (report ? report.fps.toFixed(1) + ' fps' : '受信待ち'),
      'フレーム: ' + state.sequence,
      'AR解像度: ' + canvas.width + ' × ' + canvas.height,
      '初回追跡まで: ' + (state.firstNormalAt && state.startedAt
        ? ((state.firstNormalAt - state.startedAt) / 1000).toFixed(1) + '秒' : '—'),
      '今回の認識経過: ' + recognitionSeconds.toFixed(1) + '秒',
      'モーション許可: ' + JSON.stringify(state.motionPermission),
      'モーション受信: ' + (state.recognition ? state.recognition.motion.events : 0),
      '初期認識のサンプル: ' + (state.recognition ? state.recognition.samples.length : 0)
    ];
    if (position) lines.push('XR座標: ' + [position.x, position.y, position.z].map(function (v) { return v.toFixed(3); }).join(', '));
    if (unityPosition) lines.push('Unity座標: ' + [unityPosition.x, unityPosition.y, unityPosition.z].map(function (v) { return v.toFixed(3); }).join(', '));
    if (state.error) lines.push('エラー: ' + state.error);
    if (state.cameraFeed.manualError) lines.push('背景再描画エラー: ' + state.cameraFeed.manualError);
    if (unityAlpha.error) lines.push('透過補正エラー: ' + unityAlpha.error);
    ui.metrics.textContent = lines.join('\n');
  }

  function maybeReady() {
    if (state.phase !== 'loading') return;
    if (!state.engineReady || !state.unity || !state.registered) return;
    state.phase = 'ready';
    useArCamera();
    ui.loading.hidden = true;
    message('準備ができました。', '「ARを開始」を押し、カメラとモーションを許可してください。');
    updateUi();
  }

  function onEngineLoaded() {
    state.engineReady = true;
    record('engine-ready', 'Local XR Engine loaded.');
    maybeReady();
  }
  window.addEventListener('xrloaded', onEngineLoaded);
  if (window.XR8) onEngineLoaded();

  ui.start.addEventListener('click', start);
  cameraOnly.addEventListener('click', function () {
    if (cameraOnly.disabled) return;
    saveView('before-view-change');
    state.cameraOnly = !state.cameraOnly;
    record('camera-only', state.cameraOnly);
    updateUi();
    scheduleView('after-view-change');
  });
  redraw.addEventListener('click', function () {
    if (redraw.disabled) return;
    saveView('before-redraw-change');
    state.manualBackground = !state.manualBackground;
    state.cameraFeed.manualError = '';
    record('manual-background', state.manualBackground);
    updateUi();
    scheduleView('after-redraw-change');
  });
  displayCheck.addEventListener('click', function () {
    if (displayCheck.disabled || !state.latest || !quatValid(state.latest.rotation)) return;
    const q = state.latest.rotation;
    const length = Math.hypot(q.x, q.y, q.z, q.w);
    if (length < 0.001) return;
    const x = q.x / length, y = q.y / length, z = q.z / length, w = q.w / length;
    // Diagnostic target along the SDK camera's local -Z. This is not a surface estimate.
    const forward = {x: -2 * (x * z + y * w), y: 2 * (x * w - y * z), z: 2 * (x * x + y * y) - 1};
    const camera = state.latest.position;
    const point = {x: camera.x + forward.x * 1.5,
      y: camera.y + forward.y * 1.5 - state.config.characterHeight / 2,
      z: camera.z + forward.z * 1.5};
    state.placementMode = 'display-check';
    state.displayRequest = true;
    state.pendingAt = now();
    frame[35] = 1;
    send('PlaceFromBrowser', JSON.stringify({position: point}));
    record('display-check-request', {position: point, floorDetection: false});
    updateUi();
  });
  ui.replace.addEventListener('click', function () { clearPlacement(); record('replace', 'Reselect surface.'); updateUi(); });
  ui.recenter.addEventListener('click', function () {
    clearPlacement();
    frame[1] = 0; frame[2] = 0;
    state.normalSince = 0;
    XR8.XrController.recenter();
    beginRecognition('user-recenter');
    record('recenter', 'World origin reset; placement cleared.');
    updateUi();
  });
  ui.stop.addEventListener('click', stop);
  ui.download.addEventListener('click', function () {
    const payload = {
      prototype: 'ARRollCapture-' + revision, savedAt: new Date().toISOString(),
      game: window.RollCaptureBridge ? RollCaptureBridge.snapshot() : null,
      page: location.origin + location.pathname, userAgent: navigator.userAgent,
      viewport: {width: innerWidth, height: innerHeight, pixelRatio: pixelRatio},
      phase: state.phase, config: state.config, tracking: state.lastTracking,
      hitType: state.hitType, unity: state.lastReport, error: state.error,
      placementMode: state.placementMode, surfaceDiagnostics: state.surface,
      groundSettings: groundSettings, groundDiagnostics: state.ground,
      recognitionLoadMode: recognitionLoadMode, placementHistory: state.placementHistory.slice(),
      recognitionDiagnostics: state.recognition, recognitionHistory: state.recognitionHistory.slice(),
      motionPermission: state.motionPermission,
      cameraOnly: state.cameraOnly, manualBackground: state.manualBackground,
      cameraFeed: state.cameraFeed, browserRendering: browserRendering(), viewHistory: viewHistory.slice(),
      cameraPose: state.latest ? {position: copyPoint(state.latest.position),
        rotation: {x: state.latest.rotation.x, y: state.latest.rotation.y, z: state.latest.rotation.z, w: state.latest.rotation.w},
        projection: Array.from(state.latest.intrinsics)} : null,
      canvasSizes: {xr: {width: canvas.width, height: canvas.height},
        unity: {width: document.getElementById('unity-canvas').width, height: document.getElementById('unity-canvas').height}},
      events: events.slice()
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ar-floor-diagnostic-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  });
  window.addEventListener('resize', function () { resizeCanvas(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden || (state.phase !== 'running' && state.phase !== 'starting')) return;
    clearPlacement();
    stopArLoop();
    if (window.XR8 && state.modulesAdded) XR8.pause();
    frame[1] = 0; frame[2] = 0;
    state.phase = 'paused';
    record('pause', 'Page hidden; placement cleared.');
    message('一時停止しました。', '「ARを再開」を押して、床を認識し直してください。');
    updateUi();
  });
  window.addEventListener('pagehide', function () {
    if (window.XR8 && state.modulesAdded) { try { stop(); } catch (_) { /* Page is leaving. */ } }
  });
  [canvas, document.getElementById('unity-canvas')].forEach(function (element) {
    element.addEventListener('webglcontextlost', function () { fail('描画が中断されました。診断を保存してから再読み込みしてください。'); });
  });
  window.addEventListener('error', function (event) { record('window-error', String(event.message || 'Unknown script error')); });
  window.addEventListener('unhandledrejection', function (event) { record('unhandled-rejection', String(event.reason)); });

  window.FloorProbeBridge = {
    pixelRatio: pixelRatio,
    gameCommand: function (method) {
      if (method === 'ResetBall') send(method);
    },
    gameIsActive: function () {
      return state.phase === 'running' && state.placed && !state.cameraOnly
        && now() - state.lastPoseAt < 350 && frame[2] > .5;
    },
    captureContext: function (kind, context) {
      if (context && (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl')) {
        unityGl = context;
        installUnityAlphaGuard(context);
      }
    },
    register: function (config) {
      state.config = config;
      arBudget.targetFps = Math.max(30,Math.min(60,config.arProcessingFrameRate || 30));
      tableEstimator = window.RollTableEstimator ? RollTableEstimator(config) : null;
      if (!config.supportsRecognitionBudget || config.playerRevision !== revision) {
        fail('Unity本体の更新が必要です。', 'Roll Captureのソースから再ビルドし、Buildも公開してください。');
        return;
      }
      if (!poseGuard) { fail('姿勢の保護処理を読み込めませんでした。', 'pose-guard.jsも公開してください。'); return; }
      if (!tableEstimator) { fail('机の推定処理を読み込めませんでした。', 'table-placement.jsも公開してください。'); return; }
      state.registered = true;
      configureUnityBudget();
      ui.dimensions.textContent = '机の範囲から配置と大きさを自動で推定します';
      record('unity-registered', config);
      maybeReady();
    },
    setUnity: function (instance) {
      state.unity = instance;
      configureUnityBudget();
      record('unity-ready', true);
      maybeReady();
    },
    readFrame: function () {
      if (state.phase !== 'running' || now() - state.lastPoseAt > 350) {
        if (poseGuard && state.placed) poseGuard.invalidate('stale-pose');
        frame[1] = 0; frame[2] = 0; frame[26] = 0; frame[35] = 0;
        state.normalSince = 0;
        resetCandidate();
      } else if (state.displayRequest && state.pendingAt && frame[2] > 0.5) {
        // The explicit display diagnostic uses the old player binary's placement interface.
        frame[35] = 1;
      }
      return frame;
    },
    report: function (value) {
      state.lastReport = value;
      // Only Unity acknowledges placement; a browser request is not proof of success.
      if (state.pendingAt && value.placed) {
        state.placed = true; state.pendingAt = 0;
        configureWorldPoints(false);
        state.displayRequest = false;
        frame[35] = 0;
        state.placementHistory.push({time: new Date().toISOString(), mode: state.placementMode,
          loadMode: recognitionLoadMode, ground: state.ground.atPlacement, anchor: value.anchor});
        if (state.placementHistory.length > 12) state.placementHistory.shift();
        record('place-acknowledged', {position: value.anchor, mode: state.placementMode});
      } else if (state.pendingAt && now() - state.pendingAt > 1500) {
        state.pendingAt = 0;
        state.displayRequest = false;
        state.placementMode = 'table-estimate';
        frame[35] = 0;
        record('place-rejected', 'Unity did not acknowledge placement.');
      }
      updateUi();
    },
    progress: function (value) { ui.progress.style.width = Math.round(value * 100) + '%'; },
    banner: function (text, type) { record('unity-' + type, String(text)); if (type === 'error') fail('Unityの起動エラーです。', text); },
    fail: fail
  };
  resizeCanvas();
  setInterval(function () {
    if (state.phase === 'running') updateUi();
  }, 250);
  setTimeout(function () {
    if (state.phase === 'loading') fail('読み込みが完了しませんでした。通信と公開ファイルを確認してください。');
  }, 180000);
}());

