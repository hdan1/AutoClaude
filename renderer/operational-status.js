'use strict';
(function(){
  function renderNextSteps(nextSteps){
    if(!Array.isArray(nextSteps)||nextSteps.length===0)return '';
    return ' Next: '+nextSteps.join(' · ');
  }

  function renderOperationalMessage(payload, fallback){
    if(!payload)return fallback||'';
    const detail = payload.details ? `: ${payload.details}` : '';
    return `${payload.summary || fallback || 'Status'}${detail}${renderNextSteps(payload.nextSteps)}`;
  }

  window.operationalStatus = {
    renderNextSteps,
    renderOperationalMessage,
  };
})();
