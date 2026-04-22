// ── Help Wizard ────────────────────────────────
(function(){
  const overlay=$('helpOverlay'),modal=$('helpModal');
  const steps=modal.querySelectorAll('.help-step');
  const dots=$('helpDots'),prevBtn=$('helpPrev'),nextBtn=$('helpNext');
  let current=0;

  // Build dots
  steps.forEach((_,i)=>{
    const dot=document.createElement('span');
    dot.className='help-dot'+(i===0?' active':'');
    dot.onclick=()=>goTo(i);
    dots.appendChild(dot);
  });

  function goTo(idx){
    current=Math.max(0,Math.min(idx,steps.length-1));
    steps.forEach((s,i)=>s.classList.toggle('active',i===current));
    dots.querySelectorAll('.help-dot').forEach((d,i)=>d.classList.toggle('active',i===current));
    prevBtn.style.visibility=current===0?'hidden':'visible';
    nextBtn.textContent=current===steps.length-1?'Done':'Next';
  }

  function openHelp(){overlay.classList.add('show');modal.classList.add('show');goTo(0);}
  function closeHelp(){overlay.classList.remove('show');modal.classList.remove('show');}

  $('btnHelp').onclick=openHelp;
  $('helpClose').onclick=closeHelp;
  overlay.onclick=closeHelp;
  prevBtn.onclick=()=>goTo(current-1);
  nextBtn.onclick=()=>{if(current===steps.length-1)closeHelp();else goTo(current+1);};
  document.addEventListener('keydown',e=>{
    if(!modal.classList.contains('show'))return;
    if(e.key==='Escape')closeHelp();
    if(e.key==='ArrowRight')goTo(current+1);
    if(e.key==='ArrowLeft')goTo(current-1);
  });
})();
