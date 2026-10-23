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
  let unityInstance = null, unityPromise = null, enginePromise = null, xrLoaded = !!window.XR8;
  let unityLoading = false, unityStallTimer = 0, registrationTimer = 0, stopScheduled = false;
  const history = [];
  const fatalRuntime = value => /out of bounds|memory access|unreachable|RuntimeError|abort\(|aborted/i.test(String(value));
  function clear() {
    if(failure&&failure.fatal)return;
    failure = null; panel.hidden = true;
    document.body.classList.remove('roll-recovery-open');
  }
  function fail(message, detail, scope = 'ar', fatal = false, pending = false) {
    if (failure && failure.fatal && !fatal) return;
    failure = {message, detail:String(detail || ''), scope, fatal, pending};
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
    document.getElementById('recovery-version').textContent=versions?versions.textContent:'画面 0.3.11';
    const permission = /NotAllowed|permission|denied|許可/i.test(failure.detail + message);
    document.getElementById('recovery-help').textContent = fatal
      ? 'ゲーム本体の再起動が必要です。下のボタンでページを読み直してください。'
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
      const timer=setTimeout(()=>finish(Error('読み込みが時間内に完了しませんでした: '+url)),timeoutMs);
      script.onload=()=>finish();script.onerror=()=>finish(Error('ファイルを読み込めませんでした: '+url));
      document.body.appendChild(script);
    });
  }
  window.addEventListener('xrloaded',()=>{xrLoaded=true;});
  function ensureEngine() {
    if(xrLoaded)return Promise.resolve();
    if(enginePromise)return enginePromise;
    if(window.XR8){const e=Error('ARエンジンの準備が完了していません。');e.needsReload=true;return Promise.reject(e);}
    enginePromise=new Promise((resolve,reject)=>{
      const ready=()=>{clearTimeout(timer);window.removeEventListener('xrloaded',ready);resolve();};
      const timer=setTimeout(()=>{
        window.removeEventListener('xrloaded',ready);
        const e=Error('ARエンジンの準備が時間内に完了しませんでした。');e.needsReload=!!window.XR8;reject(e);
      },45000);
      window.addEventListener('xrloaded',ready);
      waitForScript('external/xr/xr.js',{'data-preload-chunks':'slam'}).catch(e=>{
        clearTimeout(timer);window.removeEventListener('xrloaded',ready);reject(e);
      });
    }).catch(e=>{enginePromise=null;throw e;});
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
    bootPromise=Promise.all([ensureEngine(),ensureUnity()]).then(()=>{
      if(failure&&failure.fatal)return false;
      if(!failure||failure.scope==='boot')clear();
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
    const url=URL.createObjectURL(new Blob([JSON.stringify({uiRevision:'0.3.11',failure,history},null,2)],{type:'application/json'}));
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
  window.RollStartup={boot,fail,clear,snapshot:()=>({failure,history:history.slice(),unityLoading,xrLoaded}),
    pending:()=>!!failure,canResume:()=>!failure||!failure.fatal};
}());
