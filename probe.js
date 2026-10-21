/* MIT License. Project code only; the XR Engine has its separate bundled license. */
(function () {
  'use strict';
  const revision = '0.1.3';
  const ui = {};
  ['start', 'place', 'replace', 'recenter', 'stop', 'status', 'phase', 'guidance',
    'progress', 'loading', 'metrics', 'download', 'dimensions', 'reticle'].forEach(function (id) {
    ui[id] = document.getElementById(id);
  });
  const canvas = document.getElementById('camera-canvas');
  const frame = new Float32Array(38);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
  const events = [];
  const viewHistory = [];
  let unityGl = null;
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
  document.getElementById('diagnostics').before(feedControls);
  const feedNote = document.createElement('p');
  feedNote.className = 'note';
  feedNote.textContent = 'キャラの画面だけを隠して、下にある現実の映像を確認できます。配置は消しません。';
  feedControls.after(feedNote);
  const displayCheck = document.createElement('button');
  displayCheck.textContent = '床判定を使わず表示だけ確認';
  displayCheck.disabled = true;
  document.getElementById('diagnostics').appendChild(displayCheck);
  const displayNote = document.createElement('p');
  displayNote.className = 'note';
  displayNote.textContent = 'このボタンはカメラの前に仮キャラクターを置きます。床認識の確認にはなりません。';
  document.getElementById('diagnostics').appendChild(displayNote);
  document.querySelector('.eyebrow').textContent = 'AR PROTOTYPE · ' + revision;
  const state = {
    phase: 'loading', engineReady: false, unity: null, registered: false, modulesAdded: false,
    config: null, latest: null, lastPoseAt: 0, sequence: 0, normalSince: 0,
    candidate: null, stableOrigin: null, stableMean: null, stableCount: 0,
    stableSince: 0, lastHitAt: 0, lastHitCheck: 0,
    placed: false, pendingAt: 0, startedAt: 0, lastReport: null, firstNormalAt: 0,
    lastTracking: '', hitType: '', error: '', viewportWidth: 0, viewportHeight: 0,
    placementMode: 'floor', displayRequest: false, cameraOnly: false, manualBackground: false,
    cameraFeed: {gpuFrames: 0, renderCallbacks: 0, freshVideoFrames: 0,
      texturePresent: false, textureContextMatches: null,
      textureWidth: 0, textureHeight: 0, videoWidth: 0, videoHeight: 0,
      videoTime: null, repeatFrame: null, viewport: null, canvasMatches: null,
      manualDraws: 0, manualError: ''},
    surface: {cycles: 0, queries: 0, returned: 0, accepted: 0, types: {},
      samples: [], rejected: {}, reason: 'not-queried', lastSignature: '', lastEventAt: 0}
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

  function describeContext(gl) {
    if (!gl) return null;
    try {
      return {attributes: gl.getContextAttributes(), lost: gl.isContextLost(),
        drawingBufferWidth: gl.drawingBufferWidth, drawingBufferHeight: gl.drawingBufferHeight};
    } catch (error) { return {error: String(error)}; }
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
      sameContext: !!(xrGl && unityGl && xrGl === unityGl)};
  }

  function saveView(reason) {
    viewHistory.push({time: new Date().toISOString(), reason: reason,
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

  function drawCameraFrame() {
    state.cameraFeed.renderCallbacks++;
    if (!state.manualBackground || !xrGl || !latestCameraFrame
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
    frame[26] = 0;
    frame[35] = 0;
  }

  function clearPlacement() {
    state.placed = false;
    state.pendingAt = 0;
    state.placementMode = 'floor';
    state.displayRequest = false;
    send('ClearPlacement');
    resetCandidate();
  }

  function setProjection(width, height) {
    if (!width || !height) return;
    XR8.XrController.updateCameraProjectionMatrix({
      cam: {pixelRectWidth: width, pixelRectHeight: height, nearClipPlane: 0.05, farClipPlane: 30},
      origin: {x: 0, y: 1.5, z: 0}, facing: {x: 0, y: 0, z: 0, w: 1}
    });
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

  function queryHits(x, y, mode) {
    state.surface.queries++;
    try {
      // Query the SDK default and its documented FEATURE_POINT mode separately.
      const results = mode === 'feature'
        ? XR8.XrController.hitTest(x, y, ['FEATURE_POINT'])
        : XR8.XrController.hitTest(x, y);
      return Array.isArray(results) ? results : [];
    } catch (error) {
      state.surface.queryError = String(error.message || error);
      return [];
    }
  }

  function isSurface(hit) {
    return hit && (hit.type === 'DETECTED_SURFACE' || hit.type === 'ESTIMATED_SURFACE');
  }

  function noteRejection(reason) {
    state.surface.rejected[reason] = (state.surface.rejected[reason] || 0) + 1;
    state.surface.reason = reason;
  }

  function nearbySurface(x, y, center, mode) {
    const hits = queryHits(x, y, mode).filter(function (hit) {
      return isSurface(hit) && pointValid(hit.position) && distance(hit.position, center) < 0.6;
    });
    hits.sort(function (a, b) { return distance(a.position, center) - distance(b.position, center); });
    return hits[0] && hits[0].position;
  }

  function surfaceUp(center, mode) {
    const right = nearbySurface(0.55, 0.58, center, mode);
    const down = nearbySurface(0.5, 0.63, center, mode);
    state.surface.neighbors = {right: right ? copyPoint(right) : null, down: down ? copyPoint(down) : null};
    if (!right || !down) return null;
    const ax = right.x - center.x, ay = right.y - center.y, az = right.z - center.z;
    const bx = down.x - center.x, by = down.y - center.y, bz = down.z - center.z;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 0.00001) return null;
    // Winding changes the sign; only the geometric plane's slope is relevant here.
    return Math.abs(ny) / length;
  }

  function recordSurface(clock) {
    const summary = state.surface;
    const signature = JSON.stringify([summary.reason, summary.samples.map(function (sample) { return sample.type; })]);
    if (signature !== summary.lastSignature && clock - summary.lastEventAt >= 2000) {
      record('surface-query', {reason: summary.reason, samples: summary.samples, rejected: summary.rejected});
      summary.lastSignature = signature;
      summary.lastEventAt = clock;
    }
  }

  function updateCandidate(reality, clock) {
    if (clock - state.lastHitCheck < 200) return;
    state.lastHitCheck = clock;
    const stats = state.surface;
    stats.cycles++;
    stats.rejected = {};
    stats.queryError = '';
    stats.reason = 'no-hits';
    const options = [];
    stats.samples = [];
    ['default', 'feature'].forEach(function (mode) {
      const results = queryHits(0.5, 0.58, mode);
      stats.returned += results.length;
      results.forEach(function (hit) {
        const type = hit && String(hit.type);
        stats.types[type] = (stats.types[type] || 0) + 1;
        if (stats.samples.length < 6) stats.samples.push({query: mode, type: type,
          position: hit && pointValid(hit.position) ? copyPoint(hit.position) : null,
          rotation: hit && quatValid(hit.rotation) ? {x: hit.rotation.x, y: hit.rotation.y, z: hit.rotation.z, w: hit.rotation.w} : null,
          distance: hit && finite(hit.distance) ? hit.distance : null});
        if (!isSurface(hit)) { noteRejection('not-a-surface'); return; }
        if (!pointValid(hit.position)) { noteRejection('invalid-position'); return; }
        const range = distance(hit.position, reality.position);
        if (range < state.config.minimumDistance || range > state.config.maximumDistance) {
          noteRejection('outside-distance-range'); return;
        }
        if (hit.position.y >= reality.position.y - 0.15) { noteRejection('not-below-camera'); return; }
        options.push({hit: hit, mode: mode, range: range});
      });
    });
    options.sort(function (a, b) {
      if (a.hit.type !== b.hit.type) return a.hit.type === 'DETECTED_SURFACE' ? -1 : 1;
      return a.range - b.range;
    });
    let hit = null;
    for (let index = 0; index < Math.min(options.length, 2); index++) {
      const option = options[index];
      // Hit rotation does not document which local axis is the surface normal.
      // Derive a normal from adjacent SDK surface positions instead of assuming local +Y.
      const up = surfaceUp(option.hit.position, option.mode);
      if (up === null) { noteRejection('surface-normal-unavailable'); continue; }
      stats.lastSlopeDegrees = Math.acos(Math.min(1, up)) * 180 / Math.PI;
      if (up < Math.cos(state.config.maximumSlope * Math.PI / 180)) { noteRejection('surface-too-steep'); continue; }
      hit = option.hit;
      break;
    }
    if (!hit) { resetCandidate(); state.hitType = ''; recordSurface(clock); return; }
    stats.accepted++;
    stats.reason = 'surface-selected';
    state.hitType = hit.type;
    state.lastHitAt = clock;
    if (!state.stableOrigin || distance(state.stableOrigin, hit.position) > state.config.stableRadius) {
      state.stableOrigin = copyPoint(hit.position);
      state.stableMean = copyPoint(hit.position);
      state.stableCount = 1;
      state.stableSince = clock;
    } else {
      state.stableCount++;
      const count = state.stableCount;
      ['x', 'y', 'z'].forEach(function (axis) {
        state.stableMean[axis] += (hit.position[axis] - state.stableMean[axis]) / count;
      });
    }
    state.candidate = {
      position: copyPoint(state.stableMean), type: hit.type,
      distance: distance(state.stableMean, reality.position)
    };
    frame[26] = 1;
    frame[27] = state.candidate.position.x;
    frame[28] = state.candidate.position.y;
    frame[29] = state.candidate.position.z;
    frame[30] = 0; frame[31] = 0; frame[32] = 0; frame[33] = 1;
    frame[34] = state.candidate.distance;
    frame[35] = clock - state.stableSince >= state.config.stableSeconds * 1000
      && clock - state.normalSince >= 1000 ? 1 : 0;
    recordSurface(clock);
  }

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
    if (!reality || !pointValid(reality.position) || !quatValid(reality.rotation) || !projectionValid) {
      frame[1] = 0; frame[2] = 0;
      state.normalSince = 0;
      resetCandidate();
      return;
    }
    const clock = now();
    state.latest = reality;
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
    }
    const status = String(reality.trackingStatus) + '/' + String(reality.trackingReason);
    if (status !== state.lastTracking) { record('tracking', status); state.lastTracking = status; }
  }

  function addModules() {
    if (state.modulesAdded) return;
    XR8.XrController.configure({
      disableWorldTracking: false, enableLighting: false, enableWorldPoints: false,
      leftHandedAxes: false, mirroredDisplay: false, scale: 'absolute'
    });
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.XrController.pipelineModule(),
      {
        name: 'unity-floor-probe',
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
          state.startedAt = now();
          state.firstNormalAt = 0;
          record('camera-start', {width: result.canvasWidth, height: result.canvasHeight,
            cameraFeed: Object.assign({}, state.cameraFeed), browserRendering: browserRendering()});
          scheduleView('camera-started');
          message('床を認識しています。', '床を映したまま、端末をゆっくり前後・左右に動かしてください。');
          updateUi();
        },
        onUpdate: onUpdate,
        onProcessGpu: inspectCameraFrame,
        onRender: drawCameraFrame,
        onDetach: destroyManualRenderer,
        onCanvasSizeChange: function (result) {
          if (state.phase !== 'running') return;
          if (state.viewportWidth === result.canvasWidth && state.viewportHeight === result.canvasHeight) return;
          state.viewportWidth = result.canvasWidth;
          state.viewportHeight = result.canvasHeight;
          clearPlacement();
          frame[1] = 0; frame[2] = 0;
          state.normalSince = 0;
          setProjection(result.canvasWidth, result.canvasHeight);
          XR8.XrController.recenter();
          record('viewport-reset', {width: result.canvasWidth, height: result.canvasHeight});
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
        state.normalSince = 0;
        record('resume', 'Placement cleared; rescan required.');
      } else {
        XR8.run({canvas: canvas, webgl2: true, ownRunLoop: true,
          allowedDevices: XR8.XrConfig.device().MOBILE,
          cameraConfig: {direction: XR8.XrConfig.camera().BACK},
          glContextConfig: {alpha: false, antialias: false, preserveDrawingBuffer: false}});
      }
      updateUi();
    } catch (error) { fail('ARを開始できませんでした。', error); }
  }

  function stop() {
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
    document.body.classList.toggle('active', running);
    document.body.classList.toggle('placed', state.placed);
    document.body.classList.toggle('ready', ready);
    document.body.classList.toggle('camera-only', state.cameraOnly);
    cameraOnly.disabled = !running;
    cameraOnly.textContent = state.cameraOnly ? 'キャラと重ねる表示に戻す' : 'カメラ映像だけ表示';
    redraw.disabled = !running;
    redraw.textContent = state.manualBackground ? '再描画をやめる' : '映像の再描画を試す';
    ui.place.hidden = !running || state.placed;
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
        : ready ? '配置できます' : '認識中',
      stopped: '終了', paused: '一時停止', error: '確認が必要'};
    ui.phase.textContent = labels[state.phase] || state.phase;
    if (running) {
      if (state.cameraOnly)
        message('現実のカメラ映像だけを確認しています。', '現実の映像が見えるか確認してください。見えなければ「映像の再描画を試す」を押してください。');
      else if (!normal) message('空間の追跡を安定させています。', '床を映したまま、端末をゆっくり前後に動かしてください。認識中は表示を隠します。');
      else if (state.placed && state.placementMode === 'display-check')
        message('床判定を使わない表示確認中です。', '仮キャラクターが見えるか確認してください。この結果は床認識の成功を意味しません。');
      else if (state.placed) message('床に配置しました。', '端末を左右・上下に動かし、足元の位置と大きさを確認してください。');
      else if (state.pendingAt) message('Unityへ配置を伝えています。');
      else if (ready) message('この場所に配置できます。', '「ここに置く」を押してください。枠の一辺は1m、キャラクターは50cmが初期値です。');
      else if (state.candidate) message('同じ場所を少し映し続けてください。', '配置位置が安定するとボタンが有効になります。');
      else if (state.surface.cycles > 5 && state.surface.reason === 'not-a-surface')
        message('空間の追跡はできていますが、水平面を取得できていません。', '「確認用の詳細」の表示確認ボタンを押し、診断を保存してください。');
      else if (state.surface.cycles > 5 && state.surface.reason === 'no-hits')
        message('空間の追跡はできていますが、配置候補は0件です。', '「確認用の詳細」の表示確認ボタンを押し、診断を保存してください。');
      else message('床に照準を合わせてください。', '明るく、模様のある床を映してください。近すぎる場所や壁には配置しません。');
    }
    const report = state.lastReport;
    const position = state.latest && state.latest.position;
    const unityPosition = report && report.camera;
    let lines = [
      '版: ' + revision,
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
      '面の種類: ' + (state.hitType || 'なし'),
      'SDKの候補: ' + JSON.stringify(state.surface.types),
      '判定: ' + state.surface.reason,
      '今回の除外理由: ' + JSON.stringify(state.surface.rejected),
      '距離: ' + (state.candidate ? state.candidate.distance.toFixed(2) + 'm' : '—'),
      'Unity更新: ' + (report ? report.fps.toFixed(1) + ' fps' : '受信待ち'),
      'フレーム: ' + state.sequence,
      'AR解像度: ' + canvas.width + ' × ' + canvas.height,
      '初回追跡まで: ' + (state.firstNormalAt && state.startedAt
        ? ((state.firstNormalAt - state.startedAt) / 1000).toFixed(1) + '秒' : '—')
    ];
    if (position) lines.push('XR座標: ' + [position.x, position.y, position.z].map(function (v) { return v.toFixed(3); }).join(', '));
    if (unityPosition) lines.push('Unity座標: ' + [unityPosition.x, unityPosition.y, unityPosition.z].map(function (v) { return v.toFixed(3); }).join(', '));
    if (state.error) lines.push('エラー: ' + state.error);
    if (state.surface.queryError) lines.push('候補取得エラー: ' + state.surface.queryError);
    if (state.cameraFeed.manualError) lines.push('背景再描画エラー: ' + state.cameraFeed.manualError);
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
  ui.place.addEventListener('click', function () {
    if (ui.place.disabled || !state.candidate || now() - state.lastHitAt > 300) return;
    const point = copyPoint(state.candidate.position);
    state.placementMode = 'floor';
    state.pendingAt = now();
    send('PlaceFromBrowser', JSON.stringify({position: point}));
    record('place-request', {position: point, surface: state.candidate.type});
    updateUi();
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
    record('recenter', 'World origin reset; placement cleared.');
    updateUi();
  });
  ui.stop.addEventListener('click', stop);
  ui.download.addEventListener('click', function () {
    const payload = {
      prototype: 'ARFloorPrototype-' + revision, savedAt: new Date().toISOString(),
      page: location.origin + location.pathname, userAgent: navigator.userAgent,
      viewport: {width: innerWidth, height: innerHeight, pixelRatio: pixelRatio},
      phase: state.phase, config: state.config, tracking: state.lastTracking,
      hitType: state.hitType, unity: state.lastReport, error: state.error,
      placementMode: state.placementMode, surfaceDiagnostics: state.surface,
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
    captureContext: function (kind, context) {
      if (context && (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl')) unityGl = context;
    },
    register: function (config) {
      state.config = config;
      state.registered = true;
      ui.dimensions.textContent = 'キャラクター ' + Math.round(config.characterHeight * 100) + 'cm · 比較枠 ' + config.referenceSize + 'm四方';
      record('unity-registered', config);
      maybeReady();
    },
    setUnity: function (instance) { state.unity = instance; record('unity-ready', true); maybeReady(); },
    readFrame: function () {
      if (state.phase !== 'running' || now() - state.lastPoseAt > 350) {
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
        state.displayRequest = false;
        frame[35] = 0;
        record('place-acknowledged', {position: value.anchor, mode: state.placementMode});
      } else if (state.pendingAt && now() - state.pendingAt > 1500) {
        state.pendingAt = 0;
        state.displayRequest = false;
        state.placementMode = 'floor';
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
