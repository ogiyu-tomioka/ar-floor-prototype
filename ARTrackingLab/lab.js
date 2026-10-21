// Diagnostic data only; never writes game saves or uploads camera images.
export function createLab(mode, settings) {
  const ui = Object.fromEntries(['status','stats','error','start','stop','save','hint'].map(id=>[id,document.getElementById(id)]));
  const data = {prototype:'ARTrackingLab-0.1.0',mode,settings,phase:'ready',page:location.href,
    userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio},
    motionPermissions:[],events:[],samples:[],lastSample:null,error:'',nativeOrientation:null};
  let cleanup=()=>{},deadline=0,lastSampleAt=-Infinity,windowAt=performance.now(),ticks=0,fps=0;
  let lastNative=null,started=false,timer=0;
  function event(kind,detail) { data.events.push({time:new Date().toISOString(),kind,detail}); if(data.events.length>100)data.events.shift(); }
  function stop(reason='user') {
    if(!started)return;
    started=false;clearInterval(timer);data.phase='stopped';event('stop',reason);
    // Preserve poses, anchor and samples after camera shutdown.
    try{cleanup();}catch(e){event('cleanup-error',String(e));}
    document.querySelectorAll('video').forEach(v=>{if(v.srcObject){v.srcObject.getTracks().forEach(t=>t.stop());v.srcObject=null;}});
    ui.stop.disabled=true;ui.start.disabled=false;ui.start.textContent='再読み込みして再確認';
    ui.status.textContent='終了しました。診断を保存できます。';
  }
  function fail(error) {
    data.error=String(error&&error.message||error);event('error',data.error);ui.error.textContent=data.error;stop('error');data.phase='error';
    ui.start.disabled=false;ui.start.textContent='再読み込みして再確認';
  }
  ui.stop.onclick=()=>stop();
  ui.save.onclick=()=>{
    data.savedAt=new Date().toISOString();
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='ar-tracking-'+mode+'-'+data.savedAt.replace(/[:.]/g,'-')+'.json';
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  };
  window.addEventListener('deviceorientation',e=>{if(started)lastNative={alpha:e.alpha,beta:e.beta,gamma:e.gamma,
    screenAngle:screen.orientation?screen.orientation.angle:window.orientation,clock:performance.now()};},{passive:true});
  window.addEventListener('pagehide',()=>stop('pagehide'));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('hidden');});
  window.addEventListener('error',e=>fail(e.message));
  window.addEventListener('unhandledrejection',e=>fail(e.reason));
  async function permissions() {
    if(!isSecureContext||!navigator.mediaDevices)throw new Error('HTTPSで公開したページをSafariで開いてください。');
    const requests=[window.DeviceMotionEvent,window.DeviceOrientationEvent]
      .filter(t=>t&&typeof t.requestPermission==='function').map(t=>t.requestPermission());
    data.motionPermissions=await Promise.all(requests);event('motion-permissions',data.motionPermissions);
    if(data.motionPermissions.some(v=>v!=='granted'))throw new Error('モーションを許可してから再読み込みしてください。');
  }
  function begin(onCleanup) {
    started=true;data.phase='running';data.startedAt=new Date().toISOString();cleanup=onCleanup;deadline=performance.now()+60000;
    ui.start.disabled=true;ui.stop.disabled=false;event('start',settings);
    timer=setInterval(()=>{
      if(performance.now()>=deadline)stop('time-limit');
      else ui.stats.textContent=(fps?fps.toFixed(1)+' 更新/秒 · ':'')+'残り '+Math.ceil((deadline-performance.now())/1000)+' 秒';
    },250);
  }
  function sample(pose) {
    if(!started)return;
    const clock=performance.now();ticks++;
    if(clock-windowAt>=1000){fps=ticks*1000/(clock-windowAt);data.measuredUpdatesPerSecond=fps;ticks=0;windowAt=clock;}
    if(clock-lastSampleAt<200)return;lastSampleAt=clock;
    const value={...pose,time:new Date().toISOString(),clock,nativeOrientation:lastNative};
    data.lastSample=value;data.nativeOrientation=lastNative;data.samples.push(value);
    if(data.samples.length>400)data.samples.shift();
  }
  function ready(start) {ui.status.textContent='準備できました。';ui.start.disabled=false;ui.start.onclick=async()=>{
    if(data.phase==='stopped'||data.phase==='error'){location.reload();return;}
    ui.start.disabled=true;ui.status.textContent='カメラを準備しています…';
    try{await start();}catch(e){fail(e);}
  };}
  return {ui,data,event,stop,fail,permissions,begin,sample,ready,
    active:()=>started,armStop:milliseconds=>{deadline=Math.min(deadline,performance.now()+milliseconds);}};
}
