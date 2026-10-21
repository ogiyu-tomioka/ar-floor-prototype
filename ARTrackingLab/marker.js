import * as THREE from 'three';
import {ArToolkitSource,ArToolkitContext,ArMarkerControls} from 'threex';
import {createLab} from './lab.js';
import {makeReference,capturePose} from './objects.js';
const lab=createLab('marker',{provider:'AR.js-3.4.8',scale:'known-marker-width',detectionTargetFps:30,renderTargetFps:30,
  unity:false,sensorRotationOverride:false,smoothing:false});
const widthInput=document.getElementById('marker-width');
let source,context,renderer,controls,raf=0,reference,scene,camera,seen=false,lastVisible=false,contextStarted=false;
function resize(){
  if(!source||!source.ready||!renderer)return;
  source.onResizeElement();source.copyElementSizeTo(renderer.domElement);
  if(context&&context.arController)source.copyElementSizeTo(context.arController.canvas);
  lab.event('resize',{width:innerWidth,height:innerHeight,videoWidth:source.domElement.videoWidth,videoHeight:source.domElement.videoHeight});
}
function initContext(){
  if(contextStarted||!lab.active()||source.domElement.videoWidth===0)return;contextStarted=true;
  context=new ArToolkitContext({cameraParametersUrl:'vendor/camera_para.dat',detectionMode:'mono',maxDetectionRate:30});
  context.init(()=>{
    if(!lab.active()){if(context.arController&&typeof context.arController.dispose==='function')context.arController.dispose();return;}
    const orientation=source.domElement.videoWidth>source.domElement.videoHeight?'landscape':'portrait';
    context.arController.orientation=orientation;context.arController.options.orientation=orientation;
    camera.projectionMatrix.copy(context.getProjectionMatrix());
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    controls=new ArMarkerControls(context,camera,{type:'pattern',patternUrl:'vendor/patt.hiro',
      size:lab.data.settings.markerWidthMeters,changeMatrixMode:'cameraTransformMatrix',smooth:false});
    camera.visible=false;resize();lab.event('detector-ready',{orientation});
  });
}
lab.ready(async()=>{
  const width=Number(widthInput.value)/100;
  if(!Number.isFinite(width)||width<.05||width>.4)throw new Error('黒枠の外幅を5〜40cmで入力してください。');
  // Image tracking needs only the camera. Device orientation is logged if already available, never fused into the pose.
  if(!isSecureContext||!navigator.mediaDevices)throw new Error('HTTPSのページをSafariで開いてください。');
  lab.data.settings.markerWidthMeters=width;lab.data.detectionUpdates=0;widthInput.disabled=true;
  scene=new THREE.Scene();camera=new THREE.Camera();camera.visible=false;scene.add(camera);
  reference=makeReference();scene.add(reference);reference.visible=false;
  renderer=new THREE.WebGLRenderer({canvas:document.getElementById('view'),alpha:true,antialias:false});
  renderer.setPixelRatio(1);renderer.setClearColor(0x000000,0);renderer.setSize(innerWidth,innerHeight);
  lab.begin(()=>{
    cancelAnimationFrame(raf);widthInput.disabled=false;
    if(source){document.body.removeEventListener('click',source.onInitialClick);if(source.ready)source.dispose();}
    if(controls)controls.dispose();
    if(context&&context.arController&&typeof context.arController.dispose==='function')context.arController.dispose();
    renderer.dispose();
  });
  source=new ArToolkitSource({sourceType:'webcam',sourceWidth:innerWidth>innerHeight?640:480,sourceHeight:innerWidth>innerHeight?480:640});
  source.init(()=>{
    if(!lab.active()){
      if(source.domElement&&source.domElement.srcObject)source.domElement.srcObject.getTracks().forEach(t=>t.stop());
      source.dispose();return;
    }
    source.domElement.addEventListener('loadedmetadata',initContext,{once:true});
    source.domElement.addEventListener('canplay',initContext,{once:true});
    initContext();resize();
  },e=>lab.fail(e||'カメラを開始できませんでした。'));
  let lastFrame=-Infinity;
  function frame(clock){
    if(!lab.active())return;raf=requestAnimationFrame(frame);
    if(clock-lastFrame<1000/30-.5)return;lastFrame=clock;
    if(!source.ready||!context||!context.arController||!controls)return;
    const detectionProcessed=context.update(source.domElement);
    if(detectionProcessed)lab.data.detectionUpdates++;
    reference.visible=!!camera.visible;
    if(reference.visible&&!seen){seen=true;lab.armStop(20000);lab.event('first-marker',capturePose(camera,reference));}
    if(reference.visible!==lastVisible){lastVisible=reference.visible;lab.event(reference.visible?'marker-found':'marker-lost',null);}
    lab.ui.status.textContent=reference.visible?'目印を追跡中。前傾→元の持ち方へ。':'黒枠全体を映してください。';
    lab.sample({...capturePose(camera,reference),tracking:reference.visible?'marker-visible':'marker-lost',detectionProcessed,
      video:{width:source.domElement.videoWidth,height:source.domElement.videoHeight},
      rendering:{canvasWidth:renderer.domElement.width,canvasHeight:renderer.domElement.height,
        videoRect:source.domElement.getBoundingClientRect().toJSON(),canvasRect:renderer.domElement.getBoundingClientRect().toJSON()}});
    renderer.render(scene,camera);
  }
  raf=requestAnimationFrame(frame);
});
window.addEventListener('resize',resize);
