(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'roll-controls'; panel.hidden = true;
  panel.innerHTML = `<p id="roll-notice" role="status">中央で狙い、傾けて風向きを変えよう</p>
    <div class="roll-telemetry">
      <div class="roll-power-label"><span>照準の押す力</span><span id="roll-power-value">—</span></div>
      <meter id="roll-power-meter" min="0" max="1" value="0" aria-label="照準位置で球を横へ押す力"></meter>
      <small id="roll-wind-legend">濃い橙から淡い黄へ弱まる</small>
    </div>
    <nav class="roll-toolbar" aria-label="ゲーム操作">
      <button id="roll-reset" aria-label="球と未捕獲モンスターを初期位置に戻す">復帰</button>
      <button id="roll-collection">図鑑</button><button id="roll-tools">AR操作</button>
    </nav>
    <div class="roll-blower" aria-hidden="true">
      <svg viewBox="0 0 180 150" focusable="false">
        <g class="blower-air" fill="none" stroke="#ffe2a0" stroke-width="3" stroke-linecap="round">
          <path d="M28 22L13 9M37 16L29 3M21 32L5 27"/>
        </g>
        <path d="M91 109L128 100L163 133L144 150L105 139Z" fill="#45656a" stroke="#142e35" stroke-width="3"/>
        <path d="M92 80L115 74L133 112L111 124Z" fill="#192f38" stroke="#82a5a5" stroke-width="2"/>
        <path d="M112 107C102 104 98 113 104 122L120 135L140 118L128 102C122 96 115 99 112 107Z" fill="#9baca7" stroke="#304e52" stroke-width="3"/>
        <path d="M34 24L88 49L76 76L21 42Z" fill="#547b83" stroke="#142e35" stroke-width="3"/>
        <path d="M27 27L35 21L43 29L33 46L23 43Z" fill="#a1d5cb" stroke="#183a41" stroke-width="2"/>
        <path d="M73 44C88 34 117 39 130 55C144 72 132 96 113 101L78 89C65 80 61 56 73 44Z" fill="#315b65" stroke="#142e35" stroke-width="3"/>
        <circle cx="105" cy="67" r="22" fill="#183941" stroke="#6c9b9e" stroke-width="3"/>
        <path d="M94 53L113 79M119 56L91 75M104 48L105 85" stroke="#527b82" stroke-width="5" stroke-linecap="round"/>
        <circle class="blower-lamp" cx="80" cy="58" r="4" fill="#a1d5cb"/>
        <path d="M51 40L69 48" stroke="#b5e3d7" stroke-width="3" stroke-linecap="round"/>
      </svg>
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
  const versionNote = document.getElementById('roll-version');
  let pointer = null, blowing = false, tools = false, latest = null, lastCollectionJson = '';
  let collection = {version:1,entries:[]};
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
      if (value.gameplayRevision !== '0.3.9') {
        reset();
        if (window.RollStartup) RollStartup.fail('ゲーム本体と画面の版が一致しません。同じビルド一式を公開してください。',
          'Expected gameplay 0.3.9; received ' + String(value.gameplayRevision), 'boot', true);
        return;
      }
      if (value.message === 'recovered' && (!latest || latest.message !== 'recovered')) reset();
      latest = value;
      panel.hidden = !value.placed;
      document.body.classList.toggle('roll-playing', !!value.placed);
      if (!value.placed) {
        reset(); tools = false; document.body.classList.remove('roll-tools-open');
        document.getElementById('roll-tools').textContent = 'AR操作';
        if (dialog.open) dialog.close();
      }
      if (!value.tracking) reset();
      button.disabled = paused();
      const resetSeconds = Math.max(0, Math.ceil(Number(value.resetCooldownRemaining) || 0));
      resetButton.disabled = paused() || resetSeconds > 0;
      resetButton.textContent = resetSeconds ? '復帰 ' + resetSeconds + '秒' : '復帰';
      resetButton.setAttribute('aria-label', resetSeconds ? '復帰はあと' + resetSeconds + '秒で使用できます' : '球と未捕獲モンスターを初期位置に戻す');
      const hasAim = !paused() && value.windAimVisible === true;
      const force = hasAim && Number.isFinite(value.windAimStrength) ? Math.max(0, Math.min(1, value.windAimStrength)) : 0;
      powerMeter.value = force;
      powerValue.textContent = hasAim ? Math.round(force * 100) + '%' : '—';
      windLegend.textContent = hasAim ? '近い側 ' + Math.round(value.windAimNearFalloff * 100) + '% → 遠い側 ' + Math.round(value.windAimFarFalloff * 100) + '%' : '風が届く床を狙おう';
      if (versionNote) {
        let arVersion = '—';
        try { arVersion = JSON.parse(document.getElementById('metrics').textContent).webRevision || '従来モード'; } catch (_) {}
        const versions = 'ゲーム ' + (value.gameplayRevision || '—') + ' / AR接続 ' + arVersion + ' / 画面 0.3.9';
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
        : '中央で狙い、傾けて風向きを変えよう';
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
