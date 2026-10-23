(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'roll-controls'; panel.hidden = true;
  panel.innerHTML = `<p id="roll-notice" role="status">端末の背面から風を出そう</p>
    <button id="roll-reset" aria-label="球と未捕獲モンスターを初期位置に戻す"><span>復帰</span><small id="roll-reset-time" hidden></small></button>
    <nav class="roll-toolbar" aria-label="ゲーム操作">
      <button id="roll-collection">図鑑</button><button id="roll-tools">AR操作</button>
    </nav>
    <div id="roll-monster-markers" aria-label="モンスターの状態"></div>
    <div class="roll-aim" aria-hidden="true"><span class="roll-aim-dot"></span></div>
    <svg class="roll-airflow" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
        <path d="M12 82L38 60"/><path d="M88 82L62 60"/>
        <path d="M15 18L38 40"/><path d="M85 18L62 40"/>
      </g>
    </svg>
    <section id="roll-catch-toast" role="status" aria-live="polite" hidden>
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="24" r="20" fill="#f4da8d"/><path d="M14 24L21 31L35 16" fill="none" stroke="#173c35" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <strong>捕獲成功！</strong><span id="roll-catch-name"></span>
    </section>
    <div class="roll-blower" aria-hidden="true">
      <svg viewBox="0 0 180 150" focusable="false">
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
      <span class="roll-camera-hint">背面から中央へ送風</span>
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
  const resetTime = document.getElementById('roll-reset-time');
  const markerLayer = document.getElementById('roll-monster-markers');
  const markerNodes = new Map();
  let markerTick = 0;
  const aim = document.querySelector('.roll-aim');
  const catchToast = document.getElementById('roll-catch-toast');
  const versionNote = document.getElementById('roll-version');
  let pointer = null, blowing = false, tools = false, latest = null, lastCollectionJson = '';
  let collection = {version:1,entries:[]};
  let lastCaptureSequence = 0, catchTimer = 0;
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
  function sizeWindGuide(radius) {
    const size = Number.isFinite(radius) ? Math.max(0, radius) * 2 * window.innerHeight : 0;
    panel.style.setProperty('--wind-diameter', size.toFixed(2) + 'px');
  }
  function shadeWindGuide(value, force) {
    const unit = n => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    const horizontal = unit(value.windHorizontalStrength);
    const near = unit(value.windAimNearFalloff) * horizontal;
    const far = unit(value.windAimFarFalloff) * horizontal;
    const direction = value.windAimGradient;
    const directional = direction && Number.isFinite(direction.x) && Number.isFinite(direction.y)
      && Math.hypot(direction.x, direction.y) > .00001 && near - far > .001;
    let fill;
    if (force < .01) {
      fill = 'rgba(168, 222, 225, 0.10)';
    } else if (directional) {
      const angle = Math.atan2(direction.x * window.innerWidth, direction.y * window.innerHeight) * 180 / Math.PI;
      const nearAlpha = (.26 + .42 * Math.sqrt(near)).toFixed(3);
      const farAlpha = (.08 + .14 * Math.sqrt(far)).toFixed(3);
      fill = 'linear-gradient(' + angle.toFixed(1) + 'deg, rgba(255, 135, 35, ' + nearAlpha
        + ') 0%, rgba(255, 239, 176, ' + farAlpha + ') 100%)';
    } else {
      fill = 'rgba(255, 190, 80, ' + (.16 + .32 * Math.sqrt(force)).toFixed(3) + ')';
    }
    aim.style.setProperty('--wind-fill', fill);
  }
  window.addEventListener('resize', function () {
    sizeWindGuide(latest && latest.windAimScreenRadius);
    if (latest) shadeWindGuide(latest, Math.max(0, Math.min(1, Number(latest.windAimStrength) || 0)));
  });
  function reset() {
    pointer = null; blowing = false; panel.classList.remove('is-blowing');
    button.setAttribute('aria-pressed','false');
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
  function hideMonsterMarkers() { markerLayer.hidden = true; }
  function updateMonsterMarkers(values, count) {
    if (paused()) { hideMonsterMarkers(); return; }
    markerLayer.hidden = false;
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
      entry.seen = markerTick; entry.element.hidden = false;
      if (entry.state !== state) {
        entry.state = state; entry.element.setAttribute('data-state', String(state));
        entry.element.setAttribute('aria-label', state === 2 ? '風が当たっています' : '防御中');
      }
      const left = x * window.innerWidth, top = (1 - y) * window.innerHeight - 7;
      entry.element.style.transform = 'translate(' + left.toFixed(2) + 'px,' + top.toFixed(2) + 'px) translate(-50%,-100%)';
    }
    markerNodes.forEach(entry => { if (entry.seen !== markerTick) entry.element.hidden = true; });
  }
  document.addEventListener('visibilitychange', hideMonsterMarkers);
  window.addEventListener('blur', hideMonsterMarkers);
  window.RollCaptureBridge = {
    suspend: function () { reset(); hideMonsterMarkers(); },
    markers: updateMonsterMarkers,
    snapshot: function () { return {report: latest, blowing: blowing, paused: paused()}; },
    readControls: function () { if (paused()) { reset(); hideMonsterMarkers(); return [0,0,1]; } return [blowing?1:0,0,0]; },
    report: function (value) {
      if (value.gameplayRevision !== '0.3.12') {
        reset();
        if (window.RollStartup) RollStartup.fail('ゲーム本体と画面の版が一致しません。同じビルド一式を公開してください。',
          'Expected gameplay 0.3.12; received ' + String(value.gameplayRevision), 'boot', true);
        return;
      }
      if (value.message === 'recovered' && (!latest || latest.message !== 'recovered')) reset();
      latest = value;
      panel.hidden = !value.placed;
      document.body.classList.toggle('roll-playing', !!value.placed);
      if (!value.placed) {
        catchToast.hidden = true; lastCaptureSequence = 0;
        reset(); tools = false; document.body.classList.remove('roll-tools-open');
        document.getElementById('roll-tools').textContent = 'AR操作';
        if (dialog.open) dialog.close();
      }
      if (!value.tracking) { reset(); hideMonsterMarkers(); }
      if (value.placed && Number.isInteger(value.captureSequence) && value.captureSequence > 0
          && value.captureSequence !== lastCaptureSequence) {
        lastCaptureSequence = value.captureSequence; showCapture(value.lastCaughtName);
      }
      button.disabled = paused();
      const resetSeconds = Math.max(0, Math.ceil(Number(value.resetCooldownRemaining) || 0));
      resetButton.disabled = paused() || resetSeconds > 0;
      resetTime.hidden = resetSeconds <= 0;
      resetTime.textContent = resetSeconds ? resetSeconds + '秒' : ''; 
      resetButton.setAttribute('aria-label', resetSeconds ? '復帰はあと' + resetSeconds + '秒で使用できます' : '球と未捕獲モンスターを初期位置に戻す');
      const hasAim = !paused() && value.windAimVisible === true;
      panel.classList.toggle('has-wind-aim', hasAim);
      const radius = hasAim && Number.isFinite(value.windAimScreenRadius) ? Math.max(0, value.windAimScreenRadius) : 0;
      sizeWindGuide(radius);
      aim.hidden = radius <= 0;
      const force = hasAim && Number.isFinite(value.windAimStrength) ? Math.max(0, Math.min(1, value.windAimStrength)) : 0;
      shadeWindGuide(value, force);
      if (versionNote) {
        let arVersion = '—';
        try { arVersion = JSON.parse(document.getElementById('metrics').textContent).webRevision || '従来モード'; } catch (_) {}
        const versions = 'ゲーム ' + (value.gameplayRevision || '—') + ' / AR接続 ' + arVersion + ' / 画面 0.3.12';
        if (versionNote.textContent !== versions) versionNote.textContent = versions;
      }
      const needsPaper = window.FloorProbeBridge && FloorProbeBridge.paperNeedsView && FloorProbeBridge.paperNeedsView();
      const nextNotice = !value.tracking || needsPaper ? '用紙の枠全体を映してください'
        : value.message === 'spawn-blocked' ? '出現場所を待っています。初期位置に戻せます'
        : value.message === 'caught' ? '捕獲成功！'
        : value.message === 'wind-guard' ? 'モンスターに直接風が当たった！ しばらく防御するよ'
        : value.message === 'recovered' ? '球と未捕獲のモンスターを初期位置に戻しました'
        : value.message === 'guard' ? '防御された！ 青くないときを狙おう'
        : value.guarding ? '青いモンスターは防御中。風は球へ当てよう'
        : value.blowing && value.windHorizontalStrength < .01 ? '真下付近では横へ押せません。少し傾けてみよう'
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
      document.getElementById('roll-save-status').textContent=value.saveOk
        ? '記録はこの端末のSafariに保存されます。' : '端末内保存を確認できません。記録を書き出してください。';
    }
  };
}());
