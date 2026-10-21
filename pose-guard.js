/* Project code: reject discontinuous poses; never fabricate a world origin. */
(function () {
  'use strict';
  window.RollPoseGuard = function () {
    const settings={maximumTravel:1.25,stepAllowance:.06,maximumSpeed:2.5,
      angleAllowance:25,maximumAngularSpeed:720,rejoinDistance:.08,rejoinAngle:15,recoverySeconds:.6};
    let trusted=null, origin=null, blocked=false, recoveryAt=0, rejected=0, reason='not-started';
    let raw=null, lastDelta=0, lastAngle=0;
    const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
    const point=p=>({x:p.x,y:p.y,z:p.z});
    function angle(a,b) {
      const lengths=Math.hypot(a.x,a.y,a.z,a.w)*Math.hypot(b.x,b.y,b.z,b.w);
      if(lengths<1e-6)return 180;
      return 2*Math.acos(Math.min(1,Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w)/lengths))*180/Math.PI;
    }
    function reset() { trusted=origin=raw=null;blocked=false;recoveryAt=0;rejected=0;reason='not-started';lastDelta=lastAngle=0; }
    function reject(why) { reason=why;blocked=true;recoveryAt=0;rejected++;return false; }
    function observe(reality,clock,placed) {
      raw={position:point(reality.position),rotation:Object.assign({},reality.rotation),clock:clock};
      if(reality.trackingStatus!=='NORMAL'||reality.trackingReason==='INITIALIZING') {
        if(placed && trusted)return reject('sdk-tracking-lost');
        reason='initializing';return false;
      }
      if(Math.hypot(reality.rotation.x,reality.rotation.y,reality.rotation.z,reality.rotation.w)<.001)
        return reject('invalid-rotation');
      if(placed && trusted) {
        if(!origin)origin=point(trusted.position);
        lastDelta=dist(raw.position,trusted.position);lastAngle=angle(raw.rotation,trusted.rotation);
        if(dist(raw.position,origin)>settings.maximumTravel)return reject('outside-play-range');
        if(blocked) {
          if(lastDelta>settings.rejoinDistance||lastAngle>settings.rejoinAngle)return reject('world-not-rejoined');
          if(!recoveryAt)recoveryAt=clock;
          reason='recovering';
          if(clock-recoveryAt<settings.recoverySeconds*1000)return false;
          blocked=false;recoveryAt=0;
        } else {
          const dt=Math.min(.2,Math.max(0,(clock-trusted.clock)/1000));
          if(lastDelta>settings.stepAllowance+settings.maximumSpeed*dt)return reject('position-jump');
          if(lastAngle>settings.angleAllowance+settings.maximumAngularSpeed*dt)return reject('rotation-jump');
        }
      }
      if(!placed) { blocked=false;recoveryAt=0;origin=null; }
      trusted={position:point(raw.position),rotation:Object.assign({},raw.rotation),clock:clock};
      reason='accepted';return true;
    }
    return {observe:observe,reset:reset,invalidate:why=>{if(trusted&&!blocked)reject(why);},snapshot:()=>({reason:reason,blocked:blocked,rejected:rejected,
      deltaMeters:lastDelta,deltaDegrees:lastAngle,settings:settings,raw:raw,trusted:trusted,origin:origin})};
  };
}());
