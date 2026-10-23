(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'roll-controls'; panel.hidden = true;
  panel.innerHTML = '<div class="roll-hud"><span id="roll-notice">中央で狙い、スマホの上端で風向きを変えよう</span>'
    + '<button id="roll-reset">初期位置に戻す</button><button id="roll-collection">図鑑</button>'
    + '<button id="roll-tools">AR操作</button></div>'
    + '<button id="roll-blow" aria-label="押している間だけ風を出す" aria-pressed="false">押して風を出す</button>';
  document.body.appendChild(panel);
  const dialog = document.createElement('dialog');
  dialog.id = 'roll-book';
  dialog.innerHTML = '<h2>図鑑</h2><div id="roll-entries"></div><p id="roll-save-status"></p>'
    + '<button id="roll-export">記録を書き出す</button><button id="roll-close">閉じる</button>';
  document.body.appendChild(dialog);
  const button = document.getElementById('roll-blow');
  const note = document.getElementById('roll-notice');
  let pointer = null, blowing = false, tools = false, latest = null, lastCollectionJson = '';
  let collection = {version:1,entries:[]};
  function reset() {
    pointer = null; blowing = false;
    button.setAttribute('aria-pressed','false'); button.textContent = '押して風を出す';
  }
  function paused() {
    return tools || dialog.open || document.hidden || !latest || !latest.tracking
      || !window.FloorProbeBridge || !FloorProbeBridge.gameIsActive();
  }
  button.addEventListener('pointerdown', function (event) {
    if (paused() || pointer !== null) return;
    event.preventDefault(); pointer = event.pointerId; blowing = true;
    button.setPointerCapture(pointer);
    button.setAttribute('aria-pressed','true'); button.textContent = '風を出しています';
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(function (name) {
    button.addEventListener(name, function (event) { if (event.pointerId === pointer) reset(); });
  });
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('blur', reset);
  document.getElementById('roll-reset').addEventListener('click', function () {
    reset(); FloorProbeBridge.gameCommand('ResetBall');
  });
  document.getElementById('roll-tools').addEventListener('click', function () {
    reset(); tools = !tools; document.body.classList.toggle('roll-tools-open', tools);
    this.textContent = tools ? 'ゲームに戻る' : 'AR操作';
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
    snapshot: function () { return {report: latest, blowing: blowing, paused: paused()}; },
    readControls: function () { if (paused()) { reset(); return [0,0,1]; } return [blowing?1:0,0,0]; },
    report: function (value) {
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
      note.textContent = !value.tracking ? (window.FloorProbeBridge && FloorProbeBridge.trackingHint ? FloorProbeBridge.trackingHint() : '追跡を待っています')
        : value.message === 'spawn-blocked' ? '出現場所を待っています。初期位置に戻せます'
        : value.message === 'caught' ? '捕獲成功！'
        : value.message === 'wind-guard' ? 'モンスターに直接風が当たった！ しばらく防御するよ'
        : value.message === 'recovered' ? '球と未捕獲のモンスターを初期位置に戻しました'
        : value.message === 'guard' ? '防御された！ 青くないときを狙おう'
        : value.guarding ? '青いモンスターは防御中。風は球へ当てよう'
        : '中央で狙い、スマホの上端で風向きを変えよう';
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
