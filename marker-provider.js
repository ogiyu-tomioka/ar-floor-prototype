/* Project bridge. AR.js and Three.js retain their bundled licenses. */
(function () {
  'use strict';
  window.RollMarkerBridge = function () {
    const ui = Object.fromEntries(['start','stop','replace','recenter','status','phase','guidance','dimensions',
      'progress','loading','metrics','download','place','coaching','reticle'].map(id => [id,document.getElementById(id)]));
    const canvas = document.getElementById('unity-canvas');
    const frame = new Float32Array(39), legacyFrame = frame.subarray(0,38), events = [];
    const unityAlpha = {enabled:true,installed:false,clearCalls:0,alphaOnlyOpaqueClears:0,preventedClears:0,
      preventedOffscreenClears:0,preventedDefaultClears:0,preventedClearBufferCalls:0,error:''};
    const alphaContexts = new WeakSet();
    let unity,config,layout,source,context,controls,camera,run=false,placed=false,lastPose=0,raf=0;
    let starting=false,lastFrame=-Infinity,epoch=0,placementAt=0,unityReport=null,error='',detected=false;
    const modules = Promise.all([import('./external/marker/three.module.js'), import('./external/marker/ar-threex.mjs'),
      fetch('paper/stage-layout.json').then(r=>{if(!r.ok)throw Error('用紙の設定を読めませんでした。');return r.json();})]);
    const widthLabel=document.createElement('p');
    widthLabel.innerHTML='印刷した黒枠の外幅 <input id="paper-width" type="number" inputmode="decimal" min="4" max="12" value="7" step="0.1" style="width:4em"> cm · <a href="paper/print.html" target="_blank" rel="noopener">カラー用紙を印刷</a>';
    document.getElementById('diagnostics').before(widthLabel);
    const widthInput=document.getElementById('paper-width');
    document.querySelector('.eyebrow').textContent='Roll-by-Blow · 0.3.3 · 紙の目印';
    const credit=document.querySelector('.credit');
    credit.textContent='AR.js · License';credit.href='external/marker/ARJS-LICENSE.txt';
    document.getElementById('camera-canvas').hidden=true;
    ui.place.hidden=true; ui.coaching.hidden=true;ui.reticle.hidden=true;
    ui.dimensions.textContent='カラー用紙の右側へ自動配置します';
    ui.guidance.textContent='用紙を平らに置き、左の黒枠全体と右のステージを映してください。';
    ui.replace.textContent='配置し直す';ui.recenter.textContent='目印を再確認';
    function record(kind,detail){events.push({time:new Date().toISOString(),kind,detail});if(events.length>100)events.shift();}
    function send(method,value){if(unity)unity.SendMessage('FloorProbe',method,value===undefined?'':value);}
    function ready(){if(unity&&config&&!error&&!run&&!starting){ui.start.disabled=false;ui.start.textContent='紙の目印で開始';ui.status.textContent='準備できました。';ui.phase.textContent='開始前';}}
    function fail(message,cause){error=message+(cause?' '+String(cause.message||cause):'');stop();ui.status.textContent=error;ui.phase.textContent='エラー';record('error',error);}
    function resize(){
      if(!source||!source.ready||!context||!context.arController)return;
      source.onResizeElement();
      const video=source.domElement;
      // ARToolKit letterboxes portrait video in its landscape detection canvas.
      // Map that image area back to the visible video, then crop the projection to the screen.
      // Unity renders only screen pixels, rather than a much wider hidden canvas.
      const detector=context.arController.canvas;
      const portrait=video.videoWidth<video.videoHeight;
      const drawWidth=portrait?detector.height*detector.height/detector.width:detector.width;
      const drawHeight=detector.height,drawX=(detector.width-drawWidth)/2;
      const sx=parseFloat(video.style.width)/drawWidth,sy=parseFloat(video.style.height)/drawHeight;
      const renderWidth=detector.width*sx,renderHeight=detector.height*sy;
      const left=parseFloat(video.style.marginLeft||0)-drawX*sx,top=parseFloat(video.style.marginTop||0);
      const scaleX=renderWidth/innerWidth,scaleY=renderHeight/innerHeight;
      const offsetX=(2*left+renderWidth)/innerWidth-1,offsetY=1-(2*top+renderHeight)/innerHeight;
      canvas.style.inset='0';canvas.style.width='100%';canvas.style.height='100%';
      canvas.style.marginLeft='0';canvas.style.marginTop='0';
      canvas.width=Math.max(1,innerWidth);canvas.height=Math.max(1,innerHeight);
      camera.projectionMatrix.copy(context.getProjectionMatrix());
      const projection=camera.projectionMatrix.elements;
      for(let column=0;column<4;column++){
        const i=column*4;
        projection[i]=projection[i]*scaleX+projection[i+3]*offsetX;
        projection[i+1]=projection[i+1]*scaleY+projection[i+3]*offsetY;
      }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      record('resize',{video:[video.videoWidth,video.videoHeight],canvas:[canvas.width,canvas.height],crop:{scaleX,scaleY,offsetX,offsetY}});
    }
    function stop(){
      run=false;starting=false;epoch++;cancelAnimationFrame(raf);frame[1]=frame[2]=frame[35]=0;
      placed=false;detected=false;lastPose=0;send('ClearPlacement');
      if(source){
        document.body.removeEventListener('click',source.onInitialClick);
        if(source.domElement){const stream=source.domElement.srcObject;if(stream)stream.getTracks().forEach(t=>t.stop());source.domElement.remove();}
        source=null;
      }
      if(controls){controls.dispose();controls=null;}
      if(context){if(typeof context.dispose==='function')context.dispose();context=null;}
      widthInput.disabled=false;ui.stop.disabled=true;ui.replace.disabled=true;ui.recenter.disabled=true;
      ui.start.hidden=false;ready();
    }
    async function start(){
      if(starting||run||!unity||!config)return;
      starting=true;error='';const token=++epoch;ui.start.disabled=true;
      try{
        const measured=Number(widthInput.value)/100;
        if(!Number.isFinite(measured)||measured<.04||measured>.12)throw Error('黒枠の外幅を4〜12cmで入力してください。');
        if(!isSecureContext||!navigator.mediaDevices)throw Error('HTTPSでSafariから開いてください。');
        const [THREE,AR,paper]=await modules;
        if(token!==epoch)return;layout=paper;
        const scale=measured/layout.marker.blackWidthMeters;
        camera=new THREE.Camera();camera.visible=false;
        context=new AR.ArToolkitContext({cameraParametersUrl:'external/marker/camera_para.dat',
          // The outer loop limits processing to 30 Hz. Avoid a second 30 Hz gate dropping alternate frames.
          detectionMode:'mono',maxDetectionRate:60,canvasWidth:640,canvasHeight:480});
        const currentContext=context;
        context.init(()=>{
          if(token!==epoch||!context){currentContext.dispose();return;}
          controls=new AR.ArMarkerControls(context,camera,{type:'pattern',patternUrl:'external/marker/patt.hiro',
            size:measured,changeMatrixMode:'cameraTransformMatrix',smooth:false});
          camera.visible=false;resize();record('detector-ready',{markerWidth:measured,scale});
        });
        source=new AR.ArToolkitSource({sourceType:'webcam',sourceWidth:640,sourceHeight:480});
        const currentSource=source;
        run=true;starting=false;widthInput.disabled=true;lastFrame=-Infinity;placementAt=0;
        ui.phase.textContent='認識中';ui.stop.disabled=false;ui.replace.disabled=false;ui.recenter.disabled=false;
        ui.start.hidden=true;ui.loading.hidden=true;
        currentSource.init(()=>{
          if(token!==epoch){if(currentSource.domElement.srcObject)currentSource.domElement.srcObject.getTracks().forEach(t=>t.stop());currentSource.domElement.remove();return;}
          currentSource.domElement.style.zIndex='0';resize();
          record('camera-start',{width:currentSource.domElement.videoWidth,height:currentSource.domElement.videoHeight});
        },e=>{if(token===epoch)fail('カメラを開始できませんでした。',e);});
        function tick(time){
          if(!run||token!==epoch)return;raf=requestAnimationFrame(tick);
          if(time-lastFrame<1000/30-.5)return;lastFrame=time;
          if(!source.ready||!context.arController||!controls)return;
          const video=source.domElement;
          const orientation=video.videoWidth>video.videoHeight?'landscape':'portrait';
          if(context.arController.orientation!==orientation){context.arController.orientation=orientation;context.arController.options.orientation=orientation;resize();}
          const processed=context.update(video);
          if(!processed)return;
          const visible=!!camera.visible;
          if(visible!==detected){detected=visible;record(visible?'marker-found':'marker-lost',null);}
          frame[0]++;frame[1]=1;frame[2]=visible?1:0;frame[35]=visible?1:0;
          ui.phase.textContent=visible?'追跡中':'目印待ち';
          ui.status.textContent=visible?'紙のステージで遊べます。':'左の黒枠全体を映してください。';
          if(visible){
            camera.updateMatrixWorld(true);lastPose=performance.now();
            camera.position.toArray(frame,3);camera.quaternion.toArray(frame,6);
            frame.set(camera.projectionMatrix.elements,10);
            frame[38]=screen.orientation&&Number.isFinite(screen.orientation.angle)?screen.orientation.angle:(window.orientation||0);
            if(!placed&&time-placementAt>500){
              placementAt=time;
              send('PlaceFromMarker',JSON.stringify({position:{x:layout.stage.offsetXMeters*scale,y:0,z:layout.stage.offsetZMeters*scale},sizeMeters:layout.stage.outerWidthMeters*scale}));
            }
          }
        }
        raf=requestAnimationFrame(tick);
      }catch(e){if(token===epoch)fail('紙の目印を開始できませんでした。',e);}
    }
    ui.start.addEventListener('click',start);
    ui.stop.addEventListener('click',()=>{record('stop','user');stop();ui.status.textContent='終了しました。';});
    for(const button of [ui.replace,ui.recenter])button.addEventListener('click',()=>{placed=false;placementAt=0;send('ClearPlacement');record('replace',null);});
    ui.download.addEventListener('click',()=>{
      const data={prototype:'ARRollCapture-0.3.3-marker',savedAt:new Date().toISOString(),page:location.href,
        userAgent:navigator.userAgent,phase:run?'running':'stopped',error,tracking:detected,placed,
        config,layout,frame:Array.from(frame),unity:unityReport,game:window.RollCaptureBridge?RollCaptureBridge.snapshot():null,
        video:source?{width:source.domElement.videoWidth,height:source.domElement.videoHeight,rect:source.domElement.getBoundingClientRect().toJSON()}:null,
        canvas:canvas.getBoundingClientRect().toJSON(),alpha:unityAlpha,events};
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='roll-by-blow-marker-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    });
    window.addEventListener('resize',resize);
    document.addEventListener('visibilitychange',()=>{if(document.hidden){record('pause','page hidden');stop();}});
    window.addEventListener('pagehide',stop);
    canvas.addEventListener('webglcontextlost',()=>fail('描画が中断されました。ページを読み込み直してください。'));
    modules.catch(e=>fail('目印のデータを読み込めませんでした。',e));
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
      pixelRatio:1,
      captureContext:(kind,gl)=>{if(gl&&/webgl/.test(kind))installUnityAlphaGuard(gl);},
      progress:value=>{ui.progress.style.width=Math.round(value*100)+'%';},
      banner:(message,type)=>{record('unity-'+type,String(message));if(type==='error')fail('Unityの読み込みエラーです。',message);},
      fail,
      setUnity:instance=>{unity=instance;record('unity-ready',true);ready();},
      register:value=>{config=value;if(value.playerRevision!=='0.3.3'||!value.supportsMarkerPlacement||value.frameFloatCount!==39){fail('前回分を含む最新ソースから再ビルドし、Buildを一式公開してください。');return;}record('unity-registered',value);ready();},
      readFrame:()=>{
        if(!run||performance.now()-lastPose>250){frame[2]=0;frame[35]=0;}
        // Reject old players without ever writing beyond their legacy 38-float buffer.
        return config&&config.frameFloatCount===39?frame:legacyFrame;
      },
      report:value=>{unityReport=value;placed=!!value.placed;ui.metrics.textContent=JSON.stringify({provider:'AR.js',placed,tracking:detected,fps:value.fps,alpha:unityAlpha},null,2);},
      gameCommand:method=>{if(method==='ResetBall')send(method);},
      gameIsActive:()=>run&&placed&&detected&&performance.now()-lastPose<250&&frame[2]>.5
    };
  };
}());
