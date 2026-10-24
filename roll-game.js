(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'roll-controls'; panel.hidden = true;
  panel.innerHTML = `<div id="roll-guidance"><p id="roll-notice" role="status">端末の背面から風を出そう</p>
      <div id="roll-reacquire" hidden><p id="roll-reacquire-help"></p><button id="roll-reacquire-button">用紙を読み直す</button></div>
    </div>
    <button id="roll-reset" aria-label="球と未捕獲モンスターを初期位置に戻す"><span>復帰</span><small id="roll-reset-time" hidden></small></button>
    <nav class="roll-toolbar" aria-label="ゲーム操作">
      <button id="roll-collection">図鑑</button><button id="roll-tools">AR操作</button>
    </nav>
    <div id="roll-monster-markers" aria-label="モンスターの状態"></div>
    <div class="roll-aim" aria-hidden="true"><span class="roll-aim-dot"></span></div>
    <div class="roll-airflow" aria-hidden="true">
      <span class="wind-lane" data-start="-4,18" data-end="46,47" style="--wind-delay:0s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="104,18" data-end="54,47" style="--wind-delay:-0.48s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="-4,39" data-end="46,49" style="--wind-delay:-0.12s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="104,39" data-end="54,49" style="--wind-delay:-0.6s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="-4,65" data-end="46,51" style="--wind-delay:-0.24s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="104,65" data-end="54,51" style="--wind-delay:-0.72s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="-4,88" data-end="46,53" style="--wind-delay:-0.36s"><i class="wind-streak"></i></span>
      <span class="wind-lane" data-start="104,88" data-end="54,53" style="--wind-delay:-0.84s"><i class="wind-streak"></i></span>
    </div>
    <section id="roll-catch-toast" role="status" aria-live="polite" hidden>
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="24" r="20" fill="#f4da8d"/><path d="M14 24L21 31L35 16" fill="none" stroke="#173c35" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <strong>捕獲成功！</strong><span id="roll-catch-name"></span>
    </section>
    <div class="roll-blower" aria-hidden="true">
      <svg class="blower-idle" viewBox="0 0 180 150" focusable="false">
        <path d="M112 112L141 104L172 135L153 150L124 140Z" fill="#526f73" stroke="#142e35" stroke-width="3"/>
        <path d="M101 96L126 87L144 123L122 135Z" fill="#19333b" stroke="#9cc7c6" stroke-width="2"/>
        <path d="M125 112C113 106 107 116 115 126L131 139L152 123L139 108C133 102 126 106 125 112Z" fill="#a3b6af" stroke="#304e52" stroke-width="3"/>
        <path d="M46 25L80 17L132 70L78 111Z" fill="#426b74" stroke="#142e35" stroke-width="3"/>
        <path d="M53 28L76 24L110 65L86 85Z" fill="#729f9e"/>
        <ellipse cx="65" cy="27" rx="20" ry="10" transform="rotate(-15 65 27)" fill="#c0ebe0" stroke="#20444c" stroke-width="3"/>
        <ellipse cx="106" cy="91" rx="33" ry="28" transform="rotate(-20 106 91)" fill="#203e48" stroke="#9fc7c3" stroke-width="3"/>
        <path d="M91 77L120 103M122 77L90 105M107 64L106 117" stroke="#537f87" stroke-width="5" stroke-linecap="round"/>
        <circle class="blower-lamp" cx="86" cy="58" r="4" fill="#a1d5cb"/>
        <g class="blower-air" fill="none" stroke="#c3fff3" stroke-width="2" stroke-linecap="round">
          <path d="M54 15L42 3M64 12L58 0M76 14L78 2"/>
        </g>
      </svg>
      <div class="blower-held-motion"><img class="blower-held" src="icons/blower-held.svg?v=0.3.17" alt="" width="180" height="150"></div>
    </div>
    <button id="roll-blow" aria-label="押している間だけ風を出す" aria-pressed="false"><span class="roll-blow-hint">長押しで</span><strong>風を出す</strong></button>`;
  document.body.appendChild(panel);
  const dialog = document.createElement('dialog');
  dialog.id = 'roll-book';
  dialog.innerHTML = '<h2>図鑑</h2><div id="roll-entries"></div><p id="roll-save-status"></p>'
    + '<button id="roll-export">記録を書き出す</button><button id="roll-close">閉じる</button>';
  document.body.appendChild(dialog);
  const button = document.getElementById('roll-blow');
  const note = document.getElementById('roll-notice');
  const resetButton = document.getElementById('roll-reset');
  const reacquire = document.getElementById('roll-reacquire');
  const reacquireHelp = document.getElementById('roll-reacquire-help');
  const resetTime = document.getElementById('roll-reset-time');
  const markerLayer = document.getElementById('roll-monster-markers');
  const markerNodes = new Map();
  let markerTick = 0;
  const aim = document.querySelector('.roll-aim');
  const catchToast = document.getElementById('roll-catch-toast');
  const versionNote = document.getElementById('roll-version');
  let pointer = null, blowing = false, tools = false, latest = null, lastCollectionJson = '';
  let collection = {version:1,entries:[]};
  let lastCaptureSequence = null, catchTimer = 0;
  function showCapture(name) {
    document.getElementById('roll-catch-name').textContent = name === 'Mini Creature' ? '仮モンスターをゲット' : name ? name + 'をゲット' : 'ゲットしました';
    catchToast.hidden = false;
    clearTimeout(catchTimer);
    catchTimer = setTimeout(function () { catchToast.hidden = true; }, 1700);
  }
  ['selectstart', 'contextmenu'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (document.body.classList.contains('roll-playing') && event.target && event.target.closest
          && event.target.closest('#roll-controls, .top, #unity-canvas, #camera-canvas')) event.preventDefault();
    });
  });
  function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
  function setFlag(element, name, value) { if (element[name] !== value) element[name] = value; }
  function setAttribute(element, name, value) { if (element.getAttribute(name) !== value) element.setAttribute(name, value); }
  function setClass(element, name, value) { if (element.classList.contains(name) !== value) element.classList.toggle(name, value); }
  function layoutWindLanes() {
    const width = window.innerWidth, height = window.innerHeight;
    panel.querySelectorAll('.wind-lane').forEach(lane => {
      const start = lane.dataset.start.split(',').map(Number), end = lane.dataset.end.split(',').map(Number);
      const dx = (end[0] - start[0]) * width / 100, dy = (end[1] - start[1]) * height / 100;
      const length = Math.hypot(dx, dy), streakWidth = Math.min(32, Math.max(16, length * .1));
      lane.style.left = start[0] + '%'; lane.style.top = start[1] + '%';
      lane.style.width = length.toFixed(2) + 'px';
      lane.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
      lane.style.setProperty('--wind-streak-width', streakWidth.toFixed(2) + 'px');
      lane.style.setProperty('--wind-travel', Math.max(0, length - streakWidth).toFixed(2) + 'px');
      lane.style.setProperty('--wind-rest', (length * .45).toFixed(2) + 'px');
    });
  }
  layoutWindLanes();
  function sizeWindGuide(radius) {
    const size = Number.isFinite(radius) ? Math.max(0, radius) * 2 * window.innerHeight : 0;
    const diameter = size.toFixed(2) + 'px';
    if (panel.style.getPropertyValue('--wind-diameter') !== diameter) panel.style.setProperty('--wind-diameter', diameter);
  }
  function shadeWindGuide(value, force) {
    const unit = n => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    const horizontal = unit(value.windHorizontalStrength);
    const near = unit(value.windAimNearFalloff) * horizontal;
    const far = unit(value.windAimFarFalloff) * horizontal;
    const direction = value.windAimGradient;
    const directional = direction && Number.isFinite(direction.x) && Number.isFinite(direction.y)
      && Math.hypot(direction.x, direction.y) > .00001 && near > far;
    let fill;
    if (force < .01) {
      fill = 'rgba(168, 222, 225, 0.10)';
    } else if (directional) {
      const angle = Math.atan2(direction.x * window.innerWidth, direction.y * window.innerHeight) * 180 / Math.PI;
      // Amplify relative contrast for readability; this does not change physical wind force.
      const nearAlpha = .30 + .46 * Math.sqrt(near);
      const farAlpha = .10 + .16 * Math.sqrt(far);
      const middleAlpha = (nearAlpha + farAlpha) * .5;
      fill = 'linear-gradient(' + angle.toFixed(1) + 'deg, rgba(244, 105, 24, ' + nearAlpha.toFixed(3)
        + ') 0%, rgba(255, 182, 65, ' + middleAlpha.toFixed(3)
        + ') 50%, rgba(255, 244, 205, ' + farAlpha.toFixed(3) + ') 100%)';
    } else {
      fill = 'rgba(255, 190, 80, ' + (.16 + .32 * Math.sqrt(force)).toFixed(3) + ')';
    }
    if (aim.style.getPropertyValue('--wind-fill') !== fill) aim.style.setProperty('--wind-fill', fill);
  }
  window.addEventListener('resize', function () {
    layoutWindLanes();
    sizeWindGuide(latest && latest.windAimScreenRadius);
    if (latest) shadeWindGuide(latest, Math.max(0, Math.min(1, Number(latest.windAimStrength) || 0)));
  });
  function reset() {
    pointer = null; blowing = false; setClass(panel, 'is-blowing', false);
    setAttribute(button, 'aria-pressed', 'false');
  }
  function paused() {
    return tools || dialog.open || document.hidden || (window.RollStartup && RollStartup.pending()) || !latest || !latest.tracking
      || !window.FloorProbeBridge || !FloorProbeBridge.gameIsActive();
  }
  button.addEventListener('pointerdown', function (event) {
    if (paused() || pointer !== null) return;
    event.preventDefault(); pointer = event.pointerId; blowing = true; panel.classList.add('is-blowing');
    button.setPointerCapture(pointer);
    button.setAttribute('aria-pressed','true');
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(function (name) {
    button.addEventListener(name, function (event) { if (event.pointerId === pointer) reset(); });
  });
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('blur', reset);
  document.getElementById('roll-reset').addEventListener('click', function () {
    reset(); FloorProbeBridge.gameCommand('RequestReset');
  });
  document.getElementById('roll-reacquire-button').addEventListener('click', function () {
    reset();
    if (window.FloorProbeBridge && FloorProbeBridge.rereadPaper) FloorProbeBridge.rereadPaper();
  });
  document.getElementById('roll-tools').addEventListener('click', function () {
    reset(); tools = !tools; document.body.classList.toggle('roll-tools-open', tools);
    this.textContent = tools ? '戻る' : 'AR操作';
    this.setAttribute('aria-label', tools ? 'ゲームに戻る' : 'AR操作とバージョン情報');
  });
  document.getElementById('roll-collection').addEventListener('click', function () { reset(); dialog.showModal(); });
  document.getElementById('roll-close').addEventListener('click', function () { dialog.close(); reset(); });
  dialog.addEventListener('cancel', reset);
  document.getElementById('roll-export').addEventListener('click', function () {
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection,null,2)],{type:'application/json'}));
    const link=document.createElement('a'); link.href=url; link.download='roll-by-blow-record.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  });
  function hideMonsterMarkers() { setFlag(markerLayer, 'hidden', true); }
  function updateMonsterMarkers(values, count) {
    if (paused()) { hideMonsterMarkers(); return; }
    setFlag(markerLayer, 'hidden', false);
    markerTick++;
    const length = Math.min(Math.max(0, count | 0), Math.floor(values.length / 4));
    for (let i = 0; i < length; i++) {
      const offset = i * 4, id = values[offset], x = values[offset + 1], y = values[offset + 2], state = values[offset + 3];
      if (!Number.isInteger(id) || id < 0 || !Number.isFinite(x) || !Number.isFinite(y)
          || x < 0 || x > 1 || y < 0 || y > 1 || (state !== 1 && state !== 2)) continue;
      let entry = markerNodes.get(id);
      if (!entry) {
        const element = document.createElement('span');
        element.className = 'roll-monster-mark'; element.setAttribute('role', 'img');
        element.innerHTML = '<svg viewBox="0 0 32 36" aria-hidden="true"><path d="M16 3L28 8V17C28 25 22 30 16 33C10 30 4 25 4 17V8Z" fill="none" stroke="currentColor" stroke-width="3"/></svg><b aria-hidden="true">!</b>';
        markerLayer.appendChild(element); entry = {element, state:0, seen:0}; markerNodes.set(id, entry);
      }
      entry.seen = markerTick; setFlag(entry.element, 'hidden', false);
      if (entry.state !== state) {
        entry.state = state; entry.element.setAttribute('data-state', String(state));
        entry.element.setAttribute('aria-label', state === 2 ? '風が当たっています' : '防御中');
      }
      const left = x * window.innerWidth, top = (1 - y) * window.innerHeight - 7;
      const transform = 'translate(' + left.toFixed(2) + 'px,' + top.toFixed(2) + 'px) translate(-50%,-100%)';
      if (entry.transform !== transform) { entry.transform = transform; entry.element.style.transform = transform; }
    }
    markerNodes.forEach(entry => { if (entry.seen !== markerTick) setFlag(entry.element, 'hidden', true); });
  }
  document.addEventListener('visibilitychange', hideMonsterMarkers);
  window.addEventListener('blur', hideMonsterMarkers);
  window.RollCaptureBridge = {
    suspend: function () { reset(); hideMonsterMarkers(); },
    markers: updateMonsterMarkers,
    snapshot: function () { return {report: latest, blowing: blowing, paused: paused()}; },
    readControls: function () { if (paused()) { reset(); hideMonsterMarkers(); return [0,0,1]; } return [blowing?1:0,0,0]; },
    report: function (value) {
      if (value.gameplayRevision !== '0.3.13') {
        reset();
        if (window.RollStartup) RollStartup.fail('ゲーム本体と画面の版が一致しません。同じビルド一式を公開してください。',
          'Expected gameplay 0.3.13; received ' + String(value.gameplayRevision), 'boot', true);
        return;
      }
      if (value.message === 'recovered' && (!latest || latest.message !== 'recovered')) reset();
      const sequence = Number.isInteger(value.captureSequence) && value.captureSequence >= 0 ? value.captureSequence : null;
      const newlyCaught = sequence !== null && lastCaptureSequence !== null && sequence > lastCaptureSequence;
      // Consume the event counter even while unplaced; rereading must not replay an old catch.
      if (sequence !== null) lastCaptureSequence = sequence;
      latest = value;
      setFlag(panel, 'hidden', !value.placed);
      setClass(document.body, 'roll-playing', !!value.placed);
      if (!value.placed) {
        catchToast.hidden = true; clearTimeout(catchTimer); reacquire.hidden = true;
        reset(); tools = false; document.body.classList.remove('roll-tools-open');
        document.getElementById('roll-tools').textContent = 'AR操作';
        if (dialog.open) dialog.close();
      }
      if (!value.tracking) { reset(); hideMonsterMarkers(); }
      if (value.placed && newlyCaught) showCapture(value.lastCaughtName);
      const isPaused = paused();
      if (isPaused) reset();
      setFlag(button, 'disabled', isPaused);
      const resetSeconds = Math.max(0, Math.ceil(Number(value.resetCooldownRemaining) || 0));
      setFlag(resetButton, 'disabled', isPaused || resetSeconds > 0);
      setFlag(resetTime, 'hidden', resetSeconds <= 0);
      setText(resetTime, resetSeconds ? resetSeconds + '秒' : '');
      setAttribute(resetButton, 'aria-label', resetSeconds ? '復帰はあと' + resetSeconds + '秒で使用できます' : '球と未捕獲モンスターを初期位置に戻す');
      const hasAim = !isPaused && value.windAimVisible === true;
      setClass(panel, 'has-wind-aim', hasAim);
      const radius = hasAim && Number.isFinite(value.windAimScreenRadius) ? Math.max(0, value.windAimScreenRadius) : 0;
      sizeWindGuide(radius);
      setFlag(aim, 'hidden', radius <= 0);
      const force = hasAim && Number.isFinite(value.windAimStrength) ? Math.max(0, Math.min(1, value.windAimStrength)) : 0;
      if (hasAim) shadeWindGuide(value, force);
      if (versionNote) {
        const arVersion = window.FloorProbeBridge && FloorProbeBridge.webRevision || '従来モード';
        const versions = 'ゲーム ' + (value.gameplayRevision || '—') + ' / AR接続 ' + arVersion + ' / 画面 0.3.18';
        if (versionNote.textContent !== versions) versionNote.textContent = versions;
      }
      const needsPaper = window.FloorProbeBridge && FloorProbeBridge.paperNeedsView && FloorProbeBridge.paperNeedsView();
      const rotationHint = window.FloorProbeBridge && FloorProbeBridge.paperRotationHint ? FloorProbeBridge.paperRotationHint() : '';
      const recovery = window.FloorProbeBridge && FloorProbeBridge.reacquisitionState ? FloorProbeBridge.reacquisitionState() : null;
      setFlag(reacquire, 'hidden', !value.placed || !recovery || !recovery.canReread);
      if (recovery && reacquireHelp.textContent !== recovery.detail) reacquireHelp.textContent = recovery.detail;
      const nextNotice = recovery && recovery.message ? recovery.message : rotationHint ? rotationHint : !value.tracking || needsPaper ? '用紙の枠全体を映してください'
        : value.message === 'spawn-blocked' ? '出現場所を待っています。初期位置に戻せます'
        : value.message === 'caught' && !catchToast.hidden ? '捕獲成功！'
        : value.message === 'wind-guard' ? 'モンスターは風を嫌がっている'
        : value.message === 'recovered' ? '球と未捕獲のモンスターを初期位置に戻しました'
        : value.message === 'guard' ? 'モンスターは防御中だ'
        : value.guarding ? 'モンスターは防御中だ'
        : value.blowing && value.windHorizontalStrength < .01 ? 'もう少し傾けてみよう'
        : '端末の背面から風を出そう';
      if (note.textContent !== nextNotice) note.textContent = nextNotice;
      if (value.collectionJson !== lastCollectionJson) {
        try { collection = JSON.parse(value.collectionJson); } catch (_) { return; }
        lastCollectionJson = value.collectionJson;
        const entries = document.getElementById('roll-entries'); entries.replaceChildren();
        const list = Array.isArray(collection.entries) ? collection.entries : [];
        if (!list.length) entries.textContent = 'まだ捕獲していません。';
        list.forEach(function (entry) {
          const row=document.createElement('p');
          row.textContent=(entry.name==='Mini Creature'?'仮モンスター':entry.name)+'：'+entry.count+'匹';
          entries.appendChild(row);
        });
      }
      setText(document.getElementById('roll-save-status'), value.saveOk
        ? '記録はこの端末のSafariに保存されます。' : '端末内保存を確認できません。記録を書き出してください。');
    }
  };
}());
