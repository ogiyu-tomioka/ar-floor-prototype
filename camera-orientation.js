/* Project code. Device axes and intrinsic Z-X-Y rotations follow W3C Device Orientation. */
(function () {
  'use strict';
  function multiply(a,b) {
    return {x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
      y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
      z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
      w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z};
  }
  function unit(q) {
    const n=Math.hypot(q.x,q.y,q.z,q.w);
    return n>.00001 ? {x:q.x/n,y:q.y/n,z:q.z/n,w:q.w/n} : null;
  }
  function axis(x,y,z,degrees) {
    const a=degrees*Math.PI/360,s=Math.sin(a);
    return {x:x*s,y:y*s,z:z*s,w:Math.cos(a)};
  }
  function sensorCamera(sample) {
    if(!sample||![sample.alpha,sample.beta,sample.gamma].every(Number.isFinite))return null;
    // Earth Z-up -> XR Y-up. Camera optical forward is device -Z.
    let q=multiply(axis(1,0,0,-90),axis(0,0,1,sample.alpha));
    q=multiply(q,axis(1,0,0,sample.beta));
    q=multiply(q,axis(0,1,0,sample.gamma));
    return unit(multiply(q,axis(0,0,1,-(sample.screenAngle||0))));
  }
  window.RollCameraOrientation = function () {
    let offset=null,source='not-started',difference=0,output=null,sensorAge=null;
    function reset(){offset=null;source='not-started';output=null;difference=0;sensorAge=null;}
    function correct(reality,sample,clock,locked,enabled) {
      const raw=unit(reality.rotation);
      if(!raw){source='invalid-sdk-rotation';return null;}
      if(!enabled){source='sdk';output=raw;return raw;}
      const native=sensorCamera(sample);
      sensorAge=sample ? clock-sample.clock : null;
      const available=native && sensorAge>=0;
      if(!locked) {
        if(available)offset=multiply(raw,{x:-native.x,y:-native.y,z:-native.z,w:native.w});
        else offset=null;
        source=available?'calibrating':'waiting-for-sensor';output=raw;return raw;
      }
      // Browsers may omit orientation events while the device is motionless.
      if(!native||!offset){source='sensor-not-ready';return null;}
      output=unit(multiply(offset,native));
      const dot=Math.abs(output.x*raw.x+output.y*raw.y+output.z*raw.z+output.w*raw.w);
      difference=2*Math.acos(Math.min(1,dot))*180/Math.PI;
      source=sensorAge>250?'device-orientation-held':'device-orientation';return output;
    }
    return {correct:correct,reset:reset,snapshot:()=>({source:source,calibrated:!!offset,
      sdkDifferenceDegrees:difference,sensorAgeMs:sensorAge,output:output,offset:offset})};
  };
}());
