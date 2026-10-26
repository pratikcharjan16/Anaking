(function(){
  'use strict';
  const controls=document.getElementById('builder-view-controls'); if(!controls)return;
  const outline=controls.querySelector('[name=outline]'),preview=controls.querySelector('[name=preview]'),width=controls.querySelector('[name=outline-width]');
  const widthValue=controls.querySelector('#builder-outline-width-value');
  try{const p=JSON.parse(localStorage.getItem('anaking.builder.layout')||'{}');outline.checked=p.outline!==false;preview.checked=p.preview!==false;width.value=p.width||270;}catch(e){}
  function apply(){
    const px=Math.max(210,Math.min(400,Number(width.value)||270));
    document.body.classList.toggle('studio-hide-outline',!outline.checked);
    document.body.classList.toggle('studio-hide-preview',!preview.checked);
    document.documentElement.style.setProperty('--outline-width',px+'px');
    if(widthValue)widthValue.value=px+' px';
    try{localStorage.setItem('anaking.builder.layout',JSON.stringify({outline:outline.checked,preview:preview.checked,width:px}));}catch(e){}
  }
  controls.addEventListener('input',apply);controls.addEventListener('change',apply);apply();
  function sync(){const slug=location.hash.slice(1);controls.querySelector('a').href='/workspace/'+(slug?'#'+encodeURIComponent(slug)+'/overview':'');}
  window.addEventListener('hashchange',sync);
  new MutationObserver(sync).observe(document.getElementById('st-root'),{childList:true});sync();
})();
