(function () {
  'use strict';
  const trackers = new WeakMap();
  const unitScale = {x:1,y:1,z:1};

  function filter(owner, matrix, three, now) {
    let state = trackers.get(owner);
    if (!state) {
      state = {
        matrix:new three.Matrix4(),
        position:new three.Vector3(), rotation:new three.Quaternion(),
        samplePosition:new three.Vector3(), sampleRotation:new three.Quaternion(), sampleScale:new three.Vector3(),
        candidatePosition:new three.Vector3(), candidateRotation:new three.Quaternion(),
        lastAt:null, candidateAt:null, candidateCount:0,
      };
      trackers.set(owner,state);
    }
    if (!matrix.elements.every(Number.isFinite)) return state.lastAt===null ? null : state.matrix;
    const {samplePosition, sampleRotation, sampleScale} = state;
    matrix.decompose(samplePosition,sampleRotation,sampleScale);
    if (![sampleScale.x,sampleScale.y,sampleScale.z].every(value=>value>.5&&value<1.5)) {
      return state.lastAt===null ? null : state.matrix;
    }
    sampleRotation.normalize();
    const gap = state.lastAt===null ? Infinity : now-state.lastAt;
    state.lastAt=now;
    const reappeared = gap>260;
    const shiftLimit=Math.max(30,Math.abs(state.position.z)*.13);
    const jump=state.position.distanceTo(samplePosition)>shiftLimit || state.rotation.angleTo(sampleRotation)>.61;
    if (!reappeared && jump) {
      const agrees=state.candidateAt!==null &&
        state.candidatePosition.distanceTo(samplePosition)<shiftLimit*.55 &&
        state.candidateRotation.angleTo(sampleRotation)<.26;
      if (!agrees) {
        state.candidateAt=now;
        state.candidateCount=0;
      }
      state.candidatePosition.copy(samplePosition);
      state.candidateRotation.copy(sampleRotation);
      state.candidateCount++;
      if (state.candidateCount<3 || now-state.candidateAt<95) return state.matrix;
    }
    state.candidateAt=null;
    state.candidateCount=0;
    if (reappeared || jump) {
      state.position.copy(samplePosition);
      state.rotation.copy(sampleRotation);
    } else {
      const weight=1-Math.exp(-Math.min(75,Math.max(1,gap))/88);
      state.position.lerp(samplePosition,weight);
      state.rotation.slerp(sampleRotation,weight);
    }
    return state.matrix.compose(state.position,state.rotation,unitScale);
  }

  window.RollNftPose={filter,reset:owner=>trackers.delete(owner)};
}());
