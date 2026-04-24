// Batch queue badge — poll config for queue length changes (Telegram-driven)
setInterval(async()=>{
  try{
    const cfg=await window.api.loadConfig();
    const badge=document.getElementById('batchBadge');
    const count=document.getElementById('batchCount');
    if(badge&&count){
      const qLen=cfg?.batch?.queue?.length||0;
      badge.style.display=qLen>0?'inline-block':'none';
      count.textContent=qLen;
    }
  }catch{}
},5000);
// ── Claude Code Manager ─────────────────────────
(function(){
  const _t0=Date.now(), _ts=()=>`+${Date.now()-_t0}ms`;
  const logCcm=(level,...parts)=>{
    try{
      if(window.api&&typeof window.api.logToFile==='function'){
        const msg=parts.map(p=>typeof p==='string'?p:JSON.stringify(p)).join(' ');
        window.api.logToFile(level,'ccm',`${_ts()} ${msg}`);
      }
    }catch{}
  };
  try{
  logCcm('info','IIFE start');
  const overlay=$('ccmOverlay'),modal=$('ccmModal'),body=$('ccmBody');
  const badge=$('ccBadge'),badgeText=$('ccBadgeText');
  logCcm('info','elements', {overlay:!!overlay, modal:!!modal, body:!!body, badge:!!badge, badgeText:!!badgeText});
  if(!badge||!badgeText||!overlay||!modal||!body){logCcm('error','Missing DOM elements — aborting');return}
  if(!window.api||typeof window.api.detectClaudeCode!=='function'){logCcm('error','window.api.detectClaudeCode not available');return}
  let ccState=null, activeTab='overview';

  badge.onclick=()=>{logCcm('info','badge clicked');openModal()};
  badge._ccmClickWired=true;
  $('ccmClose').onclick=closeModal;
  overlay.onclick=closeModal;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('show'))closeModal()});

  // Tab switching
  $('ccmTabs').addEventListener('click',e=>{
    const tab=e.target.closest('.ccm-tab');
    if(!tab||tab.classList.contains('disabled'))return;
    activeTab=tab.dataset.tab;
    $('ccmTabs').querySelectorAll('.ccm-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    renderTab();
  });

  async function openModal(){
    try{
      const p=window.api.detectClaudeCode();
      const timeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),6000));
      ccState=await Promise.race([p,timeout]);
    }catch{
      if(!ccState) ccState={installed:false,authType:null,authDetail:null};
    }
    overlay.classList.add('show');modal.classList.add('show');
    updateTabs();renderTab();
  }
  function closeModal(){overlay.classList.remove('show');modal.classList.remove('show')}

  // Expose function for Setup dialog to open CCM at auth step
  window._ccmOpenAuth=async function(){
    try{
      const p=window.api.detectClaudeCode();
      const timeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),6000));
      ccState=await Promise.race([p,timeout]);
    }catch{
      if(!ccState) ccState={installed:false,authType:null,authDetail:null};
    }
    overlay.classList.add('show');modal.classList.add('show');
    activeTab='overview';
    updateTabs();
    wizardStep=2;renderAuthStep();
  };

  function updateTabs(){
    const tabs=$('ccmTabs').querySelectorAll('.ccm-tab');
    tabs.forEach(t=>{
      if(!ccState.installed&&t.dataset.tab!=='overview'){
        t.classList.add('disabled');
      } else {
        t.classList.remove('disabled');
      }
    });
    // If not installed, rename Overview to Setup
    tabs[0].textContent=ccState.installed?'Overview':'Setup';
    if(!ccState.installed)activeTab='overview';
  }

  function renderTab(){
    if(activeTab==='overview') renderOverview();
    else if(activeTab==='settings') renderSettingsEditor();
    else if(activeTab==='plugins') renderPlugins();
  }

  async function refreshBadge(){
    logCcm('info','refreshBadge: start');
    try{
      logCcm('info','refreshBadge: calling detectClaudeCode (timeout 8s)');
      const p=window.api.detectClaudeCode();
      const timeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error('detect-timeout')),8000));
      ccState=await Promise.race([p,timeout]);
      logCcm('info','refreshBadge: detectClaudeCode resolved', ccState);
      if(ccState.installed){
        badge.className='cc-badge installed';
        badgeText.textContent='Claude Code v'+(ccState.version||'?');
        logCcm('info','refreshBadge: badge set to installed, now checking updates (timeout 15s)');
        try{
          const updP=window.api.checkClaudeUpdate();
          const updTimeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error('update-check-timeout')),15000));
          const upd=await Promise.race([updP,updTimeout]);
          logCcm('info','refreshBadge: checkClaudeUpdate resolved', upd);
          if(upd&&upd.updateAvailable){
            badge.className='cc-badge update-available';
            badgeText.textContent='Claude Code v'+(ccState.version||'?')+' ⬆ Update';
          }
        }catch(ue){logCcm('warn','refreshBadge: update check failed/timed out:',ue?.message||ue)}
      } else {
        logCcm('info','refreshBadge: not installed');
        badge.className='cc-badge missing';
        badgeText.textContent='Claude Code missing';
      }
    }catch(err){
      logCcm('error','refreshBadge: error:',err?.message||err);
      badge.className='cc-badge missing';
      badgeText.textContent='Claude Code missing';
    }
    logCcm('info','refreshBadge: done, badge=',badgeText.textContent);
  }
  refreshBadge();

  // ── Overview / Setup Tab ──────────────────────
  function renderOverview(){
    if(!ccState.installed){renderWizard();return}
    body.innerHTML=`
      <div class="ccm-grid">
        <div class="ccm-card"><div class="ccm-card-label">Status</div><div class="ccm-card-value" style="color:var(--grn)">● Installed</div></div>
        <div class="ccm-card"><div class="ccm-card-label">Version</div><div class="ccm-card-value">${esc(ccState.version||'unknown')}</div></div>
      </div>
      <div class="ccm-card"><div class="ccm-card-label">Path</div><div class="ccm-card-value" style="font-family:monospace;font-size:12px">${esc(ccState.path||'on PATH')}</div></div>
      <div class="ccm-card"><div class="ccm-card-row"><div><div class="ccm-card-label">Auth</div><div class="ccm-card-value">${formatAuth()}</div></div><button class="ccm-link" id="ccmChangeAuth">Change ›</button></div></div>
      <div class="ccm-card" id="ccmUpdateCard"><div class="ccm-card-row"><div><div class="ccm-card-label">Update</div><div class="ccm-card-value" id="ccmUpdateStatus" style="color:var(--tx3)">Checking for updates...</div></div><span id="ccmUpdateAction"></span></div></div>
      <div class="ccm-card" id="ccmPluginUpdateCard"><div class="ccm-card-label">Plugin Updates</div><div id="ccmPluginUpdateBody" style="color:var(--tx3);font-size:11px">Checking plugins...</div></div>
    `;
    const changeBtn=body.querySelector('#ccmChangeAuth');
    if(changeBtn)changeBtn.onclick=()=>renderAuthStep();

    // Check for updates
    const statusEl=body.querySelector('#ccmUpdateStatus');
    const actionEl=body.querySelector('#ccmUpdateAction');
    (async()=>{
      try{
        const upd=await window.api.checkClaudeUpdate();
        if(upd.error){
          statusEl.textContent='Check failed';statusEl.style.color='var(--red)';
          actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Retry ›</button>';
          body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
        } else if(upd.updateAvailable){
          statusEl.innerHTML='⬆ v'+esc(upd.latestVersion)+' available';statusEl.style.color='var(--ylw)';
          actionEl.innerHTML='<button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmDoUpdate">Update Now</button>';
          body.querySelector('#ccmDoUpdate').onclick=()=>doUpdate(upd.latestVersion);
        } else {
          statusEl.textContent='✓ Up to date';statusEl.style.color='var(--grn)';
          actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Check Again ›</button>';
          body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
        }
      }catch{
        statusEl.textContent='Check failed';statusEl.style.color='var(--red)';
        actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Retry ›</button>';
        body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
      }
    })();
    doPluginUpdateCheck(false);

    async function doUpdateCheck(force){
      statusEl.textContent='Checking for updates...';statusEl.style.color='var(--tx3)';actionEl.innerHTML='';
      doPluginUpdateCheck(true);
      try{
        const upd=await window.api.checkClaudeUpdate({forceCheck:force});
        if(upd.updateAvailable){
          statusEl.innerHTML='⬆ v'+esc(upd.latestVersion)+' available';statusEl.style.color='var(--ylw)';
          actionEl.innerHTML='<button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmDoUpdate">Update Now</button>';
          body.querySelector('#ccmDoUpdate').onclick=()=>doUpdate(upd.latestVersion);
        } else {
          statusEl.textContent='✓ Up to date';statusEl.style.color='var(--grn)';
          actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Check Again ›</button>';
          body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
        }
      }catch{
        statusEl.textContent='Check failed';statusEl.style.color='var(--red)';
        actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Retry ›</button>';
        body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
      }
    }

    async function doUpdate(ver){
      statusEl.textContent='Updating to v'+ver+'...';statusEl.style.color='var(--tx3)';actionEl.innerHTML='';
      try{
        const upd=await window.api.checkClaudeUpdate({forceCheck:true});
        if(!upd.updateAvailable){
          statusEl.textContent='✓ Updated to v'+(upd.latestVersion||ver)+' — restart sessions to use';statusEl.style.color='var(--grn)';
          actionEl.innerHTML='';
          refreshBadge();
        } else {
          statusEl.textContent='Update may have failed';statusEl.style.color='var(--ylw)';
          actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Retry ›</button>';
          body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
        }
      }catch{
        statusEl.textContent='Update failed';statusEl.style.color='var(--red)';
        actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Retry ›</button>';
        body.querySelector('#ccmRetryUpdate').onclick=()=>doUpdateCheck(true);
      }
    }

    async function doPluginUpdateCheck(force){
      const plugBody=body.querySelector('#ccmPluginUpdateBody');
      if(!plugBody)return;
      plugBody.innerHTML='<span style="color:var(--tx3)">Checking plugins...</span>';
      try{
        const res=await window.api.checkPluginUpdates({forceRefresh:force});
        const updates=(res.updates||[]).filter(u=>u.updateAvailable);
        if(updates.length===0){
          plugBody.innerHTML='<span style="color:var(--grn)">✓ All plugins up to date</span>';
          return;
        }
        let html='';
        if(updates.length>1)html+='<div style="margin-bottom:6px"><button class="ccm-btn ccm-btn-primary" style="padding:3px 10px;font-size:10px" id="ccmUpdateAllPlugins">Update All ('+updates.length+')</button></div>';
        for(const u of updates){
          const cur=u.currentVersion||'unknown';
          const lat=u.latestVersion||'?';
          html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0"><span style="color:var(--ylw)">'+esc(u.name)+' v'+esc(cur)+' → v'+esc(lat)+'</span><button class="ccm-btn ccm-btn-primary" style="padding:2px 8px;font-size:9px" data-update-plugin-key="'+esc(u.key)+'">Update</button></div>';
        }
        plugBody.innerHTML=html;
        // Wire individual update buttons
        plugBody.querySelectorAll('[data-update-plugin-key]').forEach(btn=>{
          btn.onclick=async()=>{
            const key=btn.dataset.updatePluginKey;
            btn.disabled=true;btn.textContent='Updating...';
            try{
              const r=await window.api.updatePlugin({key});
              if(r.ok){btn.textContent='✓ Updated';btn.style.color='var(--grn)'}
              else{btn.textContent='Failed';btn.style.color='var(--red)';btn.title=r.error||''}
            }catch(e){btn.textContent='Error';btn.style.color='var(--red)';btn.title=e.message||''}
          };
        });
        // Wire Update All button
        const allBtn=plugBody.querySelector('#ccmUpdateAllPlugins');
        if(allBtn)allBtn.onclick=async()=>{
          allBtn.disabled=true;allBtn.textContent='Updating all...';
          try{
            const keys=updates.map(u=>u.key);
            const results=await window.api.updateAllPlugins({keys});
            const failed=results.filter(r=>!r.ok);
            if(failed.length===0){allBtn.textContent='✓ All updated';allBtn.style.color='var(--grn)'}
            else{allBtn.textContent=failed.length+' failed';allBtn.style.color='var(--red)';allBtn.title=failed.map(f=>f.key+': '+f.error).join('\n')}
            doPluginUpdateCheck(true);
          }catch(e){allBtn.textContent='Error';allBtn.style.color='var(--red)';allBtn.title=e.message||''}
        };
      }catch(e){
        plugBody.innerHTML='<span style="color:var(--red)">Check failed: '+esc(e.message||'unknown error')+'</span>';
      }
    }
  }

  function formatAuth(){
    if(!ccState.authType)return'<span style="color:var(--ylw)">Not configured</span>';
    const labels={anthropic:'Anthropic Account',console:'API Key',cloud:'Cloud Provider',custom:'Custom Provider'};
    let s=labels[ccState.authType]||ccState.authType;
    if(ccState.authDetail)s+=' · <span style="color:var(--cyn)">'+esc(ccState.authDetail)+'</span>';
    return s;
  }

  // ── Setup Wizard ──────────────────────────────
  let wizardStep=1;
  function renderWizard(){
    wizardStep=1;
    renderWizardStep();
  }

  function renderWizardStep(){
    if(wizardStep===1)renderInstallStep();
    else if(wizardStep===2)renderAuthStep();
    else if(wizardStep===3)renderReadyStep();
  }

  function renderInstallStep(){
    const isWin=ccState.platform==='win32';
    const isMac=ccState.platform==='darwin';
    const methods=isWin?['powershell','cmd','winget']:(isMac?['curl','homebrew']:['curl']);
    const labels={powershell:'PowerShell',cmd:'CMD',winget:'WinGet',curl:'Native',homebrew:'Homebrew'};
    const commands={
      powershell:'irm https://claude.ai/install.ps1 | iex',
      cmd:'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
      winget:'winget install Anthropic.ClaudeCode',
      curl:'curl -fsSL https://claude.ai/install.sh | bash',
      homebrew:'brew install --cask claude-code',
    };
    const autoUpdate={powershell:true,cmd:true,curl:true,winget:false,homebrew:false};
    const defaultMethod=methods[0];

    body.innerHTML=`
      <div class="ccm-step">
        <div class="ccm-step-num active">1</div>
        <div class="ccm-step-body">
          <div class="ccm-step-title">Install Claude Code</div>
          <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
            <span style="font-size:11px;color:var(--tx2)">Detected:</span>
            <span style="background:var(--bg2);color:var(--acc);font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--bdr)">${isWin?'Windows':(isMac?'macOS':'Linux')}</span>
          </div>
          <div class="ccm-method-tabs" id="ccmMethodTabs">
            ${methods.map((m,i)=>'<button class="ccm-method-tab'+(i===0?' active':'')+'" data-method="'+m+'">'+labels[m]+'</button>').join('')}
          </div>
          <div class="ccm-cmd" id="ccmInstallCmd"><span id="ccmCmdText">${commands[defaultMethod]}</span><button class="ccm-cmd-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">📋</button></div>
          ${isWin&&defaultMethod!=='winget'?'<div class="ccm-warn">⚠ Requires <a href="https://git-scm.com/downloads/win" style="color:var(--acc);text-decoration:underline" target="_blank">Git for Windows</a></div>':''}
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <button class="ccm-btn ccm-btn-primary" id="ccmInstallBtn">Install Now</button>
            <span style="font-size:10px;color:var(--tx2)" id="ccmAutoUpdateNote">${autoUpdate[defaultMethod]?'Auto-updates ✓':'Manual updates'}</span>
          </div>
          <div class="ccm-install-log" id="ccmInstallLog" style="display:none"></div>
        </div>
      </div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div>
      <div class="ccm-step ccm-dimmed"><div class="ccm-step-num pending">2</div><div class="ccm-step-body"><div class="ccm-step-title" style="color:var(--tx2)">Authenticate</div><div class="ccm-step-sub">Connect your Anthropic account or API key</div></div></div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div>
      <div class="ccm-step ccm-dimmed"><div class="ccm-step-num pending">3</div><div class="ccm-step-body"><div class="ccm-step-title" style="color:var(--tx2)">Ready</div><div class="ccm-step-sub">Start your first session</div></div></div>
    `;

    // Method tab switching
    const methodTabs=body.querySelector('#ccmMethodTabs');
    const cmdText=body.querySelector('#ccmCmdText');
    const autoNote=body.querySelector('#ccmAutoUpdateNote');
    methodTabs.addEventListener('click',e=>{
      const tab=e.target.closest('.ccm-method-tab');if(!tab)return;
      methodTabs.querySelectorAll('.ccm-method-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const m=tab.dataset.method;
      cmdText.textContent=commands[m];
      autoNote.textContent=autoUpdate[m]?'Auto-updates ✓':'Manual updates';
    });

    // Install button
    body.querySelector('#ccmInstallBtn').onclick=async()=>{
      const activeMethod=methodTabs.querySelector('.ccm-method-tab.active').dataset.method;
      const log=body.querySelector('#ccmInstallLog');
      const btn=body.querySelector('#ccmInstallBtn');
      log.style.display='block';log.textContent='Starting install...\n';
      btn.disabled=true;btn.textContent='Installing...';
      badge.className='cc-badge installing';badgeText.textContent='Installing Claude Code...';

      window.api.onInstallProgress(d=>{
        if(d.output)log.textContent+=d.output;
        log.scrollTop=log.scrollHeight;
      });

      const result=await window.api.installClaudeCode({method:activeMethod});
      if(result.ok){
        ccState=await window.api.detectClaudeCode();
        refreshBadge();
        if(ccState.installed){wizardStep=2;renderAuthStep()}
        else{btn.disabled=false;btn.textContent='Retry Install';log.textContent+='\nInstall completed but claude not detected. Try restarting the app.'}
      } else {
        btn.disabled=false;btn.textContent='Retry Install';
        log.textContent+='\nError: '+(result.error||'Unknown error');
      }
    };
  }

  function renderAuthStep(){
    body.innerHTML=`
      ${ccState.installed?'<div class="ccm-step"><div class="ccm-step-num done">✓</div><div class="ccm-step-body"><span style="font-size:13px;color:var(--grn);font-weight:500">Claude Code v'+esc(ccState.version||'?')+' installed</span><span style="font-size:10px;color:var(--tx3);margin-left:8px;font-family:monospace">'+esc(ccState.path||'')+'</span></div></div><div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div>':''}
      <div class="ccm-step">
        <div class="ccm-step-num active">2</div>
        <div class="ccm-step-body">
          <div class="ccm-step-title" style="margin-bottom:10px">Authenticate</div>
          <div id="ccmAuthOptions">
            <div class="ccm-auth-opt" data-auth="anthropic"><div style="display:flex;align-items:center;justify-content:space-between"><div><h4>Anthropic Account<span class="ccm-badge-rec">Recommended</span></h4><p>Claude Pro, Max, Team, or Enterprise</p></div></div></div>
            <div class="ccm-auth-opt" data-auth="console"><h4>Console API Key</h4><p>Pre-paid credits</p></div>
            <div class="ccm-auth-opt" data-auth="cloud"><h4>Cloud Provider</h4><p>Amazon Bedrock · Google Vertex AI · Microsoft Foundry</p></div>
            <div class="ccm-auth-opt" data-auth="custom"><h4>Custom Anthropic Provider</h4><p>Proxy, gateway, or self-hosted endpoint (LiteLLM, OpenRouter, etc.)</p></div>
          </div>
          <div id="ccmAuthForm"></div>
        </div>
      </div>
      ${!ccState.installed?'<div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div><div class="ccm-step ccm-dimmed"><div class="ccm-step-num pending">3</div><div class="ccm-step-body"><div class="ccm-step-title" style="color:var(--tx2)">Ready</div><div class="ccm-step-sub">Start your first session</div></div></div>':''}
    `;

    body.querySelector('#ccmAuthOptions').addEventListener('click',e=>{
      const opt=e.target.closest('.ccm-auth-opt');if(!opt)return;
      body.querySelectorAll('.ccm-auth-opt').forEach(o=>o.classList.remove('selected'));
      opt.classList.add('selected');
      const method=opt.dataset.auth;
      const form=body.querySelector('#ccmAuthForm');

      if(method==='anthropic'){
        form.innerHTML='<button class="ccm-btn ccm-btn-primary" style="margin-top:10px" id="ccmAuthGo">Login with Browser →</button><div class="ccm-install-log" id="ccmAuthLog" style="display:none"></div>';
        form.querySelector('#ccmAuthGo').onclick=async()=>{
          const log=form.querySelector('#ccmAuthLog');log.style.display='block';log.textContent='Opening browser for login...\n';
          const r=await window.api.authenticateClaudeCode({method:'anthropic'});
          if(r.ok){log.textContent+='Login successful!';ccState=await window.api.detectClaudeCode();refreshBadge();if(!ccState.installed){renderOverview()}else{wizardStep=3;renderReadyStep()}}
          else log.textContent+='Error: '+(r.error||'Failed');
        };
      } else if(method==='console'){
        form.innerHTML='<div class="ccm-cmd" style="margin-top:10px"><span>claude auth login --console</span></div><button class="ccm-btn ccm-btn-primary" id="ccmAuthGo">Run Login</button><div class="ccm-install-log" id="ccmAuthLog" style="display:none"></div>';
        form.querySelector('#ccmAuthGo').onclick=async()=>{
          const log=form.querySelector('#ccmAuthLog');log.style.display='block';log.textContent='Starting console login...\n';
          const r=await window.api.authenticateClaudeCode({method:'console'});
          if(r.ok){log.textContent+='Login successful!';ccState=await window.api.detectClaudeCode();refreshBadge();if(!ccState.installed){renderOverview()}else{wizardStep=3;renderReadyStep()}}
          else log.textContent+='Error: '+(r.error||'Failed');
        };
      } else if(method==='cloud'){
        form.innerHTML='<div style="margin-top:10px;font-size:12px;color:var(--tx2)"><p>Follow the setup guide for your provider:</p><ul style="list-style:none;padding:0;margin:8px 0"><li style="margin:6px 0"><a href="https://code.claude.com/en/amazon-bedrock" style="color:var(--acc)" target="_blank">Amazon Bedrock setup guide →</a></li><li style="margin:6px 0"><a href="https://code.claude.com/en/google-vertex-ai" style="color:var(--acc)" target="_blank">Google Vertex AI setup guide →</a></li><li style="margin:6px 0"><a href="https://code.claude.com/en/microsoft-foundry" style="color:var(--acc)" target="_blank">Microsoft Foundry setup guide →</a></li></ul><button class="ccm-btn ccm-btn-secondary" id="ccmAuthSkip">I\'ve configured it externally → Continue</button></div>';
        form.querySelector('#ccmAuthSkip').onclick=async()=>{ccState=await window.api.detectClaudeCode();refreshBadge();if(ccState.installed){wizardStep=3;renderReadyStep()}else renderOverview()};
      } else if(method==='custom'){
        form.innerHTML='<div style="margin-top:10px"><div style="margin-bottom:8px"><div style="font-size:10px;color:var(--tx2);text-transform:uppercase;margin-bottom:3px">Base URL (ANTHROPIC_BASE_URL)</div><input type="text" class="ccm-editor-area" style="min-height:auto;height:32px;padding:6px 10px" id="ccmBaseUrl" placeholder="https://api.example.com" value=""></div><div style="margin-bottom:8px"><div style="font-size:10px;color:var(--tx2);text-transform:uppercase;margin-bottom:3px">Auth Token (ANTHROPIC_AUTH_TOKEN)</div><div style="display:flex;gap:6px"><input type="password" class="ccm-editor-area" style="min-height:auto;height:32px;padding:6px 10px;flex:1" id="ccmAuthToken" placeholder="sk-..."><button class="ccm-btn ccm-btn-secondary" style="padding:4px 8px;font-size:10px" id="ccmTogglePw">👁</button></div></div><div style="display:flex;gap:8px;margin-top:10px"><button class="ccm-btn ccm-btn-secondary" id="ccmTestConn">Test Connection</button><button class="ccm-btn ccm-btn-primary" id="ccmApplyCustom">Apply & Continue</button></div><div id="ccmCustomStatus" style="font-size:11px;margin-top:6px"></div><div style="font-size:9px;color:var(--tx3);margin-top:4px">Stores ANTHROPIC_BASE_URL in settings.json. Token is saved to secure storage when available; otherwise it falls back to settings.json.</div></div>';

        const tokenInput=form.querySelector('#ccmAuthToken');
        const setTokenPlaceholder=(state)=>{
          if(state?.hasSecureToken){tokenInput.placeholder='(saved securely — enter new to replace)';return}
          if(state?.hasEnvToken){tokenInput.placeholder='(saved in settings.json — enter new to replace)';return}
          tokenInput.placeholder='sk-...';
        };

        // Pre-fill from secure-aware state
        (async()=>{
          try{
            const state=await window.api.getCustomProviderState();
            if(state?.ok){
              if(state.baseUrl)form.querySelector('#ccmBaseUrl').value=state.baseUrl;
              setTokenPlaceholder(state);
              return;
            }
          }catch{}
          try{const s=await window.api.readClaudeSettings({scope:'global'});const j=JSON.parse(s.content);if(j.env&&j.env.ANTHROPIC_BASE_URL)form.querySelector('#ccmBaseUrl').value=j.env.ANTHROPIC_BASE_URL}catch{}
        })();

        form.querySelector('#ccmTogglePw').onclick=()=>{const inp=form.querySelector('#ccmAuthToken');inp.type=inp.type==='password'?'text':'password'};
        form.querySelector('#ccmTestConn').onclick=async()=>{
          const status=form.querySelector('#ccmCustomStatus');
          status.style.color='var(--ylw)';status.textContent='Testing...';
          const baseUrl=form.querySelector('#ccmBaseUrl').value;
          const token=tokenInput.value.trim();
          const r=await window.api.testCustomProvider({baseUrl,authToken:token||undefined});
          if(r.ok){status.style.color='var(--grn)';status.textContent='✓ Connection successful!'}
          else{status.style.color='var(--red)';status.textContent='✗ '+(r.error||'Failed')}
        };
        form.querySelector('#ccmApplyCustom').onclick=async()=>{
          const status=form.querySelector('#ccmCustomStatus');
          const baseUrl=form.querySelector('#ccmBaseUrl').value;
          const token=tokenInput.value.trim();
          const payload={baseUrl};
          if(token)payload.authToken=token;
          const r=await window.api.saveCustomProvider(payload);
          if(r.ok){
            tokenInput.value='';
            const state=await window.api.getCustomProviderState();
            setTokenPlaceholder(state);
            status.style.color='var(--grn)';
            status.textContent=r.warning?('✓ Saved. '+r.warning):'✓ Saved!';
            ccState=await window.api.detectClaudeCode();refreshBadge();setTimeout(()=>{if(ccState.installed){wizardStep=3;renderReadyStep()}else renderOverview()},800)
          }
          else{status.style.color='var(--red)';status.textContent='✗ '+(r.error||'Failed')}
        };
      }
    });
  }

  function renderReadyStep(){
    body.innerHTML=`
      <div class="ccm-step"><div class="ccm-step-num done">✓</div><div class="ccm-step-body"><span style="color:var(--grn);font-weight:500">Claude Code installed</span></div></div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 12px 38px"></div>
      <div class="ccm-step"><div class="ccm-step-num done">✓</div><div class="ccm-step-body"><span style="color:var(--grn);font-weight:500">Authenticated</span></div></div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 12px 38px"></div>
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:32px;margin-bottom:8px">🎉</div>
        <div style="font-size:16px;color:var(--grn);font-weight:600">Claude Code is Ready!</div>
        <div style="font-size:11px;color:var(--tx2);margin-top:4px">All checks passed. You can start sessions now.</div>
        <button class="ccm-btn ccm-btn-primary" style="margin-top:16px" onclick="document.querySelector('#ccmClose').click()">Close</button>
      </div>
    `;
    // Enable all tabs now
    ccState.installed=true;
    updateTabs();refreshBadge();
  }

  // ── Settings Editor Tab ───────────────────────
  let editorMode='structured', selectedTag='__current__';
  let workingSettings=null; // parsed JSON object being edited

  async function renderSettingsEditor(){
    // Load tags and models
    const tagData=await window.api.listSettingsTags();
    const tagList=tagData.tags||[];
    let availableModels=[];
    try{const res=await window.api.fetchModels();if(res&&res.models)availableModels=res.models.map(m=>m.id||m.name||m)}catch{}
    if(!availableModels.length)availableModels=['claude-opus-4-6','claude-sonnet-4-20250514','claude-haiku-4-20250414'];

    if(window._ccmAbort)window._ccmAbort.abort();window._ccmAbort=new AbortController();
    body.innerHTML=`
      <div class="ccm-settings-layout">
        <div class="ccm-sidebar">
          <div class="ccm-sidebar-header">Configs</div>
          <div id="ccmTagList"></div>
          <button class="ccm-tag-new" id="ccmNewTag">+ New Tag</button>
        </div>
        <div class="ccm-editor-main">
          <div class="ccm-editor-toolbar">
            <div class="ccm-mode-toggle" id="ccmModeToggle">
              <button class="ccm-mode-btn active" data-mode="structured">Structured</button>
              <button class="ccm-mode-btn" data-mode="raw">Raw JSON</button>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="ccm-json-status" id="ccmJsonStatus" style="display:none"></span>
              <button class="ccm-btn ccm-btn-secondary" style="padding:4px 10px;font-size:10px" id="ccmSaveAs">Save As...</button>
              <button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmSave">Save</button>
            </div>
          </div>
          <div class="ccm-editor-scroll" id="ccmEditorScroll"></div>
          <div class="ccm-saveas-dialog" id="ccmSaveAsDialog">
            <div style="display:flex;gap:6px;align-items:center">
              <input class="ccm-field-input" style="flex:1" id="ccmSaveAsName" placeholder="tag-name (alphanumeric, hyphens, underscores)">
              <button class="ccm-btn ccm-btn-primary" style="padding:4px 10px;font-size:10px" id="ccmSaveAsConfirm">Save</button>
              <button class="ccm-btn ccm-btn-secondary" style="padding:4px 8px;font-size:10px" id="ccmSaveAsCancel">Cancel</button>
            </div>
            <div id="ccmSaveAsError" style="font-size:10px;color:var(--red);margin-top:4px"></div>
          </div>
        </div>
      </div>
    `;

    const tagListEl=body.querySelector('#ccmTagList');
    const editorScroll=body.querySelector('#ccmEditorScroll');
    const statusEl=body.querySelector('#ccmJsonStatus');

    // Render tag sidebar
    function renderTags(){
      let html='<div class="ccm-tag'+(selectedTag==='__current__'?' active':'')+'" data-tag="__current__"><span>● Current</span></div>';
      for(const t of tagList){
        const act=selectedTag===t.name?' active':'';
        html+='<div class="ccm-tag'+act+'" data-tag="'+esc(t.name)+'"><span>'+esc(t.name)+'</span><button class="ccm-tag-del" data-del="'+esc(t.name)+'" title="Delete">✕</button></div>';
      }
      tagListEl.innerHTML=html;
      // Click handlers
      tagListEl.querySelectorAll('.ccm-tag').forEach(el=>{
        el.onclick=async(e)=>{
          if(e.target.closest('.ccm-tag-del'))return;
          selectedTag=el.dataset.tag;
          await loadTag(selectedTag);
          renderTags();
          renderEditor();
        };
      });
      tagListEl.querySelectorAll('.ccm-tag-del').forEach(btn=>{
        btn.onclick=async(e)=>{
          e.stopPropagation();
          const name=btn.dataset.del;
          if(!confirm('Delete tag "'+name+'"?'))return;
          await window.api.deleteSettingsTag({name});
          const idx=tagList.findIndex(t=>t.name===name);
          if(idx>=0)tagList.splice(idx,1);
          if(selectedTag===name){selectedTag='__current__';await loadTag('__current__')}
          renderTags();renderEditor();
        };
      });
    }

    // Load a tag's content
    async function loadTag(tag){
      if(tag==='__current__'){
        const r=await window.api.readClaudeSettings({scope:'global'});
        try{workingSettings=JSON.parse(r.content)}catch{workingSettings={}}
      } else {
        const r=await window.api.loadSettingsTag({name:tag});
        try{workingSettings=r.error?{}:JSON.parse(r.content)}catch{workingSettings={}}
      }
    }

    // Mode toggle
    body.querySelector('#ccmModeToggle').addEventListener('click',e=>{
      const btn=e.target.closest('.ccm-mode-btn');if(!btn)return;
      // Before switching, sync working state
      if(editorMode==='raw') syncFromRaw();
      else if(editorMode==='structured') syncFromStructured();
      editorMode=btn.dataset.mode;
      body.querySelectorAll('.ccm-mode-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      statusEl.style.display=editorMode==='raw'?'inline':'none';
      renderEditor();
    });

    // Render editor content based on mode
    function renderEditor(){
      if(editorMode==='structured') renderStructured();
      else renderRaw();
    }

    // ── Structured Mode ──
    function renderStructured(){
      const s=workingSettings||{};
      const env=s.env||{};
      const hooks=s.hooks||{};
      const envKeys=Object.keys(env);
      const hookTypes=Object.keys(hooks);
      const knownKeys=['env','model','hooks','statusLine','effortLevel','enabledPlugins','extraKnownMarketplaces','skipDangerousModePermissionPrompt'];
      const otherKeys=Object.keys(s).filter(k=>!knownKeys.includes(k));

      let html='';

      // Section 1: Environment
      html+='<div class="ccm-section open" data-section="env"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▼ Environment</span><span class="ccm-section-count">'+envKeys.length+' vars</span></div><div class="ccm-section-body" id="ccmEnvBody">';
      for(const k of envKeys){
        const isToken=/token|key|secret/i.test(k);
        html+='<div class="ccm-field"><div class="ccm-field-row"><div style="flex:1"><div class="ccm-field-label">'+esc(k)+'</div><input class="ccm-field-input" type="'+(isToken?'password':'text')+'" data-env="'+esc(k)+'" value="'+esc(env[k]||'')+'"></div>'+(isToken?'<button class="ccm-btn ccm-btn-secondary" style="padding:3px 6px;font-size:9px" onclick="const i=this.previousElementSibling.querySelector(\'input\');i.type=i.type===\'password\'?\'text\':\'password\'">👁</button>':'')+'<button class="ccm-del-btn" data-env-del="'+esc(k)+'">✕</button></div></div>';
      }
      html+='<div id="ccmAddEnvRow" style="display:none;margin-top:6px"><div style="display:flex;gap:6px;align-items:center"><input class="ccm-field-input" style="flex:1" id="ccmAddEnvName" placeholder="VARIABLE_NAME"><button class="ccm-btn ccm-btn-primary" style="padding:4px 10px;font-size:10px" id="ccmAddEnvConfirm">Add</button><button class="ccm-btn ccm-btn-secondary" style="padding:4px 8px;font-size:10px" id="ccmAddEnvCancel">Cancel</button></div></div>';
      html+='<button class="ccm-add-btn" id="ccmAddEnv">+ Add Variable</button></div></div>';

      // Section 2: Model & Effort
      const models=availableModels.slice();
      const curModel=s.model||'';
      if(curModel&&!models.includes(curModel))models.unshift(curModel);
      const efforts=['low','medium','high'];
      html+='<div class="ccm-section open" data-section="model"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▼ Model & Effort</span></div><div class="ccm-section-body"><div style="display:flex;gap:12px"><div class="ccm-field" style="flex:1"><div class="ccm-field-label">Model</div><select class="ccm-field-select" style="width:100%" id="ccmModel">'+models.map(m=>'<option value="'+m+'"'+(m===curModel?' selected':'')+'>'+m+'</option>').join('')+'</select></div><div class="ccm-field" style="width:100px"><div class="ccm-field-label">Effort</div><select class="ccm-field-select" style="width:100%" id="ccmEffort">'+efforts.map(e=>'<option value="'+e+'"'+(e===(s.effortLevel||'high')?' selected':'')+'>'+e+'</option>').join('')+'</select></div></div></div></div>';

      // Section 3: Hooks
      html+='<div class="ccm-section" data-section="hooks"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Hooks</span><span class="ccm-section-count">'+hookTypes.reduce((n,t)=>{const arr=hooks[t];return n+(Array.isArray(arr)?arr.length:0)},0)+' hooks</span></div><div class="ccm-section-body" id="ccmHooksBody">';
      for(const htype of hookTypes){
        const entries=hooks[htype]||[];
        html+='<div class="ccm-hook-group"><div class="ccm-hook-group-header" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'"><span>▶ '+esc(htype)+' ('+entries.length+')</span></div><div style="display:none">';
        for(let hi=0;hi<entries.length;hi++){
          const entry=entries[hi];
          const hks=entry.hooks||[];
          html+='<div class="ccm-hook-card"><div class="ccm-field"><div class="ccm-field-label">Matcher</div><input class="ccm-field-input" data-hook-matcher="'+esc(htype)+'.'+hi+'" value="'+esc(entry.matcher||'')+'"></div>';
          for(let hhi=0;hhi<hks.length;hhi++){
            const h=hks[hhi];
            html+='<div class="ccm-field"><div class="ccm-field-row"><div style="flex:1"><div class="ccm-field-label">Command</div><input class="ccm-field-input" data-hook-cmd="'+esc(htype)+'.'+hi+'.'+hhi+'" value="'+esc(h.command||'')+'"></div><div style="width:50px"><div class="ccm-field-label">Timeout</div><input class="ccm-field-input" type="number" data-hook-timeout="'+esc(htype)+'.'+hi+'.'+hhi+'" value="'+(h.timeout||'')+'"></div><button class="ccm-del-btn" data-hook-del="'+esc(htype)+'.'+hi+'.'+hhi+'">✕</button></div></div>';
          }
          html+='</div>';
        }
        html+='<div style="padding:6px 10px"><button class="ccm-add-btn" data-add-hook="'+esc(htype)+'">+ Add Hook to '+esc(htype)+'</button></div></div></div>';
      }
      html+='<div id="ccmAddHookTypeRow" style="display:none;margin-top:6px"><div style="display:flex;gap:6px;align-items:center"><input class="ccm-field-input" style="flex:1" id="ccmAddHookTypeName" placeholder="e.g., PreToolUse, PostToolUse, SessionStart"><button class="ccm-btn ccm-btn-primary" style="padding:4px 10px;font-size:10px" id="ccmAddHookTypeConfirm">Add</button><button class="ccm-btn ccm-btn-secondary" style="padding:4px 8px;font-size:10px" id="ccmAddHookTypeCancel">Cancel</button></div></div>';
      html+='<button class="ccm-add-btn" id="ccmAddHookType" style="margin-top:4px">+ Add Event Type</button></div></div>';

      // Section 4: Status Line
      const sl=s.statusLine||{};
      html+='<div class="ccm-section" data-section="status"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Status Line</span></div><div class="ccm-section-body"><div class="ccm-field"><div class="ccm-field-label">Type</div><input class="ccm-field-input" id="ccmStatusType" value="'+esc(sl.type||'command')+'"></div><div class="ccm-field"><div class="ccm-field-label">Command</div><input class="ccm-field-input" id="ccmStatusCmd" value="'+esc(sl.command||'')+'"></div></div></div>';

      // Section 5: Plugins (read-only, managed via Plugins tab)
      const ep=s.enabledPlugins||{};
      const epKeys=Object.keys(ep);
      html+='<div class="ccm-section" data-section="plugins"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Plugins</span><span class="ccm-section-count">'+epKeys.length+' plugins</span></div><div class="ccm-section-body">';
      if(epKeys.length){
        for(const pk of epKeys){
          const parts=pk.split('@');
          const pName=parts[0]||pk;
          const pSource=parts[1]||'';
          html+='<div class="ccm-field"><div class="ccm-field-row"><span style="font-size:11px;color:var(--tx)">'+esc(pName)+'</span>';
          if(pSource)html+='<span style="font-size:9px;color:var(--tx3);margin-left:6px">'+esc(pSource)+'</span>';
          html+='<span style="font-size:9px;color:'+(ep[pk]?'var(--grn)':'var(--red)')+'">'+( ep[pk]?'enabled':'disabled')+'</span></div></div>';
        }
      } else {
        html+='<div style="font-size:11px;color:var(--tx3)">No plugins configured</div>';
      }
      html+='<div style="font-size:9px;color:var(--tx3);margin-top:6px">Manage plugins in the Plugins tab. Edit in Raw JSON mode for advanced changes.</div></div></div>';

      // Section 6: Flags & Other
      html+='<div class="ccm-section" data-section="flags"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Flags & Other</span><span class="ccm-section-count">'+(1+otherKeys.length)+' items</span></div><div class="ccm-section-body">';
      html+='<div class="ccm-field"><div class="ccm-field-row"><span style="font-size:11px;color:var(--tx)">Skip Dangerous Mode Prompt</span><button class="ccm-field-toggle '+(s.skipDangerousModePermissionPrompt?'on':'off')+'" id="ccmSkipDanger"></button></div></div>';
      for(const k of otherKeys){
        html+='<div class="ccm-field"><div class="ccm-field-label">'+esc(k)+'</div><div style="font-size:11px;color:var(--tx2);font-family:monospace">'+esc(JSON.stringify(s[k]))+'</div></div>';
      }
      html+='<div style="font-size:9px;color:var(--tx3);margin-top:6px">Unknown keys are read-only. Use Raw JSON mode to edit.</div></div></div>';

      editorScroll.innerHTML=html;

      // Wire up accordion arrow indicators
      editorScroll.querySelectorAll('.ccm-section-header').forEach(h=>{
        h.addEventListener('click',()=>{
          const title=h.querySelector('.ccm-section-title');
          const open=h.parentElement.classList.contains('open');
          title.textContent=(open?'▼':'▶')+title.textContent.substring(1);
        });
      });

      // Wire env delete buttons
      editorScroll.querySelectorAll('[data-env-del]').forEach(btn=>{
        btn.onclick=()=>{syncFromStructured();const k=btn.dataset.envDel;delete workingSettings.env[k];renderStructured()};
      });

      // Add env variable
      const addEnvBtn=editorScroll.querySelector('#ccmAddEnv');
      const addEnvRow=editorScroll.querySelector('#ccmAddEnvRow');
      if(addEnvBtn&&addEnvRow){
        addEnvBtn.onclick=()=>{addEnvRow.style.display='block';addEnvBtn.style.display='none';editorScroll.querySelector('#ccmAddEnvName').focus()};
        editorScroll.querySelector('#ccmAddEnvCancel').onclick=()=>{addEnvRow.style.display='none';addEnvBtn.style.display=''};
        editorScroll.querySelector('#ccmAddEnvConfirm').onclick=()=>{
          const name=editorScroll.querySelector('#ccmAddEnvName').value.trim();
          if(!name)return;
          syncFromStructured();
          if(!workingSettings.env)workingSettings.env={};
          workingSettings.env[name]='';
          renderStructured();
        };
        editorScroll.querySelector('#ccmAddEnvName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();editorScroll.querySelector('#ccmAddEnvConfirm').click()}if(e.key==='Escape'){editorScroll.querySelector('#ccmAddEnvCancel').click()}});
      }

      // Toggle skip dangerous
      const skipBtn=editorScroll.querySelector('#ccmSkipDanger');
      if(skipBtn)skipBtn.onclick=()=>{
        skipBtn.classList.toggle('on');skipBtn.classList.toggle('off');
        workingSettings.skipDangerousModePermissionPrompt=skipBtn.classList.contains('on');
      };

      // Add hook to type
      editorScroll.querySelectorAll('[data-add-hook]').forEach(btn=>{
        btn.onclick=()=>{
          const htype=btn.dataset.addHook;
          if(!workingSettings.hooks)workingSettings.hooks={};
          if(!workingSettings.hooks[htype])workingSettings.hooks[htype]=[];
          workingSettings.hooks[htype].push({matcher:'',hooks:[{type:'command',command:'',timeout:5}]});
          renderStructured();
        };
      });

      // Add new event type
      const addTypeBtn=editorScroll.querySelector('#ccmAddHookType');
      const addTypeRow=editorScroll.querySelector('#ccmAddHookTypeRow');
      if(addTypeBtn&&addTypeRow){
        addTypeBtn.onclick=()=>{addTypeRow.style.display='block';addTypeBtn.style.display='none';editorScroll.querySelector('#ccmAddHookTypeName').focus()};
        editorScroll.querySelector('#ccmAddHookTypeCancel').onclick=()=>{addTypeRow.style.display='none';addTypeBtn.style.display=''};
        editorScroll.querySelector('#ccmAddHookTypeConfirm').onclick=()=>{
          const name=editorScroll.querySelector('#ccmAddHookTypeName').value.trim();
          if(!name)return;
          syncFromStructured();
          if(!workingSettings.hooks)workingSettings.hooks={};
          if(!workingSettings.hooks[name])workingSettings.hooks[name]=[];
          renderStructured();
        };
        editorScroll.querySelector('#ccmAddHookTypeName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();editorScroll.querySelector('#ccmAddHookTypeConfirm').click()}if(e.key==='Escape'){editorScroll.querySelector('#ccmAddHookTypeCancel').click()}});
      }

      // Delete hook
      editorScroll.querySelectorAll('[data-hook-del]').forEach(btn=>{
        btn.onclick=()=>{
          syncFromStructured();
          const parts=btn.dataset.hookDel.split('.');
          const arr=workingSettings.hooks[parts[0]];
          if(arr&&arr[+parts[1]]){
            arr[+parts[1]].hooks.splice(+parts[2],1);
            if(!arr[+parts[1]].hooks.length)arr.splice(+parts[1],1);
          }
          renderStructured();
        };
      });
    }

    // Sync structured fields to workingSettings
    function syncFromStructured(){
      if(!workingSettings)workingSettings={};
      // Env
      const envInputs=editorScroll.querySelectorAll('[data-env]');
      if(envInputs.length){
        workingSettings.env={};
        envInputs.forEach(inp=>{workingSettings.env[inp.dataset.env]=inp.value});
      }
      // Model
      const modelEl=editorScroll.querySelector('#ccmModel');
      if(modelEl)workingSettings.model=modelEl.value;
      // Effort
      const effortEl=editorScroll.querySelector('#ccmEffort');
      if(effortEl)workingSettings.effortLevel=effortEl.value;
      // Hooks - matchers and commands
      editorScroll.querySelectorAll('[data-hook-matcher]').forEach(inp=>{
        const parts=inp.dataset.hookMatcher.split('.');
        if(workingSettings.hooks&&workingSettings.hooks[parts[0]]&&workingSettings.hooks[parts[0]][+parts[1]]){
          workingSettings.hooks[parts[0]][+parts[1]].matcher=inp.value;
        }
      });
      editorScroll.querySelectorAll('[data-hook-cmd]').forEach(inp=>{
        const parts=inp.dataset.hookCmd.split('.');
        if(workingSettings.hooks&&workingSettings.hooks[parts[0]]&&workingSettings.hooks[parts[0]][+parts[1]]&&workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]]){
          workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]].command=inp.value;
        }
      });
      editorScroll.querySelectorAll('[data-hook-timeout]').forEach(inp=>{
        const parts=inp.dataset.hookTimeout.split('.');
        if(workingSettings.hooks&&workingSettings.hooks[parts[0]]&&workingSettings.hooks[parts[0]][+parts[1]]&&workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]]){
          const v=parseInt(inp.value,10);
          if(!isNaN(v))workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]].timeout=v;
        }
      });
      // Status line
      const stType=editorScroll.querySelector('#ccmStatusType');
      const stCmd=editorScroll.querySelector('#ccmStatusCmd');
      if(stType&&stCmd){
        workingSettings.statusLine={type:stType.value,command:stCmd.value};
      }
    }

    // ── Raw JSON Mode ──
    function renderRaw(){
      const json = JSON.stringify(workingSettings || {}, null, 2);

      editorScroll.innerHTML = '<div class="ccm-editor-wrap">' +
        '<div class="ccm-line-gutter" id="ccmLineGutter"></div>' +
        '<div class="ccm-editor-container">' +
        '<pre class="ccm-highlight-overlay" id="ccmHighlightOverlay"></pre>' +
        '<textarea class="ccm-editor-area-v2" id="ccmRawEditor" spellcheck="false">' + esc(json) + '</textarea>' +
        '</div></div>';

      const editor = editorScroll.querySelector('#ccmRawEditor');
      const overlay = editorScroll.querySelector('#ccmHighlightOverlay');
      const gutter = editorScroll.querySelector('#ccmLineGutter');
      statusEl.style.display = 'inline';

      function updateGutter(text) {
        const lineCount = text.split('\n').length;
        let html = '';
        for (let i = 1; i <= lineCount; i++) html += i + '\n';
        gutter.textContent = html;
      }

      function updateHighlight(text, errorLine) {
        overlay.innerHTML = highlightJson(text, errorLine);
      }

      function syncScroll() {
        overlay.scrollTop = editor.scrollTop;
        overlay.scrollLeft = editor.scrollLeft;
        gutter.scrollTop = editor.scrollTop;
      }

      function validateAndRender() {
        const text = editor.value;
        updateGutter(text);
        let errorLine;
        try {
          JSON.parse(text);
          statusEl.textContent = '\u25cf Valid JSON';
          statusEl.className = 'ccm-json-status valid';
          body.querySelector('#ccmSave').disabled = false;
          errorLine = undefined;
        } catch (e) {
          const pos = parseJsonErrorPosition(e.message);
          let line, col;
          if (pos && pos.line !== undefined) {
            line = pos.line; col = pos.col;
          } else if (pos && pos.position !== undefined) {
            const lc = positionToLineCol(text, pos.position);
            line = lc.line; col = lc.col;
          }
          if (line !== undefined) {
            statusEl.textContent = '\u25cf Line ' + (line + 1) + ':' + ((col || 0) + 1) + ' \u2014 ' + e.message.replace(/^JSON\.parse:\s*/i, '').slice(0, 60);
          } else {
            statusEl.textContent = '\u25cf Invalid JSON';
          }
          statusEl.className = 'ccm-json-status invalid';
          body.querySelector('#ccmSave').disabled = true;
          errorLine = line;
        }
        updateHighlight(text, errorLine);
      }

      editor.addEventListener('input', function() { validateAndRender(); syncScroll(); });
      editor.addEventListener('scroll', syncScroll);

      editor.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); body.querySelector('#ccmSave').click(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          var s = editor.selectionStart, end = editor.selectionEnd;
          editor.value = editor.value.substring(0, s) + '  ' + editor.value.substring(end);
          editor.selectionStart = editor.selectionEnd = s + 2;
          validateAndRender();
        }
      });

      validateAndRender();
    }

    function syncFromRaw(){
      const editor=editorScroll.querySelector('#ccmRawEditor');
      if(editor){try{workingSettings=JSON.parse(editor.value)}catch{/* keep old */}}
    }

    // ── Save ──
    body.querySelector('#ccmSave').onclick=async()=>{
      if(editorMode==='structured')syncFromStructured();
      else syncFromRaw();
      const content=JSON.stringify(workingSettings,null,2);
      let r;
      if(selectedTag==='__current__'){
        r=await window.api.writeClaudeSettings({scope:'global',content});
      } else {
        r=await window.api.saveSettingsTag({name:selectedTag,content});
      }
      if(r.ok){statusEl.style.display='inline';statusEl.textContent='● Saved ✓';statusEl.className='ccm-json-status valid';setTimeout(()=>{if(editorMode==='structured')statusEl.style.display='none'},1500)}
      else{statusEl.style.display='inline';statusEl.textContent='● Error: '+(r.error||'');statusEl.className='ccm-json-status invalid'}
    };

    // ── Save As ──
    const saveAsDialog=body.querySelector('#ccmSaveAsDialog');
    body.querySelector('#ccmSaveAs').onclick=()=>{saveAsDialog.classList.toggle('show')};
    body.querySelector('#ccmSaveAsCancel').onclick=()=>{saveAsDialog.classList.remove('show')};
    body.querySelector('#ccmSaveAsConfirm').onclick=async()=>{
      const name=body.querySelector('#ccmSaveAsName').value.trim();
      const errEl=body.querySelector('#ccmSaveAsError');
      if(!name||!/^[a-zA-Z0-9_-]+$/.test(name)||name.length>50){errEl.textContent='Invalid name: alphanumeric, hyphens, underscores, max 50 chars';return}
      if(editorMode==='structured')syncFromStructured();
      else syncFromRaw();
      const content=JSON.stringify(workingSettings,null,2);
      const r=await window.api.saveSettingsTag({name,content});
      if(r.ok){
        saveAsDialog.classList.remove('show');
        if(!tagList.find(t=>t.name===name))tagList.push({name,path:r.path});
        tagList.sort((a,b)=>a.name.localeCompare(b.name));
        selectedTag=name;
        renderTags();
        statusEl.style.display='inline';statusEl.textContent='● Saved as "'+name+'" ✓';statusEl.className='ccm-json-status valid';
        setTimeout(()=>{if(editorMode==='structured')statusEl.style.display='none'},1500);
      } else {errEl.textContent=r.error||'Failed to save'}
    };

    // ── New Tag (sidebar) ──
    body.querySelector('#ccmNewTag').onclick=()=>{saveAsDialog.classList.add('show');body.querySelector('#ccmSaveAsName').focus()};

    // Keyboard shortcut
    body.addEventListener('keydown',e=>{
      if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();body.querySelector('#ccmSave').click()}
    },{signal:window._ccmAbort.signal});

    // Initial load
    await loadTag(selectedTag);
    renderTags();
    renderEditor();
  }

  // ── Plugins Tab ───────────────────────────────
  let pluginView='installed';
  async function renderPlugins(){
    const data=await window.api.listClaudePlugins();
    const installed=data.installed||[];
    const healthData=await window.api.runHealthCheck().catch(()=>null);
    const rawTools=(healthData?.tools?.recommended||[]).filter(t=>t.installed);
    // Deduplicate: remove tools already represented in plugins/MCP list
    const installedTools=rawTools.filter(t=>{
      const tk=(t.key||'').toLowerCase();
      return !installed.some(p=>(p.name||'').toLowerCase()===tk||(p.key||'').toLowerCase().startsWith(tk+'@')||(p.key||'').toLowerCase()==='mcp:'+tk);
    });
    const colors=['#238636','#8957e5','#d29922','#58a6ff','#f85149','#3fb950','#a5a3ff','#ff7b72'];
    const icons=['⚡','🎨','🔧','💎','🦀','📡','🐳','🔌'];

    body.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="ccm-plugin-tabs">
          <button class="ccm-plugin-tab${pluginView==='installed'?' active':''}" data-view="installed">Installed (${installed.length+installedTools.length})</button>
          <button class="ccm-plugin-tab${pluginView==='browse'?' active':''}" data-view="browse">Browse</button>
        </div>
        <input class="ccm-plugin-search" placeholder="Search plugins..." id="ccmPluginSearch">
      </div>
      <div id="ccmPluginList"></div>
    `;

    const list=body.querySelector('#ccmPluginList');
    const search=body.querySelector('#ccmPluginSearch');

    body.querySelector('.ccm-plugin-tabs').addEventListener('click',e=>{
      const tab=e.target.closest('.ccm-plugin-tab');if(!tab)return;
      pluginView=tab.dataset.view;
      body.querySelectorAll('.ccm-plugin-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      renderList();
    });

    search.addEventListener('input',()=>renderList());

    let _pluginUpdates=null;
    async function renderList(){
      const q=(search.value||'').toLowerCase();
      if(pluginView==='installed'){
        // Fetch update info (cached, non-blocking)
        if(!_pluginUpdates){
          window.api.checkPluginUpdates().then(res=>{_pluginUpdates=res.updates||[];renderList()}).catch(()=>{_pluginUpdates=[]});
        }
        const updMap={};
        if(_pluginUpdates)_pluginUpdates.forEach(u=>{if(u.updateAvailable)updMap[u.key]=u});

        const filteredPlugins=installed.filter(p=>!q||p.name.toLowerCase().includes(q)||(p.description||'').toLowerCase().includes(q));
        const filteredTools=installedTools.filter(t=>!q||t.name.toLowerCase().includes(q)||(t.description||'').toLowerCase().includes(q)||t.type.toLowerCase().includes(q));
        if(!filteredPlugins.length&&!filteredTools.length){list.innerHTML='<div style="text-align:center;color:var(--tx2);padding:20px;font-size:12px">No plugins or tools found</div>';return}

        let installedHtml='';
        if(filteredPlugins.length){
          installedHtml+=filteredPlugins.map((p,i)=>{
            const upd=updMap[p.key];
            const verHtml=upd
              ?'<span style="font-size:9px;color:var(--ylw);margin-left:4px">v'+esc(upd.currentVersion||'?')+' → v'+esc(upd.latestVersion)+'</span>'
              :(p.version?'<span style="font-size:9px;color:var(--grn);margin-left:4px">v'+esc(p.version)+'</span>':'');
            const updBtn=upd?'<button class="ccm-btn ccm-btn-primary" style="padding:2px 8px;font-size:9px;margin-right:6px" data-update-key="'+esc(p.key)+'">Update</button>':'';
            return `
            <div class="ccm-plugin-row">
              <div class="ccm-plugin-icon" style="background:${colors[i%colors.length]}">${icons[i%icons.length]}</div>
              <div class="ccm-plugin-info">
                <div><span class="ccm-plugin-name">${esc(p.name)}</span><span class="ccm-plugin-source${p.community?' community':''}">${esc(p.source)}</span>${verHtml}</div>
                <div class="ccm-plugin-desc">${esc(p.description||'No description')}</div>
              </div>
              ${updBtn}
              <button class="ccm-toggle ${p.enabled?'on':'off'}" data-plugin="${esc(p.key)}" title="${p.enabled?'Disable':'Enable'}"></button>
            </div>`;
          }).join('');
        }

        if(filteredTools.length){
          const toolRows=filteredTools.map((t,i)=>`
            <div class="ccm-plugin-row">
              <div class="ccm-plugin-icon" style="background:${colors[(i+filteredPlugins.length)%colors.length]}">${t.type==='mcp'?'🔌':'⚡'}</div>
              <div class="ccm-plugin-info">
                <div><span class="ccm-plugin-name">${esc(t.name)}</span><span class="ccm-plugin-source">${esc(t.type)}</span></div>
                <div class="ccm-plugin-desc">${esc(t.description||'Installed tool')}</div>
              </div>
              <span style="font-size:10px;color:var(--grn);font-weight:600" title="Managed externally">✓ Active</span>
            </div>
          `).join('');
          if(installedHtml)installedHtml+='<hr style="border:0;border-top:1px solid var(--bdr);margin:12px 0">';
          installedHtml+=toolRows;
        }

        list.innerHTML=installedHtml;
        list.querySelectorAll('.ccm-toggle').forEach(btn=>{
          btn.onclick=async()=>{
            const key=btn.dataset.plugin;
            const nowOn=btn.classList.contains('on');
            btn.classList.toggle('on');btn.classList.toggle('off');
            await window.api.toggleClaudePlugin({pluginKey:key,enabled:!nowOn});
          };
        });
        // Wire plugin update buttons
        list.querySelectorAll('[data-update-key]').forEach(btn=>{
          btn.onclick=async()=>{
            const key=btn.dataset.updateKey;
            btn.disabled=true;btn.textContent='Updating...';
            try{
              const r=await window.api.updatePlugin({key});
              if(r.ok){btn.textContent='✓ Updated';btn.style.color='var(--grn)';btn.style.background='transparent';_pluginUpdates=null}
              else{btn.textContent='Failed';btn.style.color='var(--red)';btn.title=r.error||''}
            }catch(e){btn.textContent='Error';btn.style.color='var(--red)';btn.title=e.message||''}
          };
        });
      } else {
        // Browse view — show recommended plugins/tools not yet installed + custom repo
        let browseHtml='';
        // Fetch health status to get recommended plugins & tools
        const healthData=await window.api.runHealthCheck().catch(()=>null);
        const recPlugins=healthData?.plugins?.missing||[];
        const recTools=healthData?.tools?.missing||[];
        if(recPlugins.length||recTools.length){
          browseHtml+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><div style="font-size:11px;color:var(--tx2);font-weight:500">RECOMMENDED</div><button class="ccm-btn ccm-btn-primary" style="padding:3px 10px;font-size:10px" id="ccmInstallAllRec">Install All</button></div>';
          for(const p of recPlugins){
            const name=p.key.split('@')[0];
            browseHtml+=`<div class="ccm-plugin-row"><div class="ccm-plugin-icon" style="background:#8957e5">📦</div><div class="ccm-plugin-info"><div><span class="ccm-plugin-name">${esc(name)}</span><span class="ccm-plugin-source">${esc(p.key.split('@')[1]||'')}</span></div><div class="ccm-plugin-desc">Recommended plugin</div></div><button class="ccm-btn ccm-btn-primary" style="padding:3px 10px;font-size:10px" data-install-plugin="${esc(p.key)}" data-install-repo="${esc(p.repo||'')}">Install</button></div>`;
          }
          for(const t of recTools){
            browseHtml+=`<div class="ccm-plugin-row"><div class="ccm-plugin-icon" style="background:#238636">${t.type==='mcp'?'🔌':'⚡'}</div><div class="ccm-plugin-info"><div><span class="ccm-plugin-name">${esc(t.name)}</span><span class="ccm-plugin-source">${esc(t.type)}</span></div><div class="ccm-plugin-desc">${esc(t.description||'')}</div></div><button class="ccm-btn ccm-btn-primary" style="padding:3px 10px;font-size:10px" data-install-tool="${esc(t.key)}">Install</button></div>`;
          }
          browseHtml+='<hr style="border:0;border-top:1px solid var(--bdr);margin:12px 0">';
        }
        browseHtml+=`
          <div class="ccm-add-repo" id="ccmAddRepo"><span style="font-size:18px;color:var(--acc)">+</span><div><div style="font-size:12px;color:var(--acc);font-weight:500">Add from GitHub Repository</div><div style="font-size:10px;color:var(--tx2)">Enter owner/repo to install a community plugin</div></div></div>
          <div id="ccmAddRepoForm" style="display:none;margin-bottom:12px">
            <div style="display:flex;gap:6px"><input class="ccm-plugin-search" style="flex:1" placeholder="owner/repo" id="ccmRepoInput"><button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmRepoInstall">Install</button></div>
            <div id="ccmRepoStatus" style="font-size:11px;margin-top:4px"></div>
          </div>
        `;
        list.innerHTML=browseHtml;
        // Register a single tool progress listener that routes to the right row
        const toolProgressEls={};
        window.api.onToolProgress(data=>{
          const el=toolProgressEls[data.key];
          if(!el)return;
          if(!data.done&&data.output){el.textContent=data.output.slice(-120)}
        });
        // Plugin install buttons — non-blocking with status
        list.querySelectorAll('[data-install-plugin]').forEach(btn=>{
          btn.onclick=async()=>{
            const key=btn.dataset.installPlugin;const repo=btn.dataset.installRepo||null;
            btn.textContent='Installing…';btn.disabled=true;btn.style.opacity='0.7';
            window.api.installClaudePlugin({source:key,repo:repo||null}).then(r=>{
              if(r.ok){btn.textContent='✓ Done';btn.style.background='var(--grn)';setTimeout(()=>renderPlugins(),800)}
              else{btn.textContent='Failed';btn.style.background='var(--red)';btn.disabled=false;btn.title=r.error||''}
            }).catch(()=>{btn.textContent='Error';btn.style.background='var(--red)';btn.disabled=false});
          };
        });
        // Tool install buttons — non-blocking with progress
        list.querySelectorAll('[data-install-tool]').forEach(btn=>{
          btn.onclick=async()=>{
            const key=btn.dataset.installTool;
            btn.textContent='Installing…';btn.disabled=true;btn.style.opacity='0.7';
            // Add a small progress area below the row
            const row=btn.closest('.ccm-plugin-row');
            let progEl=row.querySelector('.ccm-install-prog');
            if(!progEl){progEl=document.createElement('div');progEl.className='ccm-install-prog';progEl.style.cssText='font-size:9px;color:var(--tx2);margin-top:2px;max-height:40px;overflow:hidden;word-break:break-all';row.querySelector('.ccm-plugin-info').appendChild(progEl)}
            toolProgressEls[key]=progEl;
            window.api.installTool({key}).then(r=>{
              delete toolProgressEls[key];
              if(r.ok){btn.textContent='✓ Done';btn.style.background='var(--grn)';progEl.textContent='';setTimeout(()=>renderPlugins(),800)}
              else{btn.textContent='Failed';btn.style.background='var(--red)';btn.disabled=false;progEl.textContent=r.error||'';btn.title=r.error||''}
            }).catch(()=>{btn.textContent='Error';btn.style.background='var(--red)';btn.disabled=false});
          };
        });
        // Install All Recommended button
        const installAllRecBtn=list.querySelector('#ccmInstallAllRec');
        if(installAllRecBtn){
          installAllRecBtn.onclick=async()=>{
            installAllRecBtn.textContent='Installing…';installAllRecBtn.disabled=true;
            const allPluginBtns=[...list.querySelectorAll('[data-install-plugin]')];
            const allToolBtns=[...list.querySelectorAll('[data-install-tool]')];
            // Fire all installs concurrently
            for(const btn of allPluginBtns){if(!btn.disabled)btn.click()}
            for(const btn of allToolBtns){if(!btn.disabled)btn.click()}
            // Poll until all buttons settle (disabled+done or failed)
            const checkDone=()=>{
              const allBtns=[...allPluginBtns,...allToolBtns];
              const allSettled=allBtns.every(b=>b.textContent.includes('Done')||b.textContent.includes('Failed')||b.textContent.includes('Error'));
              if(allSettled){installAllRecBtn.textContent='Done!';setTimeout(()=>renderPlugins(),800)}
              else setTimeout(checkDone,500);
            };
            setTimeout(checkDone,1000);
          };
        }
        body.querySelector('#ccmAddRepo').onclick=()=>{
          body.querySelector('#ccmAddRepoForm').style.display='block';
          body.querySelector('#ccmAddRepo').style.display='none';
        };
        const installBtn=body.querySelector('#ccmRepoInstall');
        if(installBtn)installBtn.onclick=async()=>{
          const repo=body.querySelector('#ccmRepoInput').value.trim();
          const status=body.querySelector('#ccmRepoStatus');
          if(!repo||!repo.includes('/')){status.style.color='var(--red)';status.textContent='Enter owner/repo format';return}
          status.style.color='var(--ylw)';status.textContent='Installing...';
          const r=await window.api.installClaudePlugin({source:'github',repo});
          if(r.ok){status.style.color='var(--grn)';status.textContent='✓ Installed!';setTimeout(()=>renderPlugins(),1000)}
          else{status.style.color='var(--red)';status.textContent='✗ '+(r.error||'Failed')}
        };
      }
    }
    renderList();
  }

  }catch(e){logCcm('error','IIFE crashed:',e?.message||e)}
})();

// Safety net: if badge is still "Checking..." after 12s, recover it AND wire click handler
setTimeout(()=>{
  const bt=document.getElementById('ccBadgeText');
  const b=document.getElementById('ccBadge');
  if(window.api&&typeof window.api.logToFile==='function'){
    const msg=`badge text: ${bt?.textContent||''} clickWired: ${!!b?._ccmClickWired}`;
    window.api.logToFile('info','ccm',`Safety net fired at 12s — ${msg}`);
  }
  if(bt&&/checking/i.test(bt.textContent)){
    if(window.api&&typeof window.api.logToFile==='function'){
      window.api.logToFile('warn','ccm','Safety net: badge STILL stuck at "Checking..." — IIFE likely stalled or crashed before refreshBadge completed');
    }
    b.className='cc-badge missing';
    bt.textContent='Claude Code — click to check';
  }
  if(b&&!b._ccmClickWired){
    if(window.api&&typeof window.api.logToFile==='function'){
      window.api.logToFile('warn','ccm','Safety net: click handler was NOT wired by IIFE — wiring fallback click handler now');
    }
    b.addEventListener('click',async()=>{
      const overlay=document.getElementById('ccmOverlay');
      const modal=document.getElementById('ccmModal');
      if(overlay&&modal){
        try{
          const p=window.api.detectClaudeCode();
          const timeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),6000));
          await Promise.race([p,timeout]);
        }catch{}
        overlay.classList.add('show');modal.classList.add('show');
      }
    });
  } else if(b){
    if(window.api&&typeof window.api.logToFile==='function'){
      window.api.logToFile('info','ccm','Safety net: click handler already wired by IIFE — no action needed');
    }
  }
},12000);
