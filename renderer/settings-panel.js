(function(){
  const overlay=$('settingsOverlay'),panel=$('settingsPanel');
  const sidebar=$('settingsSidebar'),content=$('settingsContent');
  const btnOpen=$('btnSettings');
  let activeCategory='workspace';
  let schema=null,categories=null;

  function showPanel(){overlay.classList.add('show');panel.classList.add('show');loadSettings()}
  function hidePanel(){overlay.classList.remove('show');panel.classList.remove('show')}

  btnOpen.onclick=showPanel;
  overlay.onclick=hidePanel;

  async function loadSettings(){
    if(!schema){
      const res=await window.api.getSettingsSchema();
      schema=res.schema;categories=res.categories;
      renderSidebar();
    }
    renderCategory(activeCategory);
  }

  function renderSidebar(){
    sidebar.innerHTML='<div class="settings-sidebar-label">Settings</div>';
    for(const cat of categories){
      const tab=document.createElement('div');
      tab.className='settings-tab'+(cat.key===activeCategory?' active':'');
      tab.textContent=cat.icon+' '+cat.label;
      tab.onclick=()=>{
        activeCategory=cat.key;
        sidebar.querySelectorAll('.settings-tab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        renderCategory(cat.key);
      };
      sidebar.appendChild(tab);
    }
  }

  async function renderCategory(cat){
    const values=await window.api.getSettingsGroup(cat);
    content.innerHTML='';

    const catInfo=categories.find(c=>c.key===cat);
    const header=document.createElement('h3');
    header.innerHTML=`${catInfo?catInfo.icon+' '+catInfo.label:cat}<button class="settings-close" id="settingsClose">&times;</button>`;
    content.appendChild(header);
    content.querySelector('#settingsClose').onclick=hidePanel;

    // Special workspace tab — has project list, root picker, create project
    if(cat==='workspace'){
      renderWorkspaceTab(content,values);
      return;
    }

    // Special telegram tab — has token, test, discover
    if(cat==='telegram'){
      renderTelegramTab(content,values);
      return;
    }

    // Special session tab — dynamic model/effort
    if(cat==='session'){
      renderSessionTab(content,values);
      return;
    }

    const tip=(meta)=>meta.description?`<span class="settings-tip" onmouseenter="positionTip(this)">ⓘ<span class="stip">${escHtml(meta.description)}</span></span>`:'';
    function positionTip(el){const s=el.querySelector('.stip');if(!s)return;const r=el.getBoundingClientRect();s.style.left=Math.max(8,Math.min(r.left,window.innerWidth-290))+'px';s.style.top=(r.bottom+6)+'px'}    // Generic settings rendering
    for(const [key,meta] of Object.entries(schema)){
      if(meta.category!==cat)continue;
      if(meta.type==='hidden')continue;
      const val=values[key]??meta.default;
      const field=document.createElement('div');
      field.className='settings-field';

      if(meta.type==='toggle'){
        field.innerHTML=`<div class="settings-row"><span style="flex:1;font-size:13px;color:var(--tx)">${meta.label}${tip(meta)}</span><button class="settings-toggle${val?' on':''}" data-key="${key}"></button><span class="settings-saved" data-saved="${key}">Saved ✓</span></div>`;
        const btn=field.querySelector('.settings-toggle');
        btn.onclick=()=>{
          btn.classList.toggle('on');
          saveSetting(key,btn.classList.contains('on'));
        };
      } else if(meta.type==='number'){
        field.innerHTML=`<label class="settings-label">${meta.label}${tip(meta)}</label><div class="settings-row"><input type="number" class="settings-number" value="${val??''}" data-key="${key}"${meta.min!=null?' min="'+meta.min+'"':''}><span class="settings-saved" data-saved="${key}">Saved ✓</span></div>`;
        const inp=field.querySelector('input');
        inp.onblur=()=>{
          if(inp.value===''){saveSetting(key,meta.default??null);inp.value=meta.default??'';return}
          let v=Number(inp.value);
          if(isNaN(v)){v=meta.default??null;inp.value=v??''}
          else{if(meta.min!=null&&v<meta.min){v=meta.min;inp.value=v}if(meta.max!=null&&v>meta.max){v=meta.max;inp.value=v}}
          saveSetting(key,v);
        };
        inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur()});
      } else if(meta.type==='select'){
        let opts=(meta.options||[]).map(o=>`<option value="${o}"${o===val?' selected':''}>${o}</option>`).join('');
        field.innerHTML=`<label class="settings-label">${meta.label}${tip(meta)}</label><div class="settings-row"><select class="settings-select" data-key="${key}">${opts}</select><span class="settings-saved" data-saved="${key}">Saved ✓</span></div>`;
        const sel=field.querySelector('select');
        sel.onchange=()=>saveSetting(key,sel.value);
      } else if(meta.type==='text'||meta.type==='path'){
        field.innerHTML=`<label class="settings-label">${meta.label}${tip(meta)}</label><div style="position:relative"><div class="settings-row"><input type="text" class="settings-input" value="${escHtml(val||'')}" data-key="${key}"><span class="settings-saved" data-saved="${key}">Saved ✓</span></div>${key==='defaultPrompt'?'<div class="cmd-picker" id="settingsCmdPicker" style="top:36px;left:0;right:0;z-index:220"></div>':''}</div>`;
        const inp=field.querySelector('input');
        inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur()});
        if(key==='defaultPrompt'){
          attachCmdPicker(inp, field.querySelector('#settingsCmdPicker'), key);
        } else {
          inp.onblur=()=>saveSetting(key,inp.value);
        }
      }
      content.appendChild(field);
    }

    // Add "Set as recommended" button for System category
    if(cat==='system'){
      const recDiv=document.createElement('div');
      recDiv.style.cssText='margin-top:18px;padding-top:14px;border-top:1px solid var(--bdr)';
      const label=document.createElement('label');
      label.className='settings-label';
      label.textContent='Recommended Plugins';
      recDiv.appendChild(label);
      const desc=document.createElement('p');
      desc.style.cssText='font-size:12px;color:var(--tx2);margin:4px 0 10px';
      desc.textContent='Snapshot your currently installed Claude Code plugins as the recommended set. The setup modal will prompt to install these on fresh setups.';
      recDiv.appendChild(desc);
      const btn=document.createElement('button');
      btn.className='setup-btn primary';
      btn.textContent='Set current plugins as recommended';
      const resultSpan=document.createElement('span');
      resultSpan.style.cssText='margin-left:8px;font-size:12px;color:var(--ac,#58a6ff);display:none';
      btn.onclick=async()=>{
        btn.disabled=true;btn.textContent='Saving...';
        try{
          const result=await window.api.snapshotRecommendedPlugins();
          const count=Array.isArray(result)?result.length:0;
          resultSpan.textContent='Saved '+count+' plugin(s) \u2713';
          resultSpan.style.display='inline';
          setTimeout(()=>{resultSpan.style.display='none'},3000);
        }catch(e){
          resultSpan.textContent='Error: '+e.message;
          resultSpan.style.display='inline';
        }
        btn.disabled=false;btn.textContent='Set current plugins as recommended';
      };
      recDiv.appendChild(btn);
      recDiv.appendChild(resultSpan);
      content.appendChild(recDiv);

      const diagnosticsDiv=document.createElement('div');
      diagnosticsDiv.style.cssText='margin-top:18px;padding-top:14px;border-top:1px solid var(--bdr)';
      const diagnosticsLabel=document.createElement('label');
      diagnosticsLabel.className='settings-label';
      diagnosticsLabel.textContent='Diagnostics';
      diagnosticsDiv.appendChild(diagnosticsLabel);
      const diagnosticsBox=document.createElement('pre');
      diagnosticsBox.style.cssText='margin:6px 0 0;padding:8px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg2);color:var(--tx2);font-size:11px;white-space:pre-wrap';
      diagnosticsBox.textContent='Loading diagnostics...';
      diagnosticsDiv.appendChild(diagnosticsBox);
      content.appendChild(diagnosticsDiv);
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
  }

  function escHtml(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

  function attachCmdPicker(inp, pickerEl, key) {
    let pkIdx=-1;let pickingCmd=false;
    inp.onblur=()=>{setTimeout(()=>{if(!pickingCmd)saveSetting(key,inp.value)},150)};
    inp.addEventListener('input',()=>{
      const v=inp.value;
      if(!v.startsWith('/')){pickerEl.classList.remove('vis');pkIdx=-1;return}
      const items=buildPickerItems(v);const cmds=items.filter(i=>i.type==='cmd');
      if(!cmds.length){pickerEl.classList.remove('vis');pkIdx=-1;return}
      pickerEl.innerHTML='';let ci=0;
      items.forEach(item=>{if(item.type==='header'){const h=document.createElement('div');h.className='cmd-cat';h.textContent=item.text;pickerEl.appendChild(h)}else{const d=document.createElement('div');d.className='cmd-item'+(ci===pkIdx?' sel':'');d.innerHTML=`<span class="cn">${esc(item.cmd)}</span><span class="cd">${esc(item.desc)}</span>`;d.onmousedown=()=>{pickingCmd=true};d.onclick=()=>{inp.value=item.cmd;pickerEl.classList.remove('vis');pkIdx=-1;pickingCmd=false;saveSetting(key,item.cmd)};pickerEl.appendChild(d);ci++}});
      pickerEl.classList.add('vis');
    });
    inp.addEventListener('keydown',e=>{
      if(!pickerEl.classList.contains('vis'))return;
      const items=pickerEl.querySelectorAll('.cmd-item');
      if(e.key==='ArrowDown'){e.preventDefault();pkIdx=Math.min(pkIdx+1,items.length-1);items.forEach((it,i)=>it.classList.toggle('sel',i===pkIdx))}
      else if(e.key==='ArrowUp'){e.preventDefault();pkIdx=Math.max(pkIdx-1,0);items.forEach((it,i)=>it.classList.toggle('sel',i===pkIdx))}
      else if((e.key==='Enter'||e.key==='Tab')&&pkIdx>=0&&items[pkIdx]){e.preventDefault();items[pkIdx].click()}
      else if(e.key==='Escape'){pickerEl.classList.remove('vis');pkIdx=-1}
    });
  }

  async function saveSetting(key,value){
    await window.api.setSetting(key,value);
    const indicator=content.querySelector(`[data-saved="${key}"]`);
    if(indicator){indicator.classList.add('show');setTimeout(()=>indicator.classList.remove('show'),2000)}
  }

  // ── Session Tab (special — dynamic model/effort) ──
  async function renderSessionTab(container,values){
    const tip=(meta)=>meta.description?`<span class="settings-tip" onmouseenter="positionTip(this)">\u24d8<span class="stip">${escHtml(meta.description)}</span></span>`:'';

    // Render generic session fields first (defaultPrompt, skipPermissions)
    for(const [key,meta] of Object.entries(schema)){
      if(meta.category!=='session')continue;
      if(meta.type==='hidden'||key==='session.model'||key==='session.effort')continue;
      const val=values[key]??meta.default;
      const field=document.createElement('div');
      field.className='settings-field';
      if(meta.type==='toggle'){
        field.innerHTML=`<div class="settings-row"><span style="flex:1;font-size:13px;color:var(--tx)">${meta.label}${tip(meta)}</span><button class="settings-toggle${val?' on':''}" data-key="${key}"></button><span class="settings-saved" data-saved="${key}">Saved \u2713</span></div>`;
        const btn=field.querySelector('.settings-toggle');
        btn.onclick=()=>{btn.classList.toggle('on');saveSetting(key,btn.classList.contains('on'))};
      } else if(meta.type==='text'||meta.type==='path'){
        field.innerHTML=`<label class="settings-label">${meta.label}${tip(meta)}</label><div style="position:relative"><div class="settings-row"><input type="text" class="settings-input" value="${escHtml(val||'')}" data-key="${key}"><span class="settings-saved" data-saved="${key}">Saved \u2713</span></div>${key==='defaultPrompt'?'<div class="cmd-picker" id="settingsCmdPicker" style="top:36px;left:0;right:0;z-index:220"></div>':''}</div>`;
        const inp=field.querySelector('input');
        inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur()});
        if(key==='defaultPrompt'){
          attachCmdPicker(inp, field.querySelector('#settingsCmdPicker'), key);
        } else {
          inp.onblur=()=>saveSetting(key,inp.value);
        }
      }
      container.appendChild(field);
    }

    // ── Model dropdown (dynamic from API) ──
    const modelVal=values['session.model']||'auto';
    const modelField=document.createElement('div');
    modelField.className='settings-field';
    const modelMeta=schema['session.model']||{};
    modelField.innerHTML=`<label class="settings-label">Model${tip(modelMeta)} <button class="sm" id="refreshModelsBtn" style="font-size:11px;padding:2px 8px;margin-left:8px">\u21bb Refresh</button> <button class="sm" id="loadAnthropicBtn" style="font-size:11px;padding:2px 8px">Anthropic API</button> <button class="sm" id="loadDefaultsBtn" style="font-size:11px;padding:2px 8px">Defaults</button></label><div class="settings-row"><select class="settings-select" id="sessionModelSelect"><option value="auto"${modelVal==='auto'?' selected':''}>auto</option></select><span class="settings-saved" data-saved="session.model">Saved \u2713</span></div><div style="margin-top:6px;display:flex;gap:4px;align-items:center"><input type="text" class="settings-input" id="addModelInput" placeholder="Add model ID..." style="flex:1;font-size:11px;padding:4px 6px"><button class="sm" id="addModelBtn" style="font-size:11px;padding:2px 8px">+ Add</button><button class="sm" id="removeModelBtn" style="font-size:11px;padding:2px 8px">- Remove Selected</button></div><div id="modelStatus" style="font-size:11px;color:var(--tx2);margin-top:4px"></div>`;
    container.appendChild(modelField);

    // ── Effort dropdown ──
    const effortVal=values['session.effort']||'auto';
    const effortField=document.createElement('div');
    effortField.className='settings-field';
    const effortMeta=schema['session.effort']||{};
    effortField.innerHTML=`<label class="settings-label">Effort${tip(effortMeta)}</label><div class="settings-row"><select class="settings-select" id="sessionEffortSelect"><option value="auto">auto</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="max">max</option></select><span class="settings-saved" data-saved="session.effort">Saved \u2713</span></div>`;
    container.appendChild(effortField);

    const modelSel=container.querySelector('#sessionModelSelect');
    const effortSel=container.querySelector('#sessionEffortSelect');
    const modelStatus=container.querySelector('#modelStatus');
    const refreshBtn=container.querySelector('#refreshModelsBtn');
    const loadAnthropicBtn=container.querySelector('#loadAnthropicBtn');
    const loadDefaultsBtn=container.querySelector('#loadDefaultsBtn');
    const addModelInput=container.querySelector('#addModelInput');
    const addModelBtn=container.querySelector('#addModelBtn');
    const removeModelBtn=container.querySelector('#removeModelBtn');

    // Set initial effort value
    effortSel.value=effortVal;

    // Model data cache for effort lookup
    let modelData=[];

    function updateEffortState(){
      const sel=modelSel.value;
      if(sel==='auto'){
        effortSel.disabled=false;
        effortSel.title='';
        return;
      }
      const m=modelData.find(x=>x.id===sel);
      if(m&&!m.effortSupported){
        effortSel.disabled=true;
        effortSel.value='auto';
        effortSel.title='This model does not support effort levels';
        saveSetting('session.effort','auto');
        updateEffortCard('auto');
      } else if(m&&m.effortSupported){
        effortSel.disabled=false;
        effortSel.title='';
        // Filter to only supported levels
        const supported=['auto',...m.effortLevels];
        for(const opt of effortSel.options){
          opt.disabled=!supported.includes(opt.value);
        }
        if(effortSel.selectedOptions[0]?.disabled){
          effortSel.value='auto';
          saveSetting('session.effort','auto');
          updateEffortCard('auto');
        }
      } else {
        effortSel.disabled=false;
        effortSel.title='';
      }
    }

    function updateEffortCard(val){
      // Update dashboard effort display for active tab
      const activeTabId=document.querySelector('.tab.active')?.dataset?.tabId;
      if(activeTabId){
        const eff=$t(activeTabId,'cEffort');
        if(eff)eff.textContent=val&&val!=='auto'?'effort: '+val:'';
      }
    }

    async function loadModels(){
      modelStatus.textContent='Fetching models...';
      refreshBtn.disabled=true;
      try{
        // Check for saved custom model list first
        const custom=await window.api.getCustomModels();
        let res;
        if(custom.models&&custom.models.length>0){
          res={models:custom.models,cached:false};
          modelStatus.textContent=custom.models.length+' custom models';
          modelStatus.style.color='var(--tx2)';
        } else {
          res=await window.api.fetchModels();
        }
        modelData=res.models||[];
        populateModelSelect(modelData,res);
      }catch(e){
        modelStatus.textContent='\u26a0 '+e.message;
        modelStatus.style.color='var(--warn,#f0ad4e)';
      }
      refreshBtn.disabled=false;
      updateEffortState();
    }

    function populateModelSelect(models,res){
      modelSel.innerHTML='<option value="auto">auto</option>';
      for(const m of models){
        const opt=document.createElement('option');
        opt.value=m.id;
        const short=m.id.replace(/^claude-/,'').replace(/-\d{8}$/,'');
        opt.textContent=short+(m.effortSupported===false?' (no effort)':'');
        if(m.id===modelVal)opt.selected=true;
        modelSel.appendChild(opt);
      }
      if(res&&res.error){
        modelStatus.textContent='\u26a0 '+res.error;
        modelStatus.style.color='var(--warn,#f0ad4e)';
      } else if(!res||!res.models||res.models.length===0){
        // no-op, keep existing status
      } else if(!modelStatus.textContent.includes('custom')){
        modelStatus.textContent=models.length+' models loaded';
        modelStatus.style.color='var(--tx2)';
        setTimeout(()=>{if(modelStatus.textContent.includes('loaded'))modelStatus.textContent=''},3000);
      }
    }

    modelSel.onchange=()=>{
      saveSetting('session.model',modelSel.value);
      updateEffortState();
    };
    effortSel.onchange=()=>{
      saveSetting('session.effort',effortSel.value);
      updateEffortCard(effortSel.value);
    };
    refreshBtn.onclick=async()=>{
      // Clear custom models and re-fetch from configured API
      await window.api.saveCustomModels({models:null});
      loadModels();
    };
    loadAnthropicBtn.onclick=async()=>{
      modelStatus.textContent='Fetching from Anthropic...';
      try{
        const res=await window.api.fetchModelsAnthropic();
        modelData=res.models||[];
        await window.api.saveCustomModels({models:modelData});
        populateModelSelect(modelData,res);
        modelStatus.textContent=modelData.length+' models from Anthropic API';
        modelStatus.style.color='var(--tx2)';
      }catch(e){modelStatus.textContent='\u26a0 '+e.message;modelStatus.style.color='var(--warn,#f0ad4e)';}
    };
    loadDefaultsBtn.onclick=async()=>{
      const res=await window.api.getDefaultModels();
      modelData=res.models||[];
      await window.api.saveCustomModels({models:modelData});
      populateModelSelect(modelData,{});
      modelStatus.textContent=modelData.length+' default models loaded';
      modelStatus.style.color='var(--tx2)';
    };
    addModelBtn.onclick=async()=>{
      const id=addModelInput.value.trim();
      if(!id)return;
      // Check if already exists
      if(modelData.some(m=>m.id===id)){modelStatus.textContent='Model already in list';modelStatus.style.color='var(--warn,#f0ad4e)';return;}
      const newModel={id,displayName:id,effortSupported:true,effortLevels:['low','medium','high','max'],maxInputTokens:200000,maxOutputTokens:16000,createdAt:null};
      modelData.push(newModel);
      await window.api.saveCustomModels({models:modelData});
      populateModelSelect(modelData,{});
      addModelInput.value='';
      modelStatus.textContent='Added '+id;
      modelStatus.style.color='var(--tx2)';
    };
    addModelInput.addEventListener('keydown',e=>{if(e.key==='Enter')addModelBtn.click()});
    removeModelBtn.onclick=async()=>{
      const sel=modelSel.value;
      if(sel==='auto'){modelStatus.textContent='Cannot remove "auto"';modelStatus.style.color='var(--warn,#f0ad4e)';return;}
      modelData=modelData.filter(m=>m.id!==sel);
      await window.api.saveCustomModels({models:modelData});
      modelSel.value='auto';
      saveSetting('session.model','auto');
      populateModelSelect(modelData,{});
      modelStatus.textContent='Removed '+sel;
      modelStatus.style.color='var(--tx2)';
      updateEffortState();
    };

    // Load models on open
    loadModels();
  }

  // ── Workspace Tab (special) ────────────────────
  async function renderWorkspaceTab(container,values){
    const ws={root:values['workspaceRoot']||'',projects:[],selected:'',gitAvailable:true};

    container.insertAdjacentHTML('beforeend',`
      <div class="settings-field">
        <label class="settings-label">Workspace Root<span class="settings-tip" onmouseenter="positionTip(this)">ⓘ<span class="stip">Base directory for project discovery. Subfolders appear as launchable projects.</span></span></label>
        <div class="settings-row">
          <div class="workspace-root" id="sWsRoot" style="flex:1;min-height:30px;padding:6px 8px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg);color:var(--tx);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(ws.root||'Not configured')}</div>
          <button class="sm" id="sWsPickRoot">Browse</button>
          <button class="sm" id="sWsSaveRoot">Save</button>
        </div>
        <div class="workspace-msg" id="sWsRootStatus"></div>
      </div>
      <div class="settings-field">
        <div class="settings-row" style="margin-bottom:8px">
          <label class="settings-label" style="margin:0;flex:1">Projects<span class="settings-tip" onmouseenter="positionTip(this)">ⓘ<span class="stip">Subdirectories found in Workspace Root. Click Open to load a project into the current tab.</span></span></label>
          <button class="sm" id="sWsRefresh" style="font-size:11px">↻ Refresh</button>
        </div>
        <div class="workspace-list" id="sWsList" style="max-height:200px"></div>
        <div class="workspace-msg" id="sWsListStatus"></div>
      </div>
      <div class="settings-field">
        <label class="settings-label">Create Project<span class="settings-tip" onmouseenter="positionTip(this)">ⓘ<span class="stip">Create a new subdirectory in Workspace Root and initialize it as a project.</span></span></label>
        <div class="settings-row">
          <input class="settings-input" id="sWsNewName" type="text" placeholder="my-project" maxlength="80">
          <button class="sm" id="sWsCreate">+ Create</button>
        </div>
        <div class="workspace-msg" id="sWsCreateMsg"></div>
      </div>
      <div class="settings-field">
        <label class="settings-label">App Logs<span class="settings-tip" onmouseenter="positionTip(this)">ⓘ<span class="stip">Open the Auto Claude logs folder and share the log file when reporting issues.</span></span></label>
        <div class="settings-row">
          <div class="workspace-root" id="sWsLogPath" style="flex:1;min-height:30px;padding:6px 8px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg);color:var(--tx);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Loading...</div>
          <button class="sm" id="sWsOpenLogs">Open Logs</button>
        </div>
        <div class="workspace-msg" id="sWsLogsStatus"></div>
      </div>
    `);

    const rootEl=$('sWsRoot'),rootStatus=$('sWsRootStatus');
    const listEl=$('sWsList'),listStatus=$('sWsListStatus');
    const inputNew=$('sWsNewName'),createMsg=$('sWsCreateMsg');
    const logsPathEl=$('sWsLogPath'),logsStatusEl=$('sWsLogsStatus');

    function setMsg(el,msg,kind){el.textContent=msg||'';el.className='workspace-msg'+(kind?' '+kind:'')}

    $('sWsPickRoot').onclick=async()=>{
      const res=await window.api.selectDirectory({});
      if(!res)return;
      const p=typeof res==='object'?(res.path||null):res;
      if(!p)return;
      rootEl.textContent=p;rootEl.title=p;
      setMsg(rootStatus,'Selected. Click Save to persist.',null);
    };
    $('sWsSaveRoot').onclick=async()=>{
      const next=(rootEl.textContent||'').trim();
      const val=next==='Not configured'?'':next;
      await window.api.setSetting('workspaceRoot',val);
      ws.root=val;
      setMsg(rootStatus,'Workspace root saved.','ok');
      refreshProjects();
    };
    $('sWsRefresh').onclick=()=>refreshProjects();
    $('sWsCreate').onclick=async()=>{
      const name=inputNew.value.trim();
      if(!name){setMsg(createMsg,'Project name is required.','err');return}
      setMsg(createMsg,'Creating...','');
      try{
        const res=await window.api.newWorkspaceProject(name);
        if(!res?.ok){setMsg(createMsg,res?.error||'Failed','err');return}
        inputNew.value='';setMsg(createMsg,'Created: '+name,'ok');
        refreshProjects();
      }catch(e){setMsg(createMsg,e.message,'err')}
    };

    async function refreshLogsInfo(){
      if(!logsPathEl)return;
      logsPathEl.textContent='Loading...';
      logsPathEl.title='';
      try{
        const info=await window.api.getAppLogInfo();
        if(info?.ok&&info.path){
          const suffix=info.exists?'':' (created on first log entry)';
          const text=info.path+suffix;
          logsPathEl.textContent=text;
          logsPathEl.title=text;
          setMsg(logsStatusEl,'','');
        }else{
          logsPathEl.textContent='Unavailable';
          setMsg(logsStatusEl,info?.error||'Could not load log path.','err');
        }
      }catch(e){
        logsPathEl.textContent='Unavailable';
        setMsg(logsStatusEl,e.message,'err');
      }
    }

    $('sWsOpenLogs').onclick=async()=>{
      setMsg(logsStatusEl,'Opening logs folder...','');
      try{
        const res=await window.api.openAppLogFolder();
        if(res?.ok){setMsg(logsStatusEl,'Opened logs folder.','ok');}
        else{setMsg(logsStatusEl,res?.error||'Failed to open logs folder.','err');}
      }catch(e){setMsg(logsStatusEl,e.message,'err')}
    };

    async function refreshProjects(){
      if(!ws.root){listEl.innerHTML='<div class="workspace-empty"><p>Set workspace root first</p></div>';return}
      setMsg(listStatus,'Loading...','');
      try{
        const res=await window.api.listWorkspaceProjects();
        if(!res?.ok){setMsg(listStatus,res?.error||'Failed','err');return}
        ws.projects=res.projects||[];
        renderProjectList();
        setMsg(listStatus,ws.projects.length+' project(s)','ok');
      }catch(e){setMsg(listStatus,e.message,'err')}
    }

    function renderProjectList(){
      listEl.innerHTML='';
      if(!ws.projects.length){
        listEl.innerHTML='<div class="workspace-empty" style="padding:16px"><p style="margin:0;color:var(--tx2);font-size:13px">No projects found</p></div>';
        return;
      }
      for(const p of ws.projects){
        const row=document.createElement('div');row.className='workspace-item';
        row.innerHTML=`<div class="workspace-item-name" title="${escHtml(p.path)}">${escHtml(p.name)}</div><button class="sm" type="button">Open</button>`;
        row.querySelector('button').onclick=async(e)=>{
          e.stopPropagation();
          setMsg(listStatus,'Opening...','');
          try{
            const res=await window.api.openWorkspaceProject(p.name);
            if(res?.ok)setMsg(listStatus,'Opened: '+p.name,'ok');
            else setMsg(listStatus,res?.error||'Failed','err');
          }catch(err){setMsg(listStatus,err.message,'err')}
        };
        listEl.appendChild(row);
      }
    }

    if(ws.root)refreshProjects();
    else listEl.innerHTML='<div class="workspace-empty" style="padding:16px"><p style="margin:0;color:var(--tx2);font-size:13px">Set workspace root first</p></div>';

    refreshLogsInfo();
  }

  // ── Telegram Tab (special) ─────────────────────
  async function renderTelegramTab(container,values){
    const masterConfig=await window.api.loadMasterTelegramConfig();
    container.insertAdjacentHTML('beforeend',`
      <div class="settings-field">
        <div class="settings-row"><span style="flex:1;font-size:13px;color:var(--tx)">Master Bot Enabled</span><button class="settings-toggle${masterConfig.enabled?' on':''}" id="sTgEnabled"></button></div>
      </div>
      <div class="settings-field">
        <label class="settings-label">Bot Token</label>
        <input type="password" class="settings-input" id="sTgToken" placeholder="${masterConfig.hasToken?'(saved — enter new to change)':'Bot token from @BotFather'}" autocomplete="off">
      </div>
      <div class="settings-field">
        <label class="settings-label">Allowed Users (comma-separated)</label>
        <input type="text" class="settings-input" id="sTgAllowed" value="${escHtml((masterConfig.allowedUsers||[]).join(', '))}" autocomplete="off">
      </div>
      <div class="settings-row" style="gap:8px">
        <button class="sm" id="sTgSave">Save Telegram Settings</button>
        <button class="sm" id="sTgTest">Test</button>
        <span class="workspace-msg" id="sTgStatus" style="margin:0"></span>
      </div>
    `);

    function setTgMsg(msg,cls){const el=$('sTgStatus');el.textContent=msg;el.className='workspace-msg '+(cls||'');if(cls==='ok')setTimeout(()=>{el.textContent=''},3000)}

    $('sTgEnabled').onclick=function(){this.classList.toggle('on')};
    $('sTgSave').onclick=async()=>{
      const cfg={
        enabled:$('sTgEnabled').classList.contains('on'),
        allowedUsers:$('sTgAllowed').value.split(',').map(s=>s.trim()).filter(Boolean),
      };
      const tok=$('sTgToken').value.trim();
      if(tok)cfg.botToken=tok;
      const res=await window.api.saveMasterTelegramConfig(cfg);
      if(res.ok){setTgMsg('Saved','ok');$('sTgToken').value='';$('sTgToken').placeholder='(saved — enter new to change)'}
      else setTgMsg(window.operationalStatus.renderOperationalMessage({summary:'Save failed',details:res.error||'unknown error',nextSteps:['retry saving Telegram settings']},'Save failed'),'err');
    };
    $('sTgTest').onclick=async()=>{
      const res=await window.api.loadMasterTelegramConfig();
      if(!res.hasToken){setTgMsg(window.operationalStatus.renderOperationalMessage({summary:'No token saved',nextSteps:['add a bot token in Settings']},'No token saved'),'err');return}
      setTgMsg(window.operationalStatus.renderOperationalMessage({summary:'Telegram bot status',details:(res.enabled?'enabled':'disabled'),nextSteps:[]},'Telegram bot status'),'ok');
    };
  }

})();
