/* MIT License. Project code only; the XR Engine has its separate bundled license. */
(function () {
  'use strict';
  const ui = {};
  ['start', 'place', 'replace', 'recenter', 'stop', 'status', 'phase', 'guidance',
    'progress', 'loading', 'metrics', 'download', 'dimensions', 'reticle'].forEach(function (id) {
    ui[id] = document.getElementById(id);
  });
  const canvas = document.getElementById('camera-canvas');
  const frame = new Float32Array(38);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
  const events = [];
  const state = {
    phase: 'loading', engineReady: false, unity: null, registered: false, modulesAdded: false,
    config: null, latest: null, lastPoseAt: 0, sequence: 0, normalSince: 0,
    candidate: null, stableOrigin: null, stableMean: null, stableCount: 0,
    stableSince: 0, lastHitAt: 0, lastHitCheck: 0,
    placed: false, pendingAt: 0, startedAt: 0, lastReport: null, firstNormalAt: 0,
    lastTracking: '', hitType: '', error: '', viewportWidth: 0, viewportHeight: 0
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

  function updateCandidate(reality, clock) {
    if (clock - state.lastHitCheck < 100) return;
    state.lastHitCheck = clock;
    // Use SDK surface hits only. Feature points and arbitrary ray/plane intersections are rejected.
    const results = XR8.XrController.hitTest(0.5, 0.58, []) || [];
    const minimumUp = Math.cos(state.config.maximumSlope * Math.PI / 180);
    const options = results.filter(function (hit) {
      if (hit.type !== 'DETECTED_SURFACE' && hit.type !== 'ESTIMATED_SURFACE') return false;
      if (!pointValid(hit.position) || !quatValid(hit.rotation)) return false;
      const q = hit.rotation;
      const norm = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
      if (norm < 0.001) return false;
      const up = 1 - 2 * (q.x * q.x + q.z * q.z) / norm;
      const range = distance(hit.position, reality.position);
      return up >= minimumUp && range >= state.config.minimumDistance
        && range <= state.config.maximumDistance && hit.position.y < reality.position.y - 0.15;
    });
    options.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'DETECTED_SURFACE' ? -1 : 1;
      return distance(a.position, reality.position) - distance(b.position, reality.position);
    });
    const hit = options[0];
    if (!hit) { resetCandidate(); state.hitType = ''; return; }
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
      position: copyPoint(state.stableMean), rotation: hit.rotation, type: hit.type,
      distance: distance(state.stableMean, reality.position)
    };
    frame[26] = 1;
    frame[27] = state.candidate.position.x;
    frame[28] = state.candidate.position.y;
    frame[29] = state.candidate.position.z;
    frame[30] = hit.rotation.x;
    frame[31] = hit.rotation.y;
    frame[32] = hit.rotation.z;
    frame[33] = hit.rotation.w;
    frame[34] = state.candidate.distance;
    frame[35] = clock - state.stableSince >= state.config.stableSeconds * 1000
      && clock - state.normalSince >= 1000 ? 1 : 0;
  }

  function onUpdate(result) {
    if (state.phase !== 'running') return;
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
          state.viewportWidth = result.canvasWidth;
          state.viewportHeight = result.canvasHeight;
          setProjection(result.canvasWidth, result.canvasHeight);
          state.phase = 'running';
          state.startedAt = now();
          state.firstNormalAt = 0;
          record('camera-start', {width: result.canvasWidth, height: result.canvasHeight});
          message('床を認識しています。', '床を映したまま、端末をゆっくり前後・左右に動かしてください。');
          updateUi();
        },
        onUpdate: onUpdate,
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
    const labels = {loading: '準備中', ready: '準備完了', starting: '開始中',
      running: state.placed ? '配置済み' : ready ? '配置できます' : '認識中',
      stopped: '終了', paused: '一時停止', error: '確認が必要'};
    ui.phase.textContent = labels[state.phase] || state.phase;
    if (running) {
      if (!normal) message('床の認識を安定させています。', '床を映したまま、端末をゆっくり前後に動かしてください。認識中は表示を隠します。');
      else if (state.placed) message('床に固定しました。', '端末を左右・上下に動かし、位置と大きさを確認してください。');
      else if (state.pendingAt) message('Unityへ配置を伝えています。');
      else if (ready) message('この場所に配置できます。', '「ここに置く」を押してください。枠の一辺は1m、キャラクターは50cmが初期値です。');
      else if (state.candidate) message('同じ場所を少し映し続けてください。', '配置位置が安定するとボタンが有効になります。');
      else message('床に照準を合わせてください。', '明るく、模様のある床を映してください。近すぎる場所や壁には配置しません。');
    }
    const report = state.lastReport;
    const position = state.latest && state.latest.position;
    const unityPosition = report && report.camera;
    let lines = [
      '状態: ' + state.phase,
      '追跡: ' + state.lastTracking,
      '面の種類: ' + (state.hitType || 'なし'),
      '距離: ' + (state.candidate ? state.candidate.distance.toFixed(2) + 'm' : '—'),
      'Unity表示: ' + (report ? report.fps.toFixed(1) + ' fps' : '受信待ち'),
      'フレーム: ' + state.sequence,
      'AR解像度: ' + canvas.width + ' × ' + canvas.height,
      '初回追跡まで: ' + (state.firstNormalAt && state.startedAt
        ? ((state.firstNormalAt - state.startedAt) / 1000).toFixed(1) + '秒' : '—')
    ];
    if (position) lines.push('XR座標: ' + [position.x, position.y, position.z].map(function (v) { return v.toFixed(3); }).join(', '));
    if (unityPosition) lines.push('Unity座標: ' + [unityPosition.x, unityPosition.y, unityPosition.z].map(function (v) { return v.toFixed(3); }).join(', '));
    if (state.error) lines.push('エラー: ' + state.error);
    ui.metrics.textContent = lines.join('\n');
  }

  function maybeReady() {
    if (state.phase !== 'loading') return;
    if (!state.engineReady || !state.unity || !state.registered) return;
    state.phase = 'ready';
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
  ui.place.addEventListener('click', function () {
    if (ui.place.disabled || !state.candidate || now() - state.lastHitAt > 300) return;
    const point = copyPoint(state.candidate.position);
    state.pendingAt = now();
    send('PlaceFromBrowser', JSON.stringify({position: point}));
    record('place-request', {position: point, surface: state.candidate.type});
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
      prototype: 'ARFloorPrototype-0.1.0', savedAt: new Date().toISOString(),
      page: location.origin + location.pathname, userAgent: navigator.userAgent,
      viewport: {width: innerWidth, height: innerHeight, pixelRatio: pixelRatio},
      phase: state.phase, config: state.config, tracking: state.lastTracking,
      hitType: state.hitType, unity: state.lastReport, error: state.error,
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
      }
      return frame;
    },
    report: function (value) {
      state.lastReport = value;
      // Only Unity acknowledges placement; a browser request is not proof of success.
      if (state.pendingAt && value.placed) {
        state.placed = true; state.pendingAt = 0;
        record('place-acknowledged', value.anchor);
      } else if (state.pendingAt && now() - state.pendingAt > 1500) {
        state.pendingAt = 0;
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
