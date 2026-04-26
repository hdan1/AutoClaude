// ── Setup Health Check Modal ─────────────────────
(function(){
  const overlay=$('setupOverlay'), modal=$('setupModal');
  const items=$('setupItems'), actions=$('setupActions');
  const installAllBtn=$('setupInstallAll'), dismissBtn=$('setupDismiss');
  const progress=$('setupProgress'), progressText=$('setupProgressText'), progressFill=$('setupProgressFill');
  const success=$('setupSuccess'), recPrompt=$('setupRecommendedPrompt');
  const saveRecBtn=$('setupSaveRecommended'), skipRecBtn=$('setupSkipRecommended');
  const logInfo=$('setupLogInfo'), logPathEl=$('setupLogPath'), openLogsBtn=$('setupOpenLogs');
  let currentStatus=null;
  let diagnosticsBox=null;

  async function openSetup(status){
    currentStatus=status;
    renderItems(status);
    overlay.classList.add('show');modal.classList.add('show');
    progress.style.display='none';success.style.display='none';
    items.style.display='';actions.style.display='';
    ensureDiagnosticsBox();
    await refreshLogInfo();
    await refreshDiagnostics();
  }
  function closeSetup(){overlay.classList.remove('show');modal.classList.remove('show')}

  $('setupClose').onclick=closeSetup;
  overlay.onclick=closeSetup;
  dismissBtn.onclick=closeSetup;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('show'))closeSetup()});

  function renderItems(s){
    items.innerHTML='';
    // Prerequisite rows (shown first since they're needed before Claude Code)
    if(s.prerequisites){
      const prereqLabels={git:'Git (git-bash)',node:'Node.js'};
      for(const [name,info] of Object.entries(s.prerequisites)){
        if(!info.required) continue;
        if(info.installed){
          addItem('\u2705',prereqLabels[name]||name,'v'+(info.version||'installed'),null,null);
        } else {
          addItem('\u274C',prereqLabels[name]||name,'Not installed','Install',()=>doInstallPrerequisite(name));
        }
      }
    }
    // Claude Code row
    if(!s.claudeCode.installed){
      addItem('\u274C','Claude Code','Not installed','Install',()=>doInstallClaude());
    } else if(!s.claudeCode.authenticated){
      addItem('\u26A0\uFE0F','Claude Code v'+(s.claudeCode.version||''),'Not authenticated','Authenticate',()=>showAuthPicker());
    } else {
      addItem('\u2705','Claude Code v'+(s.claudeCode.version||''),(s.claudeCode.authType||'')+(s.claudeCode.authDetail?' \u2014 '+s.claudeCode.authDetail:''),null,null);
    }
    // Plugin rows — use the computed missing set from computeHealthStatus
    // which has smarter matching (base name, mcp: prefix) instead of exact key match
    const missingKeys=new Set((s.plugins.missing||[]).map(p=>p.key));
    for(const p of s.plugins.recommended){
      const baseName=(p.key||'').split('@')[0].toLowerCase();
      const isMissing=missingKeys.has(p.key);
      if(!isMissing){
        // Find matching installed entry for enabled/disabled check
        const inst=s.plugins.installed.find(i=>{
          if(i.key===p.key) return true;
          if((i.name||'').toLowerCase()===baseName) return true;
          if(i.key.toLowerCase()==='mcp:'+baseName) return true;
          return false;
        });
        if(inst&&inst.enabled===false){
          addItem('\u26A0\uFE0F',p.key.split('@')[0],'Disabled','Enable',()=>doEnablePlugin(inst.key));
        } else {
          const typeLabel=p.type==='mcp'?'MCP server':p.type==='skill'?'Skill':'Installed';
          addItem('\u2705',p.key.split('@')[0],typeLabel,null,null);
        }
      } else {
        addItem('\u274C',p.key.split('@')[0],'Missing','Install',()=>doInstallPlugin(p.key,p.repo));
      }
    }
    // Recommended tools (non-plugin items)
    if(s.tools&&s.tools.recommended){
      for(const t of s.tools.recommended){
        if(t.installed){
          addItem('\u2705',t.name,t.type==='mcp'?'MCP server':'Skill',null,null);
        } else {
          addItem('\u274C',t.name,t.description||'Not installed','Install',()=>doInstallTool(t.key,t.name));
        }
      }
    }
    // Show all other installed plugins/MCPs not in the recommended list
    const recommendedBaseNames=new Set((s.plugins.recommended||[]).map(p=>(p.key||'').split('@')[0].toLowerCase()));
    const extraInstalled=(s.plugins.installed||[]).filter(i=>{
      const iName=(i.name||'').toLowerCase();
      if(recommendedBaseNames.has(iName)) return false;
      // Also skip if the key minus mcp: prefix matches a recommended item
      if(i.key&&i.key.startsWith('mcp:')&&recommendedBaseNames.has(i.key.slice(4).toLowerCase())) return false;
      return true;
    });
    if(extraInstalled.length>0){
      for(const ei of extraInstalled){
        const label=ei.name||ei.key;
        const detail=ei.isMcp?'MCP server':(ei.community?'Community plugin':'Plugin');
        if(ei.enabled===false){
          addItem('\u26A0\uFE0F',label,detail+' (Disabled)','Enable',()=>doEnablePlugin(ei.key));
        } else {
          addItem('\u2705',label,detail,null,null);
        }
      }
    }
    const toolsMissing=s.tools&&s.tools.missing?s.tools.missing.length>0:false;
    const prereqMissing=s.prerequisites?Object.values(s.prerequisites).some(p=>p.required&&!p.installed):false;
    const hasMissing=prereqMissing||!s.claudeCode.installed||!s.claudeCode.authenticated||s.plugins.missing.length>0||toolsMissing;
    installAllBtn.style.display=hasMissing?'inline-block':'none';
    recPrompt.style.display=(s.recommendedEmpty&&s.plugins.installed.length>0)?'block':'none';
  }

  function addItem(icon,label,detail,btnText,btnFn){
    const row=document.createElement('div');
    row.className='setup-item';
    const iconSpan=document.createElement('span');
    iconSpan.className='status-icon';
    iconSpan.textContent=icon;
    const labelSpan=document.createElement('span');
    labelSpan.className='item-label';
    labelSpan.textContent=label;
    const detailSpan=document.createElement('span');
    detailSpan.className='item-detail';
    detailSpan.textContent=detail;
    labelSpan.appendChild(detailSpan);
    row.appendChild(iconSpan);
    row.appendChild(labelSpan);
    if(btnText&&btnFn){
      const btn=document.createElement('button');
      btn.className='setup-btn';
      btn.textContent=btnText;
      btn.onclick=btnFn;
      const actionSpan=document.createElement('span');
      actionSpan.className='item-action';
      actionSpan.appendChild(btn);
      row.appendChild(actionSpan);
    }
    items.appendChild(row);
  }

  function renderOperationalMessage(payload,fallback){
    return window.operationalStatus.renderOperationalMessage(payload,fallback);
  }

  function showOperationalFailure(summary,details,nextStep){
    showProgress(renderOperationalMessage({summary,details,nextSteps:nextStep?[nextStep]:[]},summary));
  }

  // Individual install actions
  async function doInstallPrerequisite(name){
    const labels={git:'Git (git-bash)',node:'Node.js'};
    showProgress('Installing '+(labels[name]||name)+'...');
    try{
      const result=await window.api.installPrerequisite({name});
      if(result.ok){await refreshStatus();}
      else{showOperationalFailure('Install failed',result.error||'Unknown error','retry install');}
    }catch(e){showOperationalFailure('Install error',e.message,'retry install');}
  }
  async function doInstallClaude(){
    const method=navigator.platform.startsWith('Win')?'powershell':'curl';
    showProgress('Installing Claude Code...');
    try{
      const result=await window.api.installClaudeCode({method});
      if(result.ok){await refreshStatus();}
      else{showOperationalFailure('Install failed',result.error||'Unknown error','retry install');}
    }catch(e){showOperationalFailure('Install error',e.message,'retry install');}
  }
  function showAuthPicker(){
    closeSetup();
    if(window._ccmOpenAuth) window._ccmOpenAuth();
  }
  async function doInstallPlugin(key,repo){
    const name=key.split('@')[0];
    showProgress('Installing '+name+'...');
    try{
      // Pass full key as source — backend handles both key-based and legacy formats
      const result=await window.api.installClaudePlugin({source:key,repo:repo||null});
      if(result.ok){await refreshStatus();}
      else{showOperationalFailure('Plugin install failed',result.error||'Unknown error','retry install');}
    }catch(e){showOperationalFailure('Plugin install error',e.message,'retry install');}
  }
  async function doEnablePlugin(key){
    const name=key.split('@')[0];
    showProgress('Enabling '+name+'...');
    try{
      const result=await window.api.toggleClaudePlugin({pluginKey:key,enabled:true});
      if(result.ok){await refreshStatus();}
      else{showOperationalFailure('Enable failed',result.error||'Unknown error','retry enable');}
    }catch(e){showOperationalFailure('Enable error',e.message,'retry enable');}
  }
  async function doInstallTool(key,name){
    showProgress('Installing '+(name||key)+'... (this may open an interactive prompt)');
    try{
      const result=await window.api.installTool({key});
      if(result.ok){await refreshStatus();}
      else{showOperationalFailure('Install failed',result.error||'Unknown error','retry install');}
    }catch(e){showOperationalFailure('Install error',e.message,'retry install');}
  }

  // Install All Missing — sequential
  installAllBtn.onclick=async function(){
    installAllBtn.disabled=true;
    try{
      const s=currentStatus;
      // Count missing prerequisites
      const missingPrereqs=s.prerequisites?Object.entries(s.prerequisites).filter(([,info])=>info.required&&!info.installed):[];
      const missingTools=s.tools&&s.tools.missing?s.tools.missing:[];
      let step=0;
      const total=missingPrereqs.length+(!s.claudeCode.installed?1:0)+(!s.claudeCode.authenticated?1:0)+s.plugins.missing.length+missingTools.length;
      if(total===0){return;}

      // Install prerequisites first
      const prereqLabels={git:'Git (git-bash)',node:'Node.js'};
      for(const [name] of missingPrereqs){
        step++;updateProgress(step,total,'Installing '+(prereqLabels[name]||name)+'...');
        try{
          const r=await window.api.installPrerequisite({name});
          if(!r.ok){showOperationalFailure('Install '+(prereqLabels[name]||name)+' failed',r.error||'Unknown error','retry install');return;}
        }catch(e){showOperationalFailure('Install '+(prereqLabels[name]||name)+' error',e.message,'retry install');return;}
      }

      if(!s.claudeCode.installed){
        step++;updateProgress(step,total,'Installing Claude Code...');
        try{
          const r=await window.api.installClaudeCode({method:navigator.platform.startsWith('Win')?'powershell':'curl'});
          if(!r.ok){showOperationalFailure('Install failed',r.error||'Unknown error','retry install');return;}
        }catch(e){showOperationalFailure('Install error',e.message,'retry install');return;}
      }
      // Refresh detection after install
      const freshClaudeState=await window.api.getClaudeStateFacade();
      if(!freshClaudeState.installed){showProgress('Claude Code install did not succeed.');return;}

      if(!freshClaudeState.authType){
        step++;updateProgress(step,total,'Authenticating...');
        try{
          const r=await window.api.authenticateClaudeCode({method:'oauth'});
          if(!r.ok){showOperationalFailure('Auth failed',r.error||'Unknown error','retry authentication');return;}
        }catch(e){showOperationalFailure('Auth error',e.message,'retry authentication');return;}
      }

      for(const p of s.plugins.missing){
        step++;updateProgress(step,total,'Installing '+p.key.split('@')[0]+'...');
        try{
          const r=await window.api.installClaudePlugin({source:p.key,repo:p.repo||null});
          if(!r.ok){showOperationalFailure('Plugin install failed',r.error||'Unknown error','retry install');return;}
        }catch(e){showOperationalFailure('Plugin install error',e.message,'retry install');return;}
      }

      for(const t of missingTools){
        step++;updateProgress(step,total,'Installing '+(t.name||t.key)+'...');
        try{
          const r=await window.api.installTool({key:t.key});
          if(!r.ok){showOperationalFailure('Tool install failed',r.error||'Unknown error','retry install');return;}
        }catch(e){showOperationalFailure('Tool install error',e.message,'retry install');return;}
      }

      await refreshStatus();
    }finally{
      installAllBtn.disabled=false;
    }
  };

  // Save as recommended
  saveRecBtn.onclick=async function(){
    try{
      const result=await window.api.snapshotRecommendedPlugins();
      recPrompt.style.display='none';
      const count=Array.isArray(result)?result.length:0;
      showProgress('Saved '+count+' plugin(s) as recommended.');
      setTimeout(()=>{progress.style.display='none';},2000);
    }catch(e){showProgress(renderOperationalMessage({summary:'Save recommended failed',details:e.message,nextSteps:['retry save recommended']},'Save recommended failed'));}
  };
  skipRecBtn.onclick=()=>{recPrompt.style.display='none';};
  if(openLogsBtn){
    openLogsBtn.onclick=async()=>{
      try{
        const result=await window.api.openAppLogFolder();
        if(!result?.ok){showProgress(renderOperationalMessage({summary:'Open logs failed',details:(result?.error||'Unknown error'),nextSteps:['retry opening logs']},'Open logs failed'));}
      }catch(e){showProgress(renderOperationalMessage({summary:'Open logs failed',details:e.message,nextSteps:['retry opening logs']},'Open logs failed'));}
    };
  }

  function ensureDiagnosticsBox(){
    if(diagnosticsBox||!logInfo||!logInfo.parentNode)return;
    diagnosticsBox=document.createElement('pre');
    diagnosticsBox.style.cssText='margin-top:10px;padding:8px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg2);color:var(--tx2);font-size:11px;white-space:pre-wrap';
    logInfo.insertAdjacentElement('afterend',diagnosticsBox);
  }

  async function refreshLogInfo(){
    if(!logInfo||!logPathEl)return;
    try{
      const info=await window.api.getAppLogInfo();
      if(info?.ok&&info.path){
        logPathEl.textContent=info.path+(info.exists?'':' (will be created on first log)');
        logInfo.style.display='block';
      }else{
        logInfo.style.display='none';
      }
    }catch{
      logInfo.style.display='none';
    }
  }

  async function refreshDiagnostics(){
    if(!diagnosticsBox)return;
    try{
      const d=await window.api.getDiagnostics({tabId:document.querySelector('.t.active')?.dataset?.tabId||null});
      diagnosticsBox.textContent=[
        `App: ${d.appVersion||'unknown'}`,
        `Claude: ${d.claudeVersion||'unknown'} (${d.authType||'no auth'})`,
        `Path: ${d.claudePath||'unknown'}`,
        `Workspace: ${d.workspacePath||'none'}`,
        `Updater: ${d.updaterStatus||'idle'}`,
        `Telemetry degraded: ${d.telemetryDegraded?'yes':'no'}`,
        `Last error: ${d.lastError||'none'}`,
        `Logs: ${d.logPath||'unknown'}`,
      ].join('\n');
    }catch{
      diagnosticsBox.textContent='Diagnostics unavailable';
    }
  }

  // Progress helpers
  function showProgress(text){progress.style.display='block';progressText.textContent=text;progressFill.style.width='0%';}
  function updateProgress(step,total,text){
    progress.style.display='block';
    progressText.textContent=text;
    progressFill.style.width=Math.round((step/total)*100)+'%';
  }

  // Refresh health status and re-render
  async function refreshStatus(){
    try{
      const s=await window.api.runHealthCheck();
      if(!s)return;
      currentStatus=s;
      renderItems(s);
      await refreshDiagnostics();
      progress.style.display='none';
      if(s.healthy){
        success.style.display='block';
        items.style.display='none';
        actions.style.display='none';
        recPrompt.style.display='none';
        setTimeout(closeSetup,2000);
      }
    }catch(e){showProgress(renderOperationalMessage({summary:'Health check failed',details:e.message,nextSteps:['retry health check']},'Health check failed'));}
  }

  // Listen for health check from main process (startup)
  window.api.onHealthCheck(status=>{
    if(!status.healthy){openSetup(status);}
  });

  // Install progress listener for streaming output
  window.api.onInstallProgress(data=>{
    if(data.output)progressText.textContent=data.output.trim().split('\n').pop()||'';
    if(data.done&&!data.error)progressText.textContent='Installation complete.';
    if(data.error)showOperationalFailure('Install failed',data.error,'retry install');
  });
})();
