/* Project code. Uses only the public XR8 worldPoints API. */
(function () {
  'use strict';
  const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  const median = a => { const sorted = a.slice().sort((x,y) => x-y); return sorted[Math.floor(sorted.length/2)]; };
  const cross = (a,b,c) => (b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  function hull(points) {
    const sorted = points.slice().sort((a,b) => a.x-b.x || a.z-b.z);
    const lower=[], upper=[];
    sorted.forEach(p => { while(lower.length>1 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop(); lower.push(p); });
    sorted.reverse().forEach(p => { while(upper.length>1 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop(); upper.push(p); });
    lower.pop(); upper.pop(); return lower.concat(upper);
  }
  function inside(p, polygon, margin) {
    for(let i=0;i<polygon.length;i++) {
      const a=polygon[i], b=polygon[(i+1)%polygon.length];
      if(cross(a,b,p)<margin*Math.hypot(b.x-a.x,b.z-a.z)) return false;
    }
    return polygon.length>=3;
  }
  function visible(p, reality) {
    const q=reality.rotation, length=Math.hypot(q.x,q.y,q.z,q.w);
    if(length<1e-8) return false;
    const x=-q.x/length,y=-q.y/length,z=-q.z/length,w=q.w/length;
    const vx=p.x-reality.position.x,vy=p.y-reality.position.y,vz=p.z-reality.position.z;
    const tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);
    const cx=vx+w*tx+y*tz-z*ty,cy=vy+w*ty+z*tx-x*tz,cz=vz+w*tz+x*ty-y*tx;
    if(cz>=-.1) return false;
    const m=reality.intrinsics;
    const clipW=m[3]*cx+m[7]*cy+m[11]*cz+m[15];
    if(Math.abs(clipW)<1e-8) return false;
    const nx=(m[0]*cx+m[4]*cy+m[8]*cz+m[12])/clipW;
    const ny=(m[1]*cx+m[5]*cy+m[9]*cz+m[13])/clipW;
    return Math.abs(nx)<.92 && Math.abs(ny)<.9;
  }
  window.RollTableEstimator = function (config) {
    const minWidth=Math.max(.15, config.minimumStageWidth || .28);
    const maxWidth=Math.max(minWidth, config.maximumStageWidth || .5);
    const margin=Math.max(.01, config.tableEdgeMargin || .04);
    const stableSeconds=config.tableStableSeconds || .8;
    const minPoints=Math.max(8, config.tableMinimumPoints || 18);
    let since=0, reference=null, lastClock=0, stats={reason:'not-started'};
    function reset() { since=0; reference=null; lastClock=0; stats={reason:'not-started'}; }
    function reject(reason) { since=0; reference=null; stats.reason=reason; return null; }
    function observe(reality, clock) {
      if(lastClock && clock-lastClock>700) { since=0; reference=null; }
      lastClock=clock;
      const raw=Array.isArray(reality.worldPoints) ? reality.worldPoints : [];
      stats={reason:'collecting',received:raw.length,visible:0,inliers:0,hullArea:0,stableSeconds:0};
      const unique=new Map();
      // A bounded sample avoids sorting the entire world map on a phone.
      const stride=Math.max(1,Math.ceil(raw.length/600));
      for(let i=0;i<raw.length;i+=stride) {
        const item=raw[i],p=item && item.position;
        if(!valid(p) || reality.position.y-p.y<.12 || reality.position.y-p.y>2
          || Math.hypot(p.x-reality.position.x,p.z-reality.position.z)>2 || !visible(p,reality)) continue;
        const key=[Math.round(p.x/.012),Math.round(p.y/.012),Math.round(p.z/.012)].join(',');
        unique.set(key,p);
      }
      const points=Array.from(unique.values()); stats.visible=points.length;
      if(points.length<minPoints) return reject(raw.length?'more-points':'no-world-points');
      const bins=new Map();
      points.forEach(p => { const key=Math.round(p.y/.025); bins.set(key,(bins.get(key)||0)+1); });
      const levels=Array.from(bins.entries()).filter(pair=>pair[1]>=Math.max(5,minPoints*.4))
        .sort((a,b)=>b[0]-a[0]);
      let chosen=null;
      for(const level of levels.slice(0,40)) {
        let group=points.filter(p=>Math.abs(p.y-level[0]*.025)<.025);
        if(group.length<minPoints) continue;
        const y=median(group.map(p=>p.y));
        group=group.filter(p=>Math.abs(p.y-y)<.014);
        if(group.length<minPoints) continue;
        const polygon=hull(group);
        if(polygon.length<3) continue;
        let area=0;
        for(let i=0;i<polygon.length;i++) area+=polygon[i].x*polygon[(i+1)%polygon.length].z-polygon[(i+1)%polygon.length].x*polygon[i].z;
        area=Math.abs(area)*.5;
        if(area<(minWidth+margin*2)**2) continue;
        const center={x:polygon.reduce((s,p)=>s+p.x,0)/polygon.length,y:y,
          z:polygon.reduce((s,p)=>s+p.z,0)/polygon.length};
        let fx=reality.position.x-center.x,fz=reality.position.z-center.z;
        const length=Math.hypot(fx,fz); if(length<.05) continue;
        fx/=length;fz/=length;
        const fits=width => {
          for(const sx of [-1,1]) for(const sz of [-1,1]) {
            const p={x:center.x+(sx*fz+sz*fx)*width/2,z:center.z+(-sx*fx+sz*fz)*width/2};
            if(!inside(p,polygon,margin)) return false;
          }
          return true;
        };
        if(!fits(minWidth)) continue;
        // Require observations around the center, not a narrow line or one corner.
        const quadrants=new Set(group.map(p=>(p.x>center.x?1:0)+(p.z>center.z?2:0)));
        if(quadrants.size<4) continue;
        let lo=minWidth,hi=maxWidth;
        for(let i=0;i<9;i++) { const middle=(lo+hi)/2; if(fits(middle))lo=middle;else hi=middle; }
        chosen={position:center,sizeMeters:lo,facing:{x:fx,y:0,z:fz},polygon:polygon,inliers:group.length,area:area};
        break;
      }
      if(!chosen) return reject('more-flat-area');
      const range=Math.hypot(chosen.position.x-reality.position.x,chosen.position.y-reality.position.y,chosen.position.z-reality.position.z);
      if(range<.15 || range>3) return reject('distance');
      stats.inliers=chosen.inliers; stats.hullArea=chosen.area;
      stats.planeY=chosen.position.y;stats.sizeMeters=chosen.sizeMeters;stats.center=chosen.position;
      if(!reference || Math.hypot(chosen.position.x-reference.position.x,chosen.position.z-reference.position.z)>.035
        || Math.abs(chosen.position.y-reference.position.y)>.015 || Math.abs(chosen.sizeMeters-reference.sizeMeters)>.04) {
        reference=chosen;since=clock;
      }
      stats.stableSeconds=(clock-since)/1000;
      stats.reason=stats.stableSeconds>=stableSeconds?'ready':'stabilizing';
      // Freeze the current fit, whose corners still lie inside the observed hull.
      return {position:chosen.position,sizeMeters:chosen.sizeMeters,facing:chosen.facing,
        distance:range,ready:stats.reason==='ready',type:'OBSERVED_HORIZONTAL_PATCH'};
    }
    return {observe:observe,reset:reset,snapshot:()=>JSON.parse(JSON.stringify(stats))};
  };
}());
