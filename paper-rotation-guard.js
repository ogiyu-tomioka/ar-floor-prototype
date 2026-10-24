/* Observe paper rotation independently; never change the AR pose or sensor permissions. */
(function(root){
  'use strict';
  const multiply=(a,b)=>({x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z});
  const unit=q=>{if(!q||![q.x,q.y,q.z,q.w].every(Number.isFinite))return null;
    const n=Math.hypot(q.x,q.y,q.z,q.w);return n>1e-8?{x:q.x/n,y:q.y/n,z:q.z/n,w:q.w/n}:null;};
  const axis=(x,y,z,degrees)=>{const a=degrees*Math.PI/360,s=Math.sin(a);return{x:x*s,y:y*s,z:z*s,w:Math.cos(a)};};
  const rotate=(p,q)=>{const a=multiply(multiply(q,{...p,w:0}),{x:-q.x,y:-q.y,z:-q.z,w:q.w});return{x:a.x,y:a.y,z:a.z};};
  const difference=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b))*180/Math.PI;
  function sensorCamera(sample,screenAngle){
    if(!sample||![sample.alpha,sample.beta,sample.gamma,screenAngle].every(Number.isFinite))return null;
    let q=multiply(axis(1,0,0,-90),axis(0,0,1,sample.alpha));
    q=multiply(q,axis(1,0,0,sample.beta));q=multiply(q,axis(0,1,0,sample.gamma));
    return unit(multiply(q,axis(0,0,1,-screenAngle)));
  }
  function create(options={}){
    const settings={enabled:true,pauseDegrees:18,resumeDegrees:8,confirmMs:600,resumeMs:600,calibrateMs:600,
      samplePeriodMs:100,sensorFreshMs:1200,maximumPhoneRotationRate:90,...options};
    let reference=null,calibration=null,calibrationAt=null,candidateAt=null,returnAt=null,lastAt=-Infinity;
    let lastScreen=null,screenHoldUntil=0,blocked=false,angle=0,reason='waiting-for-sensors',trips=0;
    let lastSensor=null,sensorAgeMs=null,motionAgeMs=null;
    function reset(){reference=calibration=calibrationAt=candidateAt=returnAt=null;lastAt=-Infinity;
      lastScreen=null;screenHoldUntil=0;blocked=false;angle=0;reason='waiting-for-sensors';trips=0;
      lastSensor=null;sensorAgeMs=motionAgeMs=null;}
    function observe({pose,sensor,sensorAt,motionAt,motionSpeed=0,clock,screenAngle=0,visible,normal}){
      if(!Number.isFinite(clock))return blocked;
      if(!settings.enabled){blocked=false;reason='disabled';return false;}
      if(clock-lastAt<settings.samplePeriodMs)return blocked;
      const gap=clock-lastAt;lastAt=clock;
      if(gap>500){candidateAt=returnAt=null;if(reference===null)calibrationAt=null;}
      const camera=pose&&unit(pose.rotation),native=sensorCamera(sensor,screenAngle);
      lastSensor=sensor;
      sensorAgeMs=Number.isFinite(sensorAt)?clock-sensorAt:null;
      motionAgeMs=Number.isFinite(motionAt)?clock-motionAt:null;
      const age=clock-Math.max(Number.isFinite(sensorAt)?sensorAt:-Infinity,Number.isFinite(motionAt)?motionAt:-Infinity);
      if(!camera||!native||!visible||!normal||age<0||age>settings.sensorFreshMs){
        candidateAt=returnAt=null;
        if(reference===null)calibrationAt=null;
        reason=!visible?'paper-not-visible':!normal?'tracking-unavailable':!camera?'pose-unavailable':'sensor-unavailable';
        return blocked;
      }
      if(lastScreen!==null&&lastScreen!==screenAngle){screenHoldUntil=clock+800;candidateAt=returnAt=null;}
      lastScreen=screenAngle;
      if(clock<screenHoldUntil){if(reference===null)calibrationAt=null;reason='screen-rotation-settling';return blocked;}
      if(Number.isFinite(motionAt)&&clock-motionAt<500&&motionSpeed>settings.maximumPhoneRotationRate){
        candidateAt=returnAt=null;if(reference===null)calibrationAt=null;reason='phone-moving-fast';return blocked;
      }
      // Board -> camera -> independent sensor frame. Common SDK world rotations cancel out.
      const boardToSensor=unit(multiply(native,{x:-camera.x,y:-camera.y,z:-camera.z,w:camera.w}));
      const heading=rotate({x:1,y:0,z:0},boardToSensor),up=rotate({x:0,y:1,z:0},boardToSensor);
      if(Math.hypot(heading.x,heading.z)<.5||Math.abs(up.y)<.7){candidateAt=returnAt=null;if(reference===null)calibrationAt=null;reason='paper-not-horizontal';return blocked;}
      const yaw=Math.atan2(heading.x,heading.z);
      if(reference===null){
        if(calibrationAt===null||Math.abs(difference(yaw,calibration))>4){calibration=yaw;calibrationAt=clock;}
        reason='calibrating';
        if(clock-calibrationAt>=settings.calibrateMs){reference=yaw;reason='armed';}
        return false;
      }
      angle=difference(yaw,reference);
      if(blocked){
        if(Math.abs(angle)<=settings.resumeDegrees){
          if(returnAt===null)returnAt=clock;
          reason='return-confirming';
          if(clock-returnAt>=settings.resumeMs){blocked=false;candidateAt=returnAt=null;reason='armed';}
        }else{returnAt=null;reason='paper-rotated';}
      }else if(Math.abs(angle)>=settings.pauseDegrees){
        if(candidateAt===null)candidateAt=clock;
        reason='rotation-confirming';
        if(clock-candidateAt>=settings.confirmMs){blocked=true;trips++;returnAt=null;reason='paper-rotated';}
      }else{candidateAt=null;reason='armed';}
      return blocked;
    }
    return{observe,reset,isBlocked:()=>blocked,snapshot:()=>({blocked,armed:reference!==null,angleDegrees:angle,reason,trips,
      screenAngle:lastScreen,sensorAgeMs,motionAgeMs,sensor:lastSensor?{...lastSensor}:null,settings})};
  }
  create.sensorCamera=sensorCamera;
  if(typeof module!=='undefined'&&module.exports)module.exports=create;else root.RollPaperRotationGuard=create;
}(typeof window==='undefined'?globalThis:window));
