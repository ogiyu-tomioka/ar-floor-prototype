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
  const start = document.getElementById('start-camera');
  const turn = document.getElementById('turn');
  const defend = document.getElementById('defend');
  let camera = null, deadline = 0, found = false;

  const scanText = face ? '前面カメラに顔全体を映してください。' : '観察用紙の全体を映してください。';
  const foundText = face ? '顔をゆっくり動かして、耳や頬の模様を見てみよう。'
    : 'スマホをゆっくり動かして観察しよう。ボタンで向きやポーズも変えられます。';

  if (face) {
    const title = 'モンスターに変身';
    document.title = title + ' | Roll-by-Blow';
    document.getElementById('title').textContent = title;
    document.getElementById('live-title').textContent = title;
    document.getElementById('eyebrow').textContent = 'FIELD NOTE / EXTRA';
    document.getElementById('intro-text').textContent = '前面カメラに顔を映すと、ミニモンスターの耳と頬の模様が現れます。顔を動かして変身を楽しもう。';
    document.getElementById('engine-label').textContent = 'MindAR.js / 顔追跡';
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
    if (camera) {
      // Removing the frame also releases the tracking worker and any pending camera request.
      camera.remove();
      camera = null;
    }
    found = false;
    turn.disabled = defend.disabled = true;
    intro.hidden = false;
    live.hidden = true;
    status.textContent = message;
  }

  function begin() {
    if (camera || document.hidden) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      status.textContent = 'HTTPSの公開URLをSafariで開いてください。';
      return;
    }
    status.textContent = '';
    intro.hidden = true;
    live.hidden = false;
    phase.textContent = '起動中';
    hint.textContent = 'カメラを準備しています。Safariの確認が出たら許可してください。';
    camera = document.createElement('iframe');
    camera.title = face ? '変身カメラ' : '観察カメラ';
    camera.allow = 'camera';
    camera.src = 'camera.html?v=0.3.25' + (face ? '&mode=face' : '');
    host.appendChild(camera);
    deadline = setTimeout(() => {
      stop('カメラまたは認識データの準備に時間がかかっています。Safariのカメラ許可と通信を確認して、もう一度始めてください。');
    }, 35000);
  }

  window.addEventListener('message', event => {
    if (!camera || event.origin !== location.origin || event.source !== camera.contentWindow) return;
    const message = event.data;
    if (!message || message.channel !== 'rbb-observation-camera') return;
    if (message.kind === 'error') {
      stop('カメラを始められませんでした。Safariのカメラ許可と通信を確認して、もう一度始めてください。');
      return;
    }
    if (!['scanning', 'found', 'lost'].includes(message.kind)) return;
    clearTimeout(deadline);
    found = message.kind === 'found';
    phase.textContent = found ? (face ? '変身中' : '観察中') : '探しています';
    hint.textContent = found ? foundText : scanText;
    turn.disabled = defend.disabled = !found;
  });

  function pose(action) {
    if (!camera || !found || face) return;
    camera.contentWindow.postMessage({channel:'rbb-observation-controls', action}, location.origin);
  }

  start.addEventListener('click', begin);
  turn.addEventListener('click', () => pose('turn'));
  defend.addEventListener('click', () => pose('defend'));
  document.getElementById('stop-camera').addEventListener('click', () => stop());
  window.addEventListener('pagehide', () => stop());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && camera) stop('観察を再開するには、もう一度カメラを始めてください。');
  });
  if (!face && query.get('entry') === 'paper') begin();
}());
