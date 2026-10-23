/* Image registration and world tracking share one camera and one XR Engine coordinate system. */
(function(){
  'use strict';
  window.RollColorBridge=function(){
    const webRevision='0.3.14',maximumImageGapMs=2000;
    const imageOnly=new URLSearchParams(location.search).get('tracking')==='color-image';
    const ui=Object.fromEntries(['start','stop','replace','recenter','place','loading','progress','phase','status','guidance','dimensions','metrics','download','coaching','reticle'].map(id=>[id,document.getElementById(id)]));
    const canvas=document.getElementById('camera-canvas');
    const frame=new Float32Array(39),legacyFrame=frame.subarray(0,38),events=[],poseHistory=[],lifecycle=[];
    const alphaContexts=new WeakSet(),unityAlpha={enabled:true,installed:false,clearCalls:0,alphaOnlyOpaqueClears:0,
      preventedClears:0,preventedDefaultClears:0,preventedOffscreenClears:0,preventedClearBufferCalls:0,error:''};
    const state={phase:'loading',manualBackground:false,cameraFeed:{gpuFrames:0,renderCallbacks:0,freshVideoFrames:0,
      texturePresent:false,textureContextMatches:null,textureWidth:0,textureHeight:0,repeatFrame:null,videoTime:null,
      viewport:null,manualDraws:0,manualError:''}};
    let unity,config,layout,targets=[],engineReady=!!(window.XR8&&window.XR8.XrController),added=false,error='',running=false,starting=false;
    const visibleTargets=new Set(),targetAnchors=new Map();
    let anchor=null,imageVisible=false,lastAnchorAt=0,imageLostAt=0,lastPoseAt=0,placed=false,placementAt=0,unityReport=null;
    let xrGl=null,latestCameraFrame=null,manualRenderer=null,raf=0,nextTick=0,lastMode='',rawCamera=null,session=0;
    let startedAt=0,nextPoseSample=0,recognitionWaitAt=0,startTimer=0,gameReadyAt=0;
    let readyData=null,dataLoaded=false,dataAttempt=0;
    const tracking={source:'waiting-for-image',imageUpdates:0,worldFrames:0,imageFrames:0,limitedFrames:0,
      rawStatus:'',metersPerWorldUnit:null,cameraInBoard:null,imageFound:0,imageLost:0,sourceChanges:0};
    const finite=value=>typeof value==='number'&&Number.isFinite(value);
    function loadReferenceImage(target){
      return new Promise((resolve,reject)=>{
        const img=new Image();
        const finish=e=>{clearTimeout(timer);img.onload=img.onerror=null;if(e)reject(e);else resolve();};
        const timer=setTimeout(()=>finish(Error('認識用の画像の読み込みが時間内に完了しませんでした。')),15000);
        img.onload=()=>{
          if(img.naturalWidth!==480||img.naturalHeight!==640){finish(Error('用紙0.3.6の認識画像一式を公開してください。'));return;}
          record('target-image-ready',{name:target.name,width:img.naturalWidth,height:img.naturalHeight});finish();
        };
        img.onerror=()=>finish(Error('認識用の画像を取得できません。paper/image-targetsを確認してください。'));
        img.src=target.imagePath;
      });
    }
    async function fetchJson(url){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),15000);
      try{const r=await fetch(url,{cache:'no-cache',signal:controller.signal});if(!r.ok)throw Error('認識データを取得できません: '+r.status);return await r.json();}
      finally{clearTimeout(timer);}
    }
    function ensureData(){
      if(dataLoaded)return Promise.resolve();
      if(readyData)return readyData;
      const attempt=++dataAttempt;
      readyData=(async()=>{
        const paper=await fetchJson('paper/stage-layout.json?v='+webRevision);
        if(!Array.isArray(paper.targets)||!paper.targets.length)throw Error('用紙の認識設定がありません。');
        const data=await Promise.all(paper.targets.map(t=>fetchJson(t.data+'?v='+webRevision)));
        for(const target of data){const url=new URL(target.imagePath,location.href);url.searchParams.set('v',webRevision);url.searchParams.set('attempt',String(attempt));target.imagePath=url.href;}
        await Promise.all(data.map(loadReferenceImage));
        if(attempt!==dataAttempt)return;
        layout=paper;targets=data;dataLoaded=true;ready();
      })().catch(e=>{if(attempt===dataAttempt){readyData=null;dataLoaded=false;}throw e;});
      return readyData;
    }
    async function waitForPermissions(permissions){
      let timer;
      try{return await Promise.race([Promise.all(permissions),new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(Error('モーションの利用許可を確認できませんでした。Safariの許可表示を確認して再試行してください。')),30000);
      })]);}finally{clearTimeout(timer);}
    }
    function prepareData(){
      const pending=ensureData(),attempt=dataAttempt;
      pending.then(ready).catch(e=>{if(attempt===dataAttempt)fail('カラー用紙のデータを読み込めませんでした。',e);});
    }
    const sizeRow=document.createElement('p');
    sizeRow.innerHTML='印刷したカラー枠の外幅 <input id="color-width" type="number" inputmode="decimal" min="5" max="60" value="18" step="0.1" style="width:4em"> cm · <a href="paper/print.html" target="_blank" rel="noopener">印刷用紙</a>';
    document.getElementById('diagnostics').before(sizeRow);
    const sizeInput=document.getElementById('color-width');
    document.querySelector('.eyebrow').textContent='Roll-by-Blow · '+webRevision+' · '+(imageOnly?'用紙だけの比較':'カラー枠');
    ui.dimensions.textContent='新しい用紙0.3.6を認識して自動配置します';
    ui.guidance.textContent=imageOnly?'新しい用紙の枠全体を映してください。比較用のため用紙の認識を失うと止まります。':'新しい用紙の枠全体を映してください。見失った後は最大2秒補い、戻らなければ一時停止します。';
    ui.place.hidden=true;ui.coaching.hidden=true;ui.reticle.hidden=true;
    ui.replace.textContent='用紙を読み直す';ui.recenter.hidden=true;
    function record(kind,detail){
      const event={time:new Date().toISOString(),kind,detail};
      events.push(event);if(events.length>240)events.shift();
      if(['engine-ready','unity-ready','unity-registered','camera-start','error','tracking-settings','motion-permission','target-image-ready'].includes(kind)){
        lifecycle.push(event);if(lifecycle.length>30)lifecycle.shift();
      }
    }
    const copyPosition=p=>p?{x:p.x,y:p.y,z:p.z}:null;
    const copyRotation=q=>q?{x:q.x,y:q.y,z:q.z,w:q.w}:null;
    function samplePose(clock,camera,pose,imageFresh){
      if(clock<nextPoseSample)return;nextPoseSample=clock+500;
      poseHistory.push({elapsedMs:Math.round(clock-startedAt),frame:frame[0],source:tracking.source,
        rawStatus:tracking.rawStatus,anchorName:anchor?anchor.name:null,imageFresh,imageVisible,
        imageAgeMs:anchor?Math.round(clock-lastAnchorAt):null,
        imageLostAgeMs:anchor&&!imageVisible&&imageLostAt?Math.round(clock-imageLostAt):null,
        cameraInBoard:pose?copyPosition(pose.position):null,rotationInBoard:pose?copyRotation(pose.rotation):null,
        metersPerWorldUnit:pose?pose.metersPerWorldUnit:null,
        camera:camera?{position:copyPosition(camera.position),rotation:copyRotation(camera.rotation)}:null,
        image:anchor?{position:copyPosition(anchor.position),rotation:copyRotation(anchor.rotation),scale:anchor.scale,scaledWidth:anchor.scaledWidth}:null});
      if(poseHistory.length>240)poseHistory.shift();
    }
    function send(method,value){
      if(!unity)return;
      try{unity.SendMessage('FloorProbe',method,value===undefined?'':value);}
      catch(e){record('unity-message-error',String(e));unity=null;config=null;if(window.RollStartup)RollStartup.fail('ゲーム本体との接続が切れました。',e,'boot',true);}
    }
    function ready(){
      if(unity&&config&&layout&&targets.length&&engineReady&&!error&&!running&&!starting){
        state.phase='ready';ui.start.disabled=false;ui.start.hidden=false;ui.start.textContent=imageOnly?'許可して比較を始める':'許可して始める';
        ui.loading.hidden=true;ui.status.textContent='準備できました。';ui.phase.textContent='開始前';
      }
    }
    function setProjection(width,height){
      if(width&&height)XR8.XrController.updateCameraProjectionMatrix({cam:{pixelRectWidth:width,pixelRectHeight:height,nearClipPlane:.05,farClipPlane:30},
        origin:{x:0,y:0,z:0},facing:{x:0,y:0,z:0,w:1}});
    }
    function stopLoop(){cancelAnimationFrame(raf);raf=0;nextTick=0;}
    function startLoop(){
      if(raf)return;
      function tick(clock){
        raf=0;if(!running||document.hidden)return;
        const period=1000/30;
        if(!nextTick||clock+.25>=nextTick){
          nextTick=clock+period-(nextTick?Math.max(0,clock-nextTick)%period:0);
          try{XR8.runPreRender(Date.now());try{drawCameraFrame(true);if(state.cameraFeed.manualError)throw Error(state.cameraFeed.manualError);}finally{XR8.runPostRender();}}
          catch(e){fail('AR処理を継続できませんでした。',e);return;}
        }
        raf=requestAnimationFrame(tick);
      }
      raf=requestAnimationFrame(tick);
    }
    function stop(){
      session++;clearTimeout(startTimer);startTimer=0;gameReadyAt=0;
      running=false;starting=false;stopLoop();
      if(window.XR8&&added){try{XR8.stop();}catch(e){record('stop-error',String(e));}}
      destroyManualRenderer();frame.fill(0);anchor=null;imageVisible=false;imageLostAt=0;placed=false;lastPoseAt=0;
      visibleTargets.clear();targetAnchors.clear();
      send('ClearPlacement');sizeInput.disabled=false;
      ui.stop.disabled=ui.replace.disabled=ui.recenter.disabled=true;ui.start.hidden=false;
      state.phase='stopped';ready();
    }
    function fail(message,cause){error=message+(cause?' '+String(cause.message||cause):'');stop();state.phase='error';ui.phase.textContent='エラー';ui.status.textContent=message;record('error',error);if(window.RollStartup)RollStartup.fail(message,cause||message,'ar');}
    function deferFailure(message){const token=session;setTimeout(()=>{if(token===session)fail(message);},0);}
    function imageUpdate(event){
      const d=event.detail;
      if(!d||!layout)return;
      const spec=layout.targets.find(t=>t.name===d.name);if(!spec)return;
      // Store a snapshot: SDK event objects must not mutate the retained world reference.
      const candidate={...spec,position:copyPosition(d.position),rotation:copyRotation(d.rotation),scale:d.scale,scaledWidth:d.scaledWidth,scaledHeight:d.scaledHeight,updatedAt:performance.now()};
      const sample=rawCamera||{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0,w:1}};
      if(!RollColorPose.cameraInBoard(sample,candidate,Number(sizeInput.value)/100)){
        record('image-pose-rejected',{name:d.name,scale:d.scale,scaledWidth:d.scaledWidth});return;
      }
      const wasVisible=visibleTargets.has(d.name);visibleTargets.add(d.name);targetAnchors.set(d.name,candidate);
      if(!anchor||anchor.name===d.name||!visibleTargets.has(anchor.name)||performance.now()-lastAnchorAt>200){anchor=candidate;lastAnchorAt=candidate.updatedAt;}
      imageVisible=visibleTargets.has(anchor.name);if(imageVisible)imageLostAt=0;tracking.imageUpdates++;
      if(!wasVisible){tracking.imageFound++;record('image-found',{name:d.name,scale:d.scale,scaledWidth:d.scaledWidth,scaledHeight:d.scaledHeight});}
    }
    function update(result){
      if(!running)return;
      const background=result.processGpuResult&&result.processGpuResult.gltexturerenderer;
      if(background&&background.viewport)state.cameraFeed.viewport=background.viewport;
      const camera=result.processCpuResult&&result.processCpuResult.reality;
      tracking.rawStatus=camera?camera.trackingStatus+'/'+camera.trackingReason:'no-pose';
      const valid=camera&&camera.intrinsics&&camera.intrinsics.length===16&&Array.from(camera.intrinsics).every(finite);
      rawCamera=valid?camera:null;
      const pose=valid&&anchor?RollColorPose.cameraInBoard(camera,anchor,Number(sizeInput.value)/100):null;
      const clock=performance.now();
      const normal=valid&&camera.trackingStatus==='NORMAL'&&camera.trackingReason!=='INITIALIZING';
      const imageAgeMs=anchor?clock-lastAnchorAt:Infinity;
      const lostAgeMs=anchor?(imageVisible?0:(imageLostAt?clock-imageLostAt:imageAgeMs)):Infinity;
      const imageFresh=imageVisible&&imageAgeMs<250;
      // imageupdated is a change event, not a guaranteed heartbeat. Follow found/lost visibility.
      const usable=!!pose&&(imageVisible||(!imageOnly&&normal&&lostAgeMs<=maximumImageGapMs));
      frame[0]++;frame[1]=1;frame[2]=usable?1:0;frame[35]=usable?1:0;
      if(usable){
        lastPoseAt=clock;tracking.cameraInBoard=pose.position;tracking.metersPerWorldUnit=pose.metersPerWorldUnit;
        frame[3]=pose.position.x;frame[4]=pose.position.y;frame[5]=pose.position.z;
        frame[6]=pose.rotation.x;frame[7]=pose.rotation.y;frame[8]=pose.rotation.z;frame[9]=pose.rotation.w;
        frame.set(camera.intrinsics,10);frame[36]=canvas.width;frame[37]=canvas.height;
        frame[38]=screen.orientation&&finite(screen.orientation.angle)?screen.orientation.angle:(window.orientation||0);
        tracking.source=imageVisible?(imageOnly?'image-direct':'image-and-world'):'world-continuation';
        if(imageVisible)tracking.imageFrames++;else tracking.worldFrames++;
        if(!placed&&clock-placementAt>500){placementAt=clock;send('PlaceFromMarker',JSON.stringify({position:{x:0,y:0,z:0},sizeMeters:Number(sizeInput.value)/100}));}
      }else{tracking.source=anchor?(!imageVisible&&lostAgeMs>maximumImageGapMs?'image-required':'tracking-unavailable'):'waiting-for-image';tracking.limitedFrames++;}
      if(tracking.source!==lastMode){lastMode=tracking.source;tracking.sourceChanges++;record('tracking-mode',{source:lastMode,rawStatus:tracking.rawStatus});}
      samplePose(clock,valid?camera:null,pose,imageFresh);
      ui.phase.textContent=usable?'プレイ中':anchor?'一時停止':'認識中';
      ui.status.textContent=usable&&imageVisible?'カラー用紙を基準に追跡しています。':'用紙の枠全体を映してください';
      if(!anchor&&clock-recognitionWaitAt>25000){recognitionWaitAt=Infinity;deferFailure('用紙を認識できませんでした。枠全体と明るさを確認して、もう一度開始してください。');}
    }
    function addModules(){
      XR8.XrController.configure({disableWorldTracking:imageOnly,enableLighting:false,enableWorldPoints:false,
        leftHandedAxes:false,mirroredDisplay:false,scale:'responsive',imageTargetData:targets});
      record('tracking-settings',{webRevision,imageOnly,targetNames:targets.map(t=>t.name),targetCount:targets.length,arTargetFps:30,maximumImageGapMs});
      if(added)return;
      XR8.addCameraPipelineModules([XR8.GlTextureRenderer.pipelineModule(),XR8.XrController.pipelineModule(),{
        name:'roll-color-image-world',
        listeners:[
          {event:'reality.imagefound',process:imageUpdate},{event:'reality.imageupdated',process:imageUpdate},
          {event:'reality.imagelost',process:event=>{
            if(!event.detail)return;visibleTargets.delete(event.detail.name);
            if(anchor&&anchor.name===event.detail.name){
              for(const name of visibleTargets){const other=targetAnchors.get(name);if(other){anchor=other;lastAnchorAt=other.updatedAt;break;}}
            }
            imageVisible=!!anchor&&visibleTargets.has(anchor.name);if(!imageVisible&&!imageLostAt)imageLostAt=performance.now();
            tracking.imageLost++;record('image-lost',{name:event.detail.name,continueWithWorld:!imageOnly});
          }},
          {event:'reality.imageloading',process:event=>record('image-loading',event.detail)},
          {event:'reality.imagescanning',process:event=>record('image-scanning',event.detail)}
        ],
        onStart:result=>{
          if(!starting||(window.RollStartup&&!RollStartup.canResume()))return;
          clearTimeout(startTimer);startTimer=0;if(window.RollStartup)RollStartup.clear();
          destroyManualRenderer();xrGl=result.GLctx;setProjection(result.canvasWidth,result.canvasHeight);
          // Set the active image data once after all pipeline modules have attached as well.
          XR8.XrController.configure({imageTargetData:targets});
          state.cameraFeed.manualError='';
          state.phase='running';starting=false;running=true;startLoop();record('camera-start',{width:result.canvasWidth,height:result.canvasHeight});
        },
        onUpdate:update,onProcessGpu:inspectCameraFrame,onRender:drawCameraFrame,
        onCanvasSizeChange:result=>{if(running)setProjection(result.canvasWidth,result.canvasHeight);},
        onCameraStatusChange:result=>{record('camera',result.status);if(result.status==='failed')fail('カメラを開始できませんでした。');},
        onException:e=>fail('ARエンジンのエラーです。',e),
        onDetach:()=>{stopLoop();destroyManualRenderer();}
      }]);added=true;
    }
    async function start(){
      if(starting||running||!unity||!config||!engineReady)return;
      starting=true;error='';ui.start.disabled=true;ui.status.textContent='カメラとモーションの利用を確認しています。';if(window.RollStartup)RollStartup.clear();const token=++session;
      try{
        if(!isSecureContext||!navigator.mediaDevices)throw Error('HTTPSのSafariで開いてください。');
        const width=Number(sizeInput.value)/100;if(!finite(width)||width<.05||width>.6)throw Error('カラー枠の実測した外幅を5〜60cmで入力してください。');
        // Request motion only for the SDK's own world tracking; never overwrite its camera rotation.
        const permissions=[window.DeviceMotionEvent,window.DeviceOrientationEvent].filter(t=>t&&typeof t.requestPermission==='function').map(t=>t.requestPermission());
        const results=await waitForPermissions(permissions);if(token!==session||document.hidden)return;record('motion-permission',{results});if(results.some(r=>r!=='granted'))throw Error('モーションの利用を許可してください。');
        await ensureData();if(token!==session||document.hidden){starting=false;return;}
        anchor=null;imageVisible=false;imageLostAt=0;visibleTargets.clear();targetAnchors.clear();rawCamera=null;placed=false;placementAt=0;send('ClearPlacement');
        startedAt=performance.now();recognitionWaitAt=startedAt;nextPoseSample=0;lastPoseAt=0;lastMode='';poseHistory.length=0;
        Object.assign(tracking,{source:'waiting-for-image',imageUpdates:0,worldFrames:0,imageFrames:0,limitedFrames:0,
          rawStatus:'',metersPerWorldUnit:null,cameraInBoard:null,imageFound:0,imageLost:0,sourceChanges:0});
        canvas.width=Math.max(1,innerWidth);canvas.height=Math.max(1,innerHeight);sizeInput.disabled=true;
        addModules();state.phase='starting';ui.status.textContent='カメラを起動しています。';
        startTimer=setTimeout(()=>{if(token===session&&starting)fail('カメラの起動が時間内に完了しませんでした。もう一度開始できます。');},20000);
        ui.start.hidden=true;ui.stop.disabled=ui.replace.disabled=ui.recenter.disabled=false;
        await XR8.run({canvas,webgl2:true,ownRunLoop:false,allowedDevices:XR8.XrConfig.device().MOBILE,
          cameraConfig:{direction:XR8.XrConfig.camera().BACK},glContextConfig:{alpha:false,antialias:false,preserveDrawingBuffer:false}});
      }catch(e){if(token===session)fail('カラー枠のARを開始できませんでした。',e);}
    }
    ui.start.addEventListener('click',start);
    ui.stop.addEventListener('click',()=>{stop();ui.status.textContent='終了しました。';});
    for(const button of [ui.replace,ui.recenter])button.addEventListener('click',()=>{
      anchor=null;imageVisible=false;imageLostAt=0;visibleTargets.clear();targetAnchors.clear();placed=false;frame[2]=frame[35]=0;send('ClearPlacement');
      recognitionWaitAt=performance.now();
      record('clear-image-anchor',null);
    });
    ui.download.addEventListener('click',()=>{
      const data={prototype:'ARRollCapture-'+webRevision+'-color',webRevision,imageOnly,maximumImageGapMs,savedAt:new Date().toISOString(),page:location.href,userAgent:navigator.userAgent,
        phase:state.phase,error,config,layout,tracking:{...tracking,imageVisible,lastImageAgeMs:anchor?performance.now()-lastAnchorAt:null,
          lastImageLostAgeMs:anchor&&!imageVisible&&imageLostAt?performance.now()-imageLostAt:null},
        anchor,rawCamera:rawCamera?{position:rawCamera.position,rotation:rawCamera.rotation}:null,frame:Array.from(frame),unity:unityReport,
        startup:window.RollStartup?RollStartup.snapshot():null,game:window.RollCaptureBridge?RollCaptureBridge.snapshot():null,feed:state.cameraFeed,alpha:unityAlpha,poseHistory,lifecycle,events};
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='roll-by-blow-color-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});window.addEventListener('pagehide',stop);
    function engineLoaded(){
      if(engineReady||!window.XR8||!window.XR8.XrController)return;
      engineReady=true;record('engine-ready',true);ready();
    }
    window.addEventListener('xrloaded',engineLoaded);
    window.addEventListener('rollxrready',engineLoaded);
    prepareData();
    function destroyManualRenderer() {
    if (manualRenderer) {
      try { manualRenderer.destroy(); } catch (error) { record('renderer-cleanup', String(error)); }
    }
    manualRenderer = null;
    latestCameraFrame = null;
  }

  function inspectCameraFrame(result) {
    const cameraFrame = result.frameStartResult;
    if (!cameraFrame) return;
    latestCameraFrame = cameraFrame;
    const stats = state.cameraFeed;
    stats.gpuFrames++;
    stats.texturePresent = !!cameraFrame.cameraTexture;
    stats.textureContextMatches = cameraFrame.GLctx === xrGl;
    stats.textureWidth = cameraFrame.textureWidth;
    stats.textureHeight = cameraFrame.textureHeight;
    stats.repeatFrame = !!cameraFrame.repeatFrame;
    if (cameraFrame.videoTime !== stats.videoTime) stats.freshVideoFrames++;
    stats.videoTime = cameraFrame.videoTime;
  }

  function drawCameraFrame(force) {
    state.cameraFeed.renderCallbacks++;
    if ((!state.manualBackground && force !== true) || !xrGl || !latestCameraFrame
        || !latestCameraFrame.cameraTexture || state.cameraFeed.manualError || xrGl.isContextLost()) return;
    let restore;
    try {
      restore = XR8.GlTextureRenderer.getGLctxParameters(xrGl, [xrGl.TEXTURE0]);
      if (latestCameraFrame.GLctx !== xrGl) throw new Error('Camera texture uses a different WebGL context.');
      if (!manualRenderer) manualRenderer = XR8.GlTextureRenderer.create({GLctx: xrGl});
      const sdkViewport = state.cameraFeed.viewport;
      const viewport = sdkViewport && finite(sdkViewport.width) && sdkViewport.width > 0
        && finite(sdkViewport.height) && sdkViewport.height > 0 ? sdkViewport : XR8.GlTextureRenderer.fillTextureViewport(
        latestCameraFrame.textureWidth, latestCameraFrame.textureHeight,
        xrGl.drawingBufferWidth, xrGl.drawingBufferHeight);
      state.cameraFeed.manualViewport = viewport;
      manualRenderer.render({renderTexture: latestCameraFrame.cameraTexture, viewport: viewport});
      state.cameraFeed.manualDraws++;
    } catch (error) {
      state.cameraFeed.manualError = String(error.message || error);
      record('camera-redraw-error', state.cameraFeed.manualError);
    } finally {
      if (restore) {
        try { XR8.GlTextureRenderer.setGLctxParameters(xrGl, restore); }
        catch (error) { state.cameraFeed.manualError = String(error.message || error); }
      }
    }
  }
    function installUnityAlphaGuard(gl) {
    if (alphaContexts.has(gl)) return;
    alphaContexts.add(gl);
    try {
      const initialMask = gl.getParameter(gl.COLOR_WRITEMASK);
      let alphaOnlyWrites = !initialMask[0] && !initialMask[1] && !initialMask[2] && initialMask[3];
      const originalColorMask = gl.colorMask;
      const originalClear = gl.clear;
      gl.colorMask = function (r, g, b, a) {
        originalColorMask.call(gl, r, g, b, a);
        alphaOnlyWrites = !r && !g && !b && !!a;
      };
      function preventOpaqueAlpha(alpha) {
        if (!alphaOnlyWrites || !Number.isFinite(alpha) || alpha < 1) return false;
        unityAlpha.alphaOnlyOpaqueClears++;
        unityAlpha.lastClearAlpha = alpha;
        if (!unityAlpha.enabled) return false;
        const offscreen = gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null;
        unityAlpha.lastTarget = offscreen ? 'offscreen' : 'canvas';
        unityAlpha.preventedClears++;
        if (offscreen) unityAlpha.preventedOffscreenClears++;
        else unityAlpha.preventedDefaultClears++;
        return true;
      }
      gl.clear = function (mask) {
        unityAlpha.clearCalls++;
        if ((mask & gl.COLOR_BUFFER_BIT) && alphaOnlyWrites
            && preventOpaqueAlpha(gl.getParameter(gl.COLOR_CLEAR_VALUE)[3])) {
          // Keep depth/stencil clearing, and leave all existing color/alpha pixels intact.
          const remaining = mask & ~gl.COLOR_BUFFER_BIT;
          if (remaining) originalClear.call(gl, remaining);
          return;
        }
        originalClear.call(gl, mask);
      };
      if (typeof gl.clearBufferfv === 'function') {
        const originalClearBuffer = gl.clearBufferfv;
        gl.clearBufferfv = function (buffer, drawbuffer, values, srcOffset) {
          if (buffer === gl.COLOR && values && values.length >= (srcOffset || 0) + 4
              && preventOpaqueAlpha(values[(srcOffset || 0) + 3])) {
            unityAlpha.preventedClearBufferCalls++;
            return;
          }
          return originalClearBuffer.apply(gl, arguments);
        };
      }
      unityAlpha.installed = true;
      record('unity-alpha-guard', 'Skip opaque alpha-only clears on this Unity context only.');
    } catch (error) {
      unityAlpha.error = String(error.message || error);
      record('unity-alpha-guard-error', unityAlpha.error);
    }
  }
    return {
      retryReady:()=>{error='';prepareData();},
      retryStart:()=>{stop();error='';if(!unity||!config||!engineReady){ready();if(window.RollStartup)RollStartup.fail('まだゲームの準備が完了していません。','Boot resources are not ready','boot');return;}dataAttempt++;dataLoaded=false;readyData=null;start();},
      stopForFailure:stop,
      startupState:()=>({registered:!!config,engineReady,dataLoaded,starting,running}),
      pixelRatio:1,captureContext:(kind,gl)=>{if(gl&&/webgl/.test(kind))installUnityAlphaGuard(gl);},
      progress:value=>{ui.progress.style.width=Math.round(value*100)+'%';},
      banner:(message,type)=>{record('unity-'+type,String(message));if(type==='error')fail('Unity読み込みエラーです。',message);},fail,
      setUnity:instance=>{unity=instance;record('unity-ready',true);ready();},
      register:value=>{config=value;record('unity-registered',{playerRevision:value.playerRevision,frameFloatCount:value.frameFloatCount});if(value.playerRevision!=='0.3.4'||!value.supportsColorTracking||value.frameFloatCount!==39){fail('Unity本体は0.3.4のビルドが必要です。Web接続の更新だけでは旧Unityを更新できません。');return;}ready();},
      readFrame:()=>{if(!running||performance.now()-lastPoseAt>350){frame[2]=frame[35]=0;}return config&&config.frameFloatCount===39?frame:legacyFrame;},
      report:value=>{
        unityReport=value;placed=!!value.placed;
        ui.metrics.textContent=JSON.stringify({webRevision,provider:imageOnly?'image-direct':'image-and-world',tracking,placed,fps:value.fps},null,2);
        if(running&&placed){
          const game=window.RollCaptureBridge?RollCaptureBridge.snapshot().report:null;
          if(!game){if(!gameReadyAt)gameReadyAt=performance.now();else if(performance.now()-gameReadyAt>8000){gameReadyAt=Infinity;deferFailure('ステージのゲームを開始できませんでした。もう一度開始してください。');}}
          else{gameReadyAt=0;if(game.message==='Stage definition missing')deferFailure('ステージの設定を読み込めませんでした。');}
        }else gameReadyAt=0;
      },
      gameCommand:method=>{if(method==='RequestReset'||method==='ResetBall')send('RequestReset');},
      gameIsActive:()=>running&&placed&&frame[2]>.5&&performance.now()-lastPoseAt<350,
      paperNeedsView:()=>running&&!imageVisible,
      trackingHint:()=> '用紙の枠全体を映してください'
    };
  };
}());
