import * as THREE from 'three';
import {createLab} from './lab.js';
import {makeReference,capturePose} from './objects.js';
window.THREE=THREE;
const scale=new URLSearchParams(location.search).get('scale')==='responsive'?'responsive':'absolute';
const lab=createLab('world',{provider:'8th-wall-same-binary-as-0.3.2',scale,loop:'sdk-standard',unity:false,
  sensorRotationOverride:false,automaticTablePlacement:false,referenceDistance:.6});
const canvas=document.getElementById('view'),fix=document.getElementById('anchor');
canvas.width=innerWidth;canvas.height=innerHeight;
let camera,reference,lastReality=null;
function engineReady(){
  lab.ready(async()=>{
    await lab.permissions();
    if(document.hidden)return;
    XR8.XrController.configure({disableWorldTracking:false,enableLighting:false,enableWorldPoints:false,
      leftHandedAxes:false,mirroredDisplay:false,scale});
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),XR8.Threejs.pipelineModule(),XR8.XrController.pipelineModule(),
      {name:'tracking-baseline',
        onStart:()=>{
          if(!lab.active()){XR8.stop();return;}
          const xr=XR8.Threejs.xrScene();camera=xr.camera;
          xr.renderer.setPixelRatio(1);xr.renderer.setSize(innerWidth,innerHeight,false);
          camera.position.set(0,1.5,0);camera.quaternion.identity();
          reference=makeReference();reference.visible=false;xr.scene.add(reference);
          // One initial coordinate definition. No recenter, sensor override or pose clamp afterwards.
          XR8.XrController.updateCameraProjectionMatrix({origin:camera.position,facing:camera.quaternion});
          lab.ui.status.textContent='机を映し、端末をゆっくり前後へ動かしてください。';
        },
        onUpdate:({processCpuResult})=>{
          if(!lab.active())return;
          const raw=processCpuResult&&processCpuResult.reality;if(!raw||!camera||!reference)return;
          lastReality=raw;
          const valid=raw.position&&raw.rotation&&raw.intrinsics&&raw.intrinsics.length===16
            &&[...Object.values(raw.position),...Object.values(raw.rotation),...raw.intrinsics].every(Number.isFinite);
          const normal=raw.trackingStatus==='NORMAL'&&raw.trackingReason!=='INITIALIZING';
          fix.disabled=!normal||!valid||!!lab.data.anchor;
          if(valid){
            // All three values come from the same reality object, in SDK right-handed coordinates.
            camera.position.set(raw.position.x,raw.position.y,raw.position.z);
            camera.quaternion.set(raw.rotation.x,raw.rotation.y,raw.rotation.z,raw.rotation.w).normalize();
            camera.projectionMatrix.fromArray(raw.intrinsics);camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
            lab.sample({...capturePose(camera,reference),tracking:raw.trackingStatus+'/'+raw.trackingReason});
          }
          const status=!lab.data.anchor?(normal?'認識中。「基準を固定」を押してください。':'初期認識中…'):
            !normal?'追跡が不十分です。元の持ち方へ戻してください。':'前傾してから元の持ち方へ。位置と大きさを比較してください。';
          if(lab.ui.status.textContent!==status)lab.ui.status.textContent=status;
        },
        onCanvasSizeChange:r=>lab.event('viewport-change',{width:r.canvasWidth,height:r.canvasHeight}),
        onCameraStatusChange:r=>{lab.event('camera',r.status);if(r.status==='failed')lab.fail('カメラを開始できませんでした。');},
        onException:e=>lab.fail(e)
      }
    ]);
    lab.begin(()=>{fix.disabled=true;XR8.stop();});
    await XR8.run({canvas,webgl2:true,ownRunLoop:true,allowedDevices:XR8.XrConfig.device().MOBILE,
      cameraConfig:{direction:XR8.XrConfig.camera().BACK},glContextConfig:{alpha:false,antialias:false}});
  });
}
fix.onclick=()=>{
  if(!lab.active()||!camera||!lastReality||lab.data.anchor)return;
  const direction=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  reference.position.copy(camera.position).addScaledVector(direction,.6);reference.visible=true;
  lab.data.anchor={...capturePose(camera,reference),fixedAt:new Date().toISOString()};
  lab.event('reference-fixed',lab.data.anchor);lab.armStop(20000);fix.disabled=true;
  lab.ui.hint.textContent='立体は仮想空間に固定しました。机面を認識して置いたものではありません。位置をほぼ変えず、前傾→元の持ち方へ。';
};
const sdk=document.createElement('script');sdk.src='vendor/xr/xr.js';sdk.async=true;sdk.dataset.preloadChunks='slam';
sdk.onerror=()=>lab.fail('ARエンジンを読み込めません。vendor/xrも公開してください。');
window.addEventListener('xrloaded',engineReady,{once:true});document.head.appendChild(sdk);
