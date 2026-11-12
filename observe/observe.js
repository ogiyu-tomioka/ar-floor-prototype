(function () {
  'use strict';
  const query = new URLSearchParams(location.search);
  const face = query.get('mode') === 'face';
  const host = document.getElementById('camera-host');
  const intro = document.getElementById('intro');
  const live = document.getElementById('live-panel');
  const status = document.getElementById('status');
  const phase = document.getElementById('phase');
  const hint = document.getElementById('live-hint');
  const loading = document.getElementById('live-loading');
  const start = document.getElementById('start-camera');
  const turn = document.getElementById('turn');
  const defend = document.getElementById('defend');
  const diagnostic = document.getElementById('save-observation-diagnostic');
  const events = [];
  let camera = null, deadline = 0, tracking = 'idle', startedAt = 0;

  const scanText = face ? 'スマホを少し離し、顔と肩を映してください。' : '観察用紙の全体を映してください。';
  const foundText = face ? '肩が入るようにスマホを構えてみよう。肩が画面から外れると、モンスターは頭の上に移ります。'
    : 'スマホをゆっくり動かして観察しよう。ボタンで向きやポーズも変えられます。';

  if (face) {
    const title = 'モンスターに変身';
    document.title = title + ' | Roll-by-Blow';
    document.getElementById('title').textContent = title;
    document.getElementById('live-title').textContent = title;
    document.getElementById('eyebrow').textContent = 'FIELD NOTE / EXTRA';
    document.getElementById('intro-text').textContent = '前面カメラに顔と肩を映して変身しよう。顔に耳と頬の模様がつき、ミニモンスターが肩に乗ります。';
    document.getElementById('engine-label').textContent = 'MindAR.js / 顔追跡 · 0.3.31';
    document.getElementById('print-link').hidden = true;
    document.getElementById('pose-controls').hidden = true;
    for (const id of ['alternate-link', 'live-alternate']) {
      const link = document.getElementById(id);
      link.href = './';
      link.textContent = 'モンスター観察へ';
    }
  }

  function stop(message = '') {
    clearTimeout(deadline);
    deadline = 0;
    const previous = camera;
    camera = null;
    tracking = 'idle';
    // Removing the frame releases this attempt's camera and tracking resources.
    if (previous) previous.remove();
    turn.disabled = defend.disabled = true;
    intro.hidden = false;
    live.hidden = true;
    loading.hidden = true;
    status.textContent = message;
    diagnostic.hidden = !events.length;
  }

  function begin() {
    if (camera || document.hidden) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      status.textContent = 'HTTPSの公開URLをSafariで開いてください。';
      return;
    }
    status.textContent = '';
    events.length = 0;
    tracking = 'starting';
    startedAt = performance.now();
    record('start');
    intro.hidden = true;
    live.hidden = false;
    loading.hidden = false;
    phase.textContent = '起動中';
    hint.textContent = 'カメラを準備しています。Safariの確認が出たら許可してください。';
    camera = document.createElement('iframe');
    camera.title = face ? '変身カメラ' : '観察カメラ';
    camera.allow = 'camera';
    camera.src = 'camera.html?v=0.3.29' + (face ? '&mode=face' : '');
    host.appendChild(camera);
    setDeadline(camera, 35000);
  }

  function record(kind, detail) {
    events.push({time:new Date().toISOString(),elapsedMs:Math.round(performance.now()-startedAt),kind,detail});
    if (events.length>50) events.shift();
  }

  function setDeadline(attempt, delay) {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (camera !== attempt) return;
      record('timeout',{tracking});
      stop(tracking === 'video' ? '前面カメラは映りましたが、顔追跡の準備が時間内に終わりませんでした。もう一度始めてください。'
        : 'カメラまたは認識データの準備に時間がかかっています。Safariのカメラ許可と通信を確認してください。');
    },delay);
  }

  window.addEventListener('message', event => {
    if (!camera || event.origin !== location.origin || event.source !== camera.contentWindow) return;
    const message = event.data;
    if (!message || message.channel !== 'rbb-observation-camera') return;
    if (!['progress','video','scanning','found','lost','error'].includes(message.kind)) return;
    record(message.kind,message.detail);
    if (message.kind === 'progress') return;
    if (message.kind === 'video') {
      if (!face || tracking !== 'starting') return;
      tracking = 'video';
      phase.textContent = '顔追跡を準備中';
      hint.textContent = '前面カメラが映りました。顔を追跡するためのデータを準備しています。';
      setDeadline(camera, 45000);
      return;
    }
    if (message.kind === 'error') {
      const wasLive = tracking === 'scanning' || tracking === 'found';
      stop(wasLive ? 'カメラまたは追跡が止まりました。もう一度始めてください。'
        : tracking === 'video' || message.detail?.error === 'FACE_INIT' ? '顔追跡を始められませんでした。通信を確認して、もう一度始めてください。'
        : 'カメラを始められませんでした。Safariのカメラ許可と通信を確認して、もう一度始めてください。');
      return;
    }
    if (message.kind === 'lost' && tracking !== 'found' ||
        message.kind === 'scanning' && tracking === 'found') return;
    clearTimeout(deadline);
    deadline = 0;
    const found = message.kind === 'found';
    tracking = found ? 'found' : 'scanning';
    loading.hidden = true;
    phase.textContent = found ? (face ? '変身中' : '観察中') : '探しています';
    hint.textContent = found ? foundText : scanText;
    turn.disabled = defend.disabled = !found;
  });

  function pose(action) {
    if (!camera || tracking !== 'found' || face) return;
    camera.contentWindow.postMessage({channel:'rbb-observation-controls', action}, location.origin);
  }

  start.addEventListener('click', begin);
  turn.addEventListener('click', () => pose('turn'));
  defend.addEventListener('click', () => pose('defend'));
  document.getElementById('stop-camera').addEventListener('click', () => stop());
  diagnostic.addEventListener('click', () => {
    const data={revision:'0.3.31',mode:face?'face':'observation',page:location.href,userAgent:navigator.userAgent,events};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link=document.createElement('a');
    link.href=url;
    link.download='roll-by-blow-'+data.mode+'-'+Date.now()+'.json';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  });
  window.addEventListener('pagehide', () => stop());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && camera && (tracking === 'scanning' || tracking === 'found')) {
      stop('再開するには、もう一度カメラを始めてください。');
    }
  });
  if (!face && query.get('entry') === 'paper') begin();
}());
