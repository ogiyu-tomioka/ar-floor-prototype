import * as THREE from 'three';
export function makeReference() {
  const root=new THREE.Group();
  const box=new THREE.Mesh(new THREE.BoxGeometry(.06,.06,.06),new THREE.MeshBasicMaterial({color:0x64d8c3}));
  box.position.y=.03;root.add(box);
  const grid=new THREE.GridHelper(.24,4,0xffd375,0x9bd2c9);root.add(grid);
  root.add(new THREE.AxesHelper(.12));
  return root;
}
export function capturePose(camera, reference) {
  camera.updateMatrixWorld(true);reference.updateMatrixWorld(true);
  return {camera:camera.position.toArray(),rotation:camera.quaternion.toArray(),cameraScale:camera.scale.toArray(),projection:camera.projectionMatrix.toArray(),
    view:camera.matrixWorldInverse.toArray(),anchor:reference.position.toArray(),anchorScale:reference.scale.toArray(),
    anchorRotation:reference.quaternion.toArray(),distance:camera.position.distanceTo(reference.position),visible:reference.visible};
}
