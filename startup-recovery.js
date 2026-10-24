(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'roll-recovery'; panel.hidden = true;
  panel.setAttribute('role', 'alert');
  panel.innerHTML = '<div class="recovery-card"><h2 id="recovery-title">開始できませんでした</h2>'
    + '<p id="recovery-message"></p><p id="recovery-help" class="note"></p>'
    + '<button id="recovery-retry" class="primary">もう一度開始する</button>'
    + '<button id="recovery-reload">ページを読み直す</button>'
    + '<details><summary>詳しい原因</summary><p id="recovery-version" class="note"></p><pre id="recovery-detail"></pre>'
    + '<button id="recovery-diagnostic">診断を保存</button></details></div>';
  document.body.appendChild(panel);
  const retry = document.getElementById('recovery-retry');
  let failure = null, bootOptions = null, bootPromise = null;
  let unityInstance = null, unityPromise = null, enginePromise = null, xrLoaded = !!(window.XR8 && window.XR8.XrController);
  let unityLoading = false, unityStallTimer = 0, registrationTimer = 0, stopScheduled = false;
  const history = [], bootHistory = [];
  let bootStage = 'idle';
  function stage(name, label) {
    bootStage = name;
    bootHistory.push({time:new Date().toISOString(), stage:name});
    if(bootHistory.length > 40)bootHistory.shift();
    if(label) {
      document.getElementById('status').textContent = label;
      const start=document.getElementById('start');
      if(!start.hidden){start.disabled=true;start.textContent=label;}
    }
  }
  function deadline(task, timeoutMs, message, needsReload = false) {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const e=Error(message);e.needsReload=needsReload;reject(e);},timeoutMs);
      Promise.resolve(task).then(value=>{clearTimeout(timer);resolve(value);},e=>{clearTimeout(timer);reject(e);});
    });
  }
  function resourceSnapshot() {
    if(typeof performance.getEntriesByType!=='function')return [];
    return performance.getEntriesByType('resource').filter(e=>/\/(external\/xr|Build)\//.test(e.name)).slice(-20).map(e=>({
      path:new URL(e.name,location.href).pathname,durationMs:Math.round(e.duration),
      transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,responseStatus:e.responseStatus
    }));
  }
  const fatalRuntime = value => /out of bounds|memory access|unreachable|RuntimeError|abort\(|aborted/i.test(String(value));
  function clear() {
    if(failure&&failure.fatal)return;
    failure = null; panel.hidden = true;
    document.body.classList.remove('roll-recovery-open');
  }
  function fail(message, detail, scope = 'ar', fatal = false, pending = false) {
    if (failure && failure.fatal && !fatal) return;
    failure = {message, detail:String(detail || ''), scope, fatal, pending, stage:bootStage};
    history.push({time:new Date().toISOString(), ...failure}); if(history.length > 30) history.shift();
    if(window.RollCaptureBridge && RollCaptureBridge.suspend) RollCaptureBridge.suspend();
    if(scope==='boot'&&!stopScheduled){
      stopScheduled=true;
      setTimeout(()=>{
        stopScheduled=false;
        if(failure&&failure.scope==='boot'&&window.FloorProbeBridge&&FloorProbeBridge.stopForFailure)
          FloorProbeBridge.stopForFailure();
      },0);
    }
    document.getElementById('recovery-title').textContent = '開始・継続できませんでした';
    document.getElementById('recovery-message').textContent = message;
    document.getElementById('recovery-detail').textContent = failure.detail || message;
    const versions=document.getElementById('roll-version');
    document.getElementById('recovery-version').textContent=versions?versions.textContent:'画面 0.3.18';
    const permission = /NotAllowed|permission|denied|許可/i.test(failure.detail + message);
    document.getElementById('recovery-help').textContent = fatal
      ? 'ARとゲームの準備をやり直す必要があります。下のボタンでページを読み直してください。'
      : pending ? '読み込みの完了を待っています。長く変わらない場合は、下のボタンで読み直せます。'
      : permission ? 'Safariでカメラとモーションの利用を許可してください。拒否を保存した場合はSafari側の設定変更が必要です。'
      : '通信や用紙の状態を確認して、そのまま再試行できます。';
    retry.hidden = fatal; retry.disabled = pending;
    retry.textContent = pending ? '読み込み待ち…' : scope==='boot' ? '読み込みをやり直す' : 'もう一度開始する';
    panel.hidden = false; document.body.classList.add('roll-recovery-open');
  }
  function waitForScript(url, attributes = {}, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.dataset.rollManaged = 'true'; script.async = true;
      script.src = url;
      Object.entries(attributes).forEach(([key,value])=>script.setAttribute(key,value));
      const finish = error => {
        clearTimeout(timer);script.onload=script.onerror=null;
        if(error){script.remove();reject(error);}else resolve();
      };
      const timer=setTimeout(()=>{
        const e=Error('読み込みが時間内に完了しませんでした: '+url);
        if(url==='external/xr/xr.js')e.needsReload=true;
        finish(e);
      },timeoutMs);
      script.onload=()=>finish();script.onerror=()=>finish(Error('ファイルを読み込めませんでした: '+url));
      document.body.appendChild(script);
    });
  }
  function ensureEngine() {
    if(xrLoaded && window.XR8 && window.XR8.XrController)return Promise.resolve();
    if(enginePromise)return enginePromise;
    enginePromise=(async()=>{
      if(!window.XR8) {
        stage('xr-script','ARのデータを読み込んでいます…');
        let exported;
        const published=new Promise(resolve=>{exported=resolve;});
        const ready=()=>{if(window.XR8)exported();};
        window.addEventListener('xrloaded',ready);
        try {
          // Load the base first; SDK-managed tracking initialization is awaited separately below.
          await waitForScript('external/xr/xr.js',{},45000);
          stage('xr-export','ARの準備を進めています…');
          if(!window.XR8)await deadline(published,15000,'AR本体の読み込み後、準備完了を確認できませんでした。',true);
        } finally {window.removeEventListener('xrloaded',ready);}
      }
      const xr=window.XR8;
      if(!xr || typeof xr.initialize!=='function' || typeof xr.loadChunk!=='function') {
        const e=Error('ARエンジンのファイルが対応する構成ではありません。');e.needsReload=true;throw e;
      }
      stage('xr-core','ARの基本機能を準備しています…');
      try {await deadline(xr.initialize(),60000,'ARの基本機能の初期化が時間内に完了しませんでした。',true);}
      catch(e){const error=e instanceof Error?e:Error(String(e));error.needsReload=true;throw error;}
      if(!xr.XrController) {
        stage('xr-tracking','用紙を追跡する機能を準備しています…');
        await deadline(xr.loadChunk('slam'),60000,'ARの追跡機能の準備が時間内に完了しませんでした。',true);
      }
      if(!xr.XrController){const e=Error('ARの追跡機能を読み込めませんでした。');e.needsReload=true;throw e;}
      xrLoaded=true;stage('xr-ready');
      window.dispatchEvent(new Event('rollxrready'));
    })().catch(e=>{
      enginePromise=null;
      const error=e instanceof Error?e:Error(String(e));
      if(fatalRuntime(error))error.needsReload=true;
      throw error;
    });
    return enginePromise;
  }
  function resetUnityWatchdog() {
    clearTimeout(unityStallTimer);
    unityStallTimer=setTimeout(()=>{
      if(unityLoading)fail('ゲームデータの読み込みに時間がかかっています。','Unity loading stalled for 45 seconds','boot',false,true);
    },45000);
  }
  function ensureUnity() {
    if(unityInstance)return Promise.resolve(unityInstance);
    if(unityPromise)return unityPromise;
    unityPromise=(async()=>{
      if(typeof window.createUnityInstance!=='function')await waitForScript(bootOptions.loaderUrl);
      const config=Object.assign({},bootOptions.config);
      for(const key of ['showBanner','printErr']) {
        const original=config[key];
        config[key]=function(message,type){
          if(original)original(message,type);
          if(type==='error'||fatalRuntime(message))fail('ゲーム本体で異常が発生しました。',message,'boot',true);
        };
      }
      unityLoading=true;resetUnityWatchdog();
      try {
        unityInstance=await window.createUnityInstance(bootOptions.canvas,config,value=>{
          resetUnityWatchdog();bootOptions.bridge.progress(value);
        });
        bootOptions.bridge.setUnity(unityInstance);
        return unityInstance;
      } finally { unityLoading=false;clearTimeout(unityStallTimer); }
    })().catch(reason=>{
      const e=reason instanceof Error ? reason : Error(String(reason));
      unityPromise=null;
      // A trapped/aborted runtime cannot be safely recreated in the same JavaScript context.
      if(fatalRuntime(e)||!/fetch|network|download|load|通信|読み込|ファイル/i.test(String(e)))e.needsReload=true;
      throw e;
    });
    return unityPromise;
  }
  function boot(options) {
    if(options)bootOptions=options;
    if(failure&&failure.fatal)return Promise.resolve(false);
    if(bootPromise)return bootPromise;
    clear();
    bootPromise=ensureEngine().then(()=>{
      if(failure&&failure.fatal)return;
      stage('unity-runtime','ゲームを読み込んでいます…');
      return ensureUnity();
    }).then(()=>{
      if(failure&&failure.fatal)return false;
      if(!failure||failure.scope==='boot')clear();
      stage('boot-ready');
      clearTimeout(registrationTimer);
      registrationTimer=setTimeout(()=>{
        if(bootOptions.bridge.startupState&&!bootOptions.bridge.startupState().registered)
          fail('ゲームの準備完了を確認できませんでした。','Unity registration missing after 12 seconds','boot',true);
      },12000);
      return true;
    }).catch(e=>{
      fail('ゲームを準備できませんでした。',e,'boot',!!e.needsReload);
      return false;
    }).finally(()=>{bootPromise=null;});
    return bootPromise;
  }
  retry.addEventListener('click',()=>{
    if(!failure||failure.pending||failure.fatal)return;
    const scope=failure.scope;clear();
    if(scope==='boot') {
      boot().then(ok=>{if(ok&&window.FloorProbeBridge&&FloorProbeBridge.retryReady)FloorProbeBridge.retryReady();});
    } else if(window.FloorProbeBridge&&FloorProbeBridge.retryStart)FloorProbeBridge.retryStart();
    else fail('開始処理を読み込めませんでした。','Startup bridge missing','boot',true);
  });
  document.getElementById('recovery-reload').addEventListener('click',()=>location.reload());
  document.getElementById('recovery-diagnostic').addEventListener('click',()=>{
    const download=document.getElementById('download');
    if(window.FloorProbeBridge&&download){download.click();return;}
    const url=URL.createObjectURL(new Blob([JSON.stringify({uiRevision:'0.3.18',failure,history},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='roll-by-blow-startup.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  });
  window.addEventListener('error',event=>{
    if(event.error)fail('画面またはゲームの処理で問題が発生しました。',event.error,'boot',true);
    else if(event.target&&event.target.tagName==='SCRIPT'&&!event.target.dataset.rollManaged
      && !(unityLoading && /\/Build\//i.test(event.target.src)))
      fail('必要な表示データを読み込めませんでした。',event.target.src,'boot',true);
  },true);
  window.addEventListener('unhandledrejection',event=>{
    fail('開始処理で問題が発生しました。',event.reason,'boot',true);
  });
  window.RollStartup={boot,fail,clear,snapshot:()=>({failure,history:history.slice(),bootStage,bootHistory:bootHistory.slice(),unityLoading,xrLoaded,
      xrHasGlobal:!!window.XR8,xrControllerReady:!!(window.XR8&&window.XR8.XrController),resources:resourceSnapshot()}),
    pending:()=>!!failure,canResume:()=>!failure||!failure.fatal};
}());
