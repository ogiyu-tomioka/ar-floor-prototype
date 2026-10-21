// Surface import failures even when the module containing the diagnostic UI cannot load.
window.addEventListener('error',function(event){
  const box=document.getElementById('error');
  if(box)box.textContent=event.message||('ファイルを読み込めませんでした: '+(event.target.src||event.target.href||''));
},true);
window.addEventListener('unhandledrejection',function(event){
  const box=document.getElementById('error');if(box)box.textContent=String(event.reason);
});
