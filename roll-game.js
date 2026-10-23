(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'roll-controls'; panel.hidden = true;
  panel.innerHTML = `<p id="roll-notice" role="status">背面カメラで球を狙い、斜めに吹こう</p>
    <div class="roll-telemetry">
      <div class="roll-power-label"><span>球を押す力</span><span id="roll-power-value">—</span></div>
      <meter id="roll-power-meter" min="0" max="1" value="0" aria-label="照準位置で球を横へ押す力"></meter>
      <small id="roll-wind-legend">丸は風の広がり・矢印は押す向き</small>
    </div>
    <nav class="roll-toolbar" aria-label="ゲーム操作">
      <button id="roll-reset" aria-label="球と未捕獲モンスターを初期位置に戻す">復帰</button>
      <button id="roll-collection">図鑑</button><button id="roll-tools">AR操作</button>
    </nav>
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
    <button id="roll-blow" aria-label="押している間だけ風を出す" aria-pressed="false">押して風を出す</button>`;
  document.body.appendChild(panel);
  const dialog = document.createElement('dialog');
  dialog.id = 'roll-book';
  dialog.innerHTML = '<h2>図鑑</h2><div id="roll-entries"></div><p id="roll-save-status"></p>'
    + '<button id="roll-export">記録を書き出す</button><button id="roll-close">閉じる</button>';
  document.body.appendChild(dialog);
  const button = document.getElementById('roll-blow');
  const note = document.getElementById('roll-notice');
  const resetButton = document.getElementById('roll-reset');
  const powerMeter = document.getElementById('roll-power-meter');
  const powerValue = document.getElementById('roll-power-value');
  const windLegend = document.getElementById('roll-wind-legend');
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
  window.addEventListener('resize', function () { sizeWindGuide(latest && latest.windAimScreenRadius); });
  function reset() {
    pointer = null; blowing = false; panel.classList.remove('is-blowing');
    button.setAttribute('aria-pressed','false'); button.textContent = '押して風を出す';
  }
  function paused() {
    return tools || dialog.open || document.hidden || (window.RollStartup && RollStartup.pending()) || !latest || !latest.tracking
      || !window.FloorProbeBridge || !FloorProbeBridge.gameIsActive();
  }
  button.addEventListener('pointerdown', function (event) {
    if (paused() || pointer !== null) return;
    event.preventDefault(); pointer = event.pointerId; blowing = true; panel.classList.add('is-blowing');
    button.setPointerCapture(pointer);
    button.setAttribute('aria-pressed','true'); button.textContent = '風を出しています';
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
  window.RollCaptureBridge = {
    suspend: reset,
    snapshot: function () { return {report: latest, blowing: blowing, paused: paused()}; },
    readControls: function () { if (paused()) { reset(); return [0,0,1]; } return [blowing?1:0,0,0]; },
    report: function (value) {
      if (value.gameplayRevision !== '0.3.10') {
        reset();
        if (window.RollStartup) RollStartup.fail('ゲーム本体と画面の版が一致しません。同じビルド一式を公開してください。',
          'Expected gameplay 0.3.10; received ' + String(value.gameplayRevision), 'boot', true);
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
      if (!value.tracking) reset();
      if (value.placed && Number.isInteger(value.captureSequence) && value.captureSequence > 0
          && value.captureSequence !== lastCaptureSequence) {
        lastCaptureSequence = value.captureSequence; showCapture(value.lastCaughtName);
      }
      button.disabled = paused();
      const resetSeconds = Math.max(0, Math.ceil(Number(value.resetCooldownRemaining) || 0));
      resetButton.disabled = paused() || resetSeconds > 0;
      resetButton.textContent = resetSeconds ? '復帰 ' + resetSeconds + '秒' : '復帰';
      resetButton.setAttribute('aria-label', resetSeconds ? '復帰はあと' + resetSeconds + '秒で使用できます' : '球と未捕獲モンスターを初期位置に戻す');
      const hasAim = !paused() && value.windAimVisible === true;
      panel.classList.toggle('has-wind-aim', hasAim);
      const radius = hasAim && Number.isFinite(value.windAimScreenRadius) ? Math.max(0, value.windAimScreenRadius) : 0;
      sizeWindGuide(radius);
      aim.hidden = radius <= 0;
      const force = hasAim && Number.isFinite(value.windAimStrength) ? Math.max(0, Math.min(1, value.windAimStrength)) : 0;
      powerMeter.value = force;
      powerValue.textContent = hasAim ? Math.round(force * 100) + '%' : '—';
      windLegend.textContent = hasAim ? '丸は風の広がり・矢印は押す向き' : '背面カメラを床へ向けよう';
      if (versionNote) {
        let arVersion = '—';
        try { arVersion = JSON.parse(document.getElementById('metrics').textContent).webRevision || '従来モード'; } catch (_) {}
        const versions = 'ゲーム ' + (value.gameplayRevision || '—') + ' / AR接続 ' + arVersion + ' / 画面 0.3.10';
        if (versionNote.textContent !== versions) versionNote.textContent = versions;
      }
      const nextNotice = !value.tracking ? (window.FloorProbeBridge && FloorProbeBridge.trackingHint ? FloorProbeBridge.trackingHint() : '追跡を待っています')
        : value.message === 'spawn-blocked' ? '出現場所を待っています。初期位置に戻せます'
        : value.message === 'caught' ? '捕獲成功！'
        : value.message === 'wind-guard' ? 'モンスターに直接風が当たった！ しばらく防御するよ'
        : value.message === 'recovered' ? '球と未捕獲のモンスターを初期位置に戻しました'
        : value.message === 'guard' ? '防御された！ 青くないときを狙おう'
        : value.guarding ? '青いモンスターは防御中。風は球へ当てよう'
        : value.blowing && value.windHorizontalStrength < .01 ? '真下付近では横へ押せません。少し傾けてみよう'
        : '背面カメラで球を狙い、斜めに吹こう';
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
