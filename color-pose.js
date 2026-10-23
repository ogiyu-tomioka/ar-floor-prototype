/* Coordinates: engine world -> image XY plane -> board XZ plane, in printed metres. */
(function(root){
  'use strict';
  const multiply=(a,b)=>({x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z});
  const normalize=q=>{if(!q||![q.x,q.y,q.z,q.w].every(Number.isFinite))return null;
    const n=Math.hypot(q.x,q.y,q.z,q.w);return n>1e-8?{x:q.x/n,y:q.y/n,z:q.z/n,w:q.w/n}:null;};
  const rotate=(p,q)=>{const t=multiply(multiply(q,{...p,w:0}),{x:-q.x,y:-q.y,z:-q.z,w:q.w});return {x:t.x,y:t.y,z:t.z};};
  const basePlaneToBoard={x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2};
  function cameraInBoard(camera,anchor,printedWidth){
    if(!camera||!anchor||![camera.position?.x,camera.position?.y,camera.position?.z,
      anchor.position?.x,anchor.position?.y,anchor.position?.z,printedWidth,anchor.scale,anchor.scaledWidth].every(Number.isFinite))return null;
    const aq=normalize(anchor.rotation),cq=normalize(camera.rotation);
    const width=anchor.scaledWidth*anchor.scale;
    if(!aq||!cq||width<=1e-6||printedWidth<=0)return null;
    const regionRatio=anchor.widthRatio===undefined?1:anchor.widthRatio;
    const offsetX=anchor.offsetXRatio===undefined?0:anchor.offsetXRatio;
    const offsetZ=anchor.offsetZRatio===undefined?0:anchor.offsetZRatio;
    const degrees=anchor.imagePlaneRotationDegrees===undefined?0:anchor.imagePlaneRotationDegrees;
    if(![regionRatio,offsetX,offsetZ,degrees].every(Number.isFinite)||regionRatio<=0)return null;
    const radians=degrees*Math.PI/360;
    const planeToBoard=multiply(basePlaneToBoard,{x:0,y:0,z:Math.sin(radians),w:Math.cos(radians)});
    const inverse={x:-aq.x,y:-aq.y,z:-aq.z,w:aq.w},factor=printedWidth*regionRatio/width;
    const relative=rotate({x:camera.position.x-anchor.position.x,y:camera.position.y-anchor.position.y,z:camera.position.z-anchor.position.z},inverse);
    const position=rotate(relative,planeToBoard);
    for(const key of ['x','y','z'])position[key]*=factor;
    position.x+=offsetX*printedWidth;position.z+=offsetZ*printedWidth;
    const rotation=normalize(multiply(planeToBoard,multiply(inverse,cq)));
    return {position,rotation,metersPerWorldUnit:factor};
  }
  const api={cameraInBoard};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.RollColorPose=api;
}(typeof window==='undefined'?globalThis:window));
