// ============================================================
// VERTICORE — app.js
// White-label multi-tenant shell. Every tenant's identity (name,
// logo, colors, terminology, enabled modules) is read live from
// Supabase (tenant_config.config) — nothing brand-specific is
// hardcoded here. This file has zero knowledge of any single
// organization; "Verticore" itself is only the platform name.
// ============================================================
var SUPABASE_URL='https://rpswjeypflnyofldcimz.supabase.co';
var SUPABASE_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwc3dqZXlwZmxueW9mbGRjaW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNDkyOTQsImV4cCI6MjA5ODcyNTI5NH0.jlFwevZn7n-K_SInS6yDcWhCbC77vPUeSF-gfjHc4k4';

var SESSION=null;   // {access_token, refresh_token, expires_at}
var CTX=null;       // result of get_my_context(): {user_id, tenant_id, role, name, vertical, company_name, config}
var previewTimer=null;
var pendingLogoDataUrl=null;
var CURRENT_VIEW='dashboard';
var PEOPLE_CACHE=[];
var ACTIVITIES_CACHE=[];
var FEES_CACHE=[];
var LIBRARY_CACHE=[];
var MARKETING_CACHE=[];

// ------------------------------------------------------------
// Low-level REST helpers
// ------------------------------------------------------------
function authHeaders(withSession){
  var h={'apikey':SUPABASE_ANON,'Content-Type':'application/json'};
  h['Authorization']='Bearer '+((withSession && SESSION && SESSION.access_token) ? SESSION.access_token : SUPABASE_ANON);
  return h;
}
function rpc(name,params,withSession){
  return fetch(SUPABASE_URL+'/rest/v1/rpc/'+name,{
    method:'POST',headers:authHeaders(withSession),body:JSON.stringify(params||{})
  }).then(function(r){
    if(!r.ok)return r.text().then(function(t){throw new Error(t||('Request failed: '+r.status));});
    return r.json();
  });
}
function patchTable(table,filterQs,body,withSession){
  return fetch(SUPABASE_URL+'/rest/v1/'+table+'?'+filterQs,{
    method:'PATCH',headers:Object.assign(authHeaders(withSession),{'Prefer':'return=minimal'}),body:JSON.stringify(body)
  }).then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t||('Update failed: '+r.status));});});
}
function getTable(table,qs,withSession){
  return fetch(SUPABASE_URL+'/rest/v1/'+table+(qs?'?'+qs:''),{headers:authHeaders(withSession)})
    .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t||('Fetch failed: '+r.status));});return r.json();});
}
function postTable(table,body,withSession){
  return fetch(SUPABASE_URL+'/rest/v1/'+table,{
    method:'POST',headers:Object.assign(authHeaders(withSession),{'Prefer':'return=representation'}),body:JSON.stringify(body)
  }).then(function(r){
    return r.text().then(function(t){
      if(!r.ok)throw new Error(t||('Create failed: '+r.status));
      var j=t?JSON.parse(t):[];
      return Array.isArray(j)?j[0]:j;
    });
  });
}
function deleteTable(table,filterQs,withSession){
  return fetch(SUPABASE_URL+'/rest/v1/'+table+'?'+filterQs,{method:'DELETE',headers:authHeaders(withSession)})
    .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t||('Delete failed: '+r.status));});});
}
// ------------------------------------------------------------
// GLOBAL ACTIONS: Undo-aware delete + Duplicate — reused by every
// module (People, Activities, Fees, Library, Marketing) so behavior
// is identical everywhere rather than reinvented per screen.
// ------------------------------------------------------------
function deleteWithUndo(table,record,reloadFn,label){
  deleteTable(table,'id=eq.'+record.id,true).then(function(){
    reloadFn();
    toast((label||'Deleted')+'.',false,'Undo',function(){
      var restore=Object.assign({},record);
      delete restore.id;delete restore.created_at;delete restore.updated_at;
      postTable(table,restore,true).then(function(){toast('✅ Restored');reloadFn();})
        .catch(function(){toast('Could not restore — please re-create it manually.',true);});
    });
  }).catch(function(err){toast(err.message||'Could not delete.',true);});
}
function duplicateRecord(table,record,overrides,reloadFn){
  var copy=Object.assign({},record,overrides||{});
  delete copy.id;delete copy.created_at;delete copy.updated_at;
  postTable(table,copy,true).then(function(){toast('✅ Duplicated');reloadFn();})
    .catch(function(err){toast(err.message||'Could not duplicate.',true);});
}
function gotrue(path,body){
  return fetch(SUPABASE_URL+'/auth/v1/'+path,{
    method:'POST',headers:{'apikey':SUPABASE_ANON,'Content-Type':'application/json'},body:JSON.stringify(body)
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok)throw new Error((j&&(j.error_description||j.msg||j.error))||'Authentication failed');
      return j;
    });
  });
}

// ------------------------------------------------------------
// Toast
// ------------------------------------------------------------
function toast(msg,isErr,actionLabel,actionFn){
  var t=document.getElementById('toast');
  t.innerHTML=escapeHtml(msg)+(actionLabel?' <span class="toast-action" id="toastActionBtn">'+escapeHtml(actionLabel)+'</span>':'');
  t.className='toast show'+(isErr?' err':'');
  if(actionLabel&&actionFn){
    document.getElementById('toastActionBtn').onclick=function(){t.className='toast';actionFn();};
  }
  clearTimeout(window._toastTimer);
  window._toastTimer=setTimeout(function(){t.className='toast';},actionLabel?6000:2800);
}
function showMsg(elId,msg,isErr){
  var el=document.getElementById(elId);
  el.textContent=msg;
  el.className='msg '+(isErr?'err':'ok');
}
function clearMsg(elId){
  var el=document.getElementById(elId);
  el.className='msg';el.textContent='';
}

// ------------------------------------------------------------
// Branding application — the actual white-label mechanism.
// Called (a) live while typing an org code on the sign-in screen,
// and (b) once, for real, right after successful login.
// ------------------------------------------------------------
function applyBranding(target,cfg,orgName,vertical){
  // target: 'auth' or 'app'
  var brand=(cfg&&cfg.brand)||{};
  var app=(cfg&&cfg.app)||{};
  var accent=brand.accentColor||'#2563eb';
  var secondary=brand.secondaryColor||'#7c3aed';
  document.documentElement.style.setProperty('--accent',accent);
  document.documentElement.style.setProperty('--accent-2',secondary);

  var name=orgName||app.appName||'Verticore';
  var initial=(name||'V').trim().charAt(0).toUpperCase();

  if(target==='auth'){
    document.getElementById('authOrgName').textContent=name;
    document.getElementById('authOrgSub').textContent=vertical?humanizeVertical(vertical):'Sign in to your workspace';
    var logo=document.getElementById('authLogo'),ph=document.getElementById('authLogoPh');
    setLogoOrInitial(logo,ph,brand.logoUrl,initial,accent);
  }else{
    document.getElementById('appOrgName').textContent=name;
    var mobileOrgEl=document.getElementById('mobileOrgName');
    if(mobileOrgEl)mobileOrgEl.textContent=name;
    document.getElementById('appVertical').textContent=vertical?humanizeVertical(vertical):'';
    var logo2=document.getElementById('appLogo'),ph2=document.getElementById('appLogoPh');
    setLogoOrInitial(logo2,ph2,brand.logoUrl,initial,accent);
  }
}
function setLogoOrInitial(imgEl,phEl,logoUrl,initial,accent){
  if(logoUrl){
    imgEl.src=logoUrl;imgEl.style.display='inline-block';phEl.style.display='none';
  }else{
    imgEl.style.display='none';phEl.style.display='flex';phEl.textContent=initial;phEl.style.background=accent;
  }
}
function humanizeVertical(v){
  return ({medical:'Medical College / Hospital',school:'School / Campus',education_consultancy:'Education Consultancy',generic_enterprise:'Enterprise'})[v]||v;
}

// ------------------------------------------------------------
// Live tenant preview while typing an org code (sign-in screen)
// ------------------------------------------------------------
function previewTenant(inputId,previewId){
  var slug=document.getElementById(inputId).value.trim().toLowerCase();
  var box=document.getElementById(previewId);
  clearTimeout(previewTimer);
  if(!slug){
    box.innerHTML='<span class="tp-text">Type your organization\'s code to preview its branding</span>';
    applyBranding('auth',{brand:{}},null,null);
    return;
  }
  previewTimer=setTimeout(function(){
    rpc('get_tenant_public_config',{p_slug:slug},false).then(function(rows){
      var cfg=Array.isArray(rows)?rows[0]:rows;
      if(!cfg){
        box.innerHTML='<span class="tp-text">No organization found with this code</span>';
        return;
      }
      var brand=cfg.brand||{};
      var logoHtml=brand.logoUrl?'<img class="tp-logo" src="'+brand.logoUrl+'">':'<div class="tp-logo" style="background:'+(brand.accentColor||'#2563eb')+'"></div>';
      box.innerHTML=logoHtml+'<div><div class="tp-name">'+(cfg.company_name||slug)+'</div><div class="tp-text">'+humanizeVertical(cfg.vertical)+'</div></div>';
      applyBranding('auth',cfg,cfg.company_name,cfg.vertical);
    }).catch(function(){
      box.innerHTML='<span class="tp-text">No organization found with this code</span>';
    });
  },380);
}

// ------------------------------------------------------------
// Auth screen tabs
// ------------------------------------------------------------
// ------------------------------------------------------------
// Sign in with Google (Supabase OAuth provider — requires Google
// enabled in Supabase Auth settings with a Client ID + Secret).
// Uses the standard OAuth redirect flow: browser goes to Google,
// comes back to Supabase's callback, which redirects here with the
// session in the URL fragment (#access_token=...&refresh_token=...).
// ------------------------------------------------------------
function signInWithGoogle(){
  var redirectTo=encodeURIComponent(window.location.origin+window.location.pathname);
  window.location.href=SUPABASE_URL+'/auth/v1/authorize?provider=google&redirect_to='+redirectTo;
}
function handleOAuthRedirect(){
  if(!window.location.hash||window.location.hash.indexOf('access_token')<0)return false;
  var params=new URLSearchParams(window.location.hash.substring(1));
  var accessToken=params.get('access_token');
  var refreshToken=params.get('refresh_token');
  var expiresIn=params.get('expires_in');
  if(!accessToken)return false;
  SESSION={access_token:accessToken,refresh_token:refreshToken,expires_at:Date.now()+((parseFloat(expiresIn)||3600)*1000)};
  localStorage.setItem('vc_session',JSON.stringify(SESSION));
  history.replaceState(null,'',window.location.pathname);
  loadMyContextAndEnter().catch(function(){
    // Signed in with Google for the first time, but no organization
    // linked to this account yet — send them to create one, with
    // their Google name/email prefilled where we can get it.
    fetch(SUPABASE_URL+'/auth/v1/user',{headers:authHeaders(true)}).then(function(r){return r.json();}).then(function(u){
      setAuthTab('signup');
      if(u.email)document.getElementById('suEmail').value=u.email;
      if(u.user_metadata&&u.user_metadata.full_name)document.getElementById('suName').value=u.user_metadata.full_name;
      var pwFld=document.getElementById('suPassword').closest('.fld');
      if(pwFld)pwFld.style.display='none';
      showMsg('authMsg','Signed in with Google — now set up your organization to continue.',false);
    }).catch(function(){
      setAuthTab('signup');
      var pwFld=document.getElementById('suPassword').closest('.fld');
      if(pwFld)pwFld.style.display='none';
      showMsg('authMsg','Signed in with Google — now set up your organization to continue.',false);
    });
  });
  return true;
}
function setAuthTab(tab){
  document.getElementById('tabSignin').classList.toggle('active',tab==='signin');
  document.getElementById('tabSignup').classList.toggle('active',tab==='signup');
  document.getElementById('paneSignin').style.display=tab==='signin'?'block':'none';
  document.getElementById('paneSignup').style.display=tab==='signup'?'block':'none';
  clearMsg('authMsg');
}
function sanitizeSlug(){
  var el=document.getElementById('suSlug');
  var v=el.value.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
  el.value=v;
}

// ------------------------------------------------------------
// Sign in
// ------------------------------------------------------------
function doSignIn(){
  var email=document.getElementById('siEmail').value.trim();
  var password=document.getElementById('siPassword').value;
  if(!email||!password){showMsg('authMsg','Enter your email and password.',true);return;}
  var btn=document.getElementById('siBtn');
  btn.disabled=true;btn.textContent='Signing in…';
  gotrue('token?grant_type=password',{email:email,password:password}).then(function(tok){
    SESSION={access_token:tok.access_token,refresh_token:tok.refresh_token,expires_at:Date.now()+((tok.expires_in||3600)*1000)};
    localStorage.setItem('vc_session',JSON.stringify(SESSION));
    return finishPendingTenantIfAny().then(function(){
      return loadMyContextAndEnter().then(function(){
        applyPendingSignupLogo();
      });
    });
  }).catch(function(err){
    showMsg('authMsg',err.message||'Sign-in failed. Check your email/password.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Sign in';
  });
}

// ------------------------------------------------------------
// Sign up (self-service tenant creation)
// ------------------------------------------------------------
// create_tenant no longer accepts a caller-supplied owner id — it
// derives the owner strictly from the caller's own session
// (auth.uid()), so this flow only works with a real, authenticated
// access_token, never the anon key alone. Two real-world paths:
//   (a) Supabase project has email confirmation OFF -> signup()
//       returns a session immediately -> we can call create_tenant
//       right away, in the same flow.
//   (b) Email confirmation is ON -> no session yet. We save the
//       org details locally and finish provisioning on their first
//       successful sign-in (finishPendingTenantIfAny below).
function collectOrgFormFields(){
  return {
    p_slug:document.getElementById('suSlug').value.trim(),
    p_company_name:document.getElementById('suCompany').value.trim(),
    p_vertical:document.getElementById('suVertical').value,
    p_owner_name:document.getElementById('suName').value.trim(),
    p_owner_email:document.getElementById('suEmail').value.trim()
  };
}
var SIGNUP_LOGO_DATA_URL=null;
function handleSignupLogo(e){
  var f=e.target.files[0];
  if(!f)return;
  compressImage(f,300,0.85).then(function(dataUrl){
    SIGNUP_LOGO_DATA_URL=dataUrl;
    var prev=document.getElementById('suLogoPreview');
    prev.src=dataUrl;prev.style.display='inline-block';
  }).catch(function(){toast('Could not process that image',true);});
}
function applyPendingSignupLogo(){
  var logo=SIGNUP_LOGO_DATA_URL||localStorage.getItem('vc_pending_logo');
  if(!logo || !CTX)return;
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.brand=cfg.brand||{};
  cfg.brand.logoUrl=logo;
  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    SIGNUP_LOGO_DATA_URL=null;
    localStorage.removeItem('vc_pending_logo');
    applyBranding('app',cfg,CTX.company_name,CTX.vertical);
    renderModuleGrid();
    populateBrandingForm();
  }).catch(function(){/* non-fatal — they can still add the logo later from Settings */});
}
function doSignUp(){
  var fields=collectOrgFormFields();
  var password=document.getElementById('suPassword').value;
  var hasOrgDetails=fields.p_company_name && fields.p_slug;
  if(!fields.p_owner_name||!fields.p_owner_email){showMsg('authMsg','Name and email are required.',true);return;}

  var btn=document.getElementById('suBtn');
  btn.disabled=true;btn.textContent='Setting up your account…';

  function afterAuthed(){
    // Try joining an existing org first (in case an admin invited this
    // email) — only create a brand-new tenant if that doesn't apply.
    return loadMyContextAndEnter().then(function(){
      applyPendingSignupLogo();
    }).catch(function(){
      if(!hasOrgDetails){
        throw new Error('No invite found for this email. Ask your admin to invite you, or fill in Organization name + code to create a new one.');
      }
      return rpc('create_tenant',fields,true).then(function(){
        return loadMyContextAndEnter().then(function(){applyPendingSignupLogo();});
      });
    });
  }

  // Already authenticated (e.g. just signed in with Google).
  if(SESSION && SESSION.access_token){
    afterAuthed().catch(function(err){
      showMsg('authMsg',err.message||'Could not set up your account.',true);
    }).finally(function(){
      btn.disabled=false;btn.textContent='Create organization & continue';
    });
    return;
  }

  if(password.length<6){showMsg('authMsg','Password must be at least 6 characters.',true);btn.disabled=false;btn.textContent='Create organization & continue';return;}

  gotrue('signup',{email:fields.p_owner_email,password:password}).then(function(signupResp){
    if(signupResp.session && signupResp.session.access_token){
      SESSION={access_token:signupResp.session.access_token,refresh_token:signupResp.session.refresh_token,expires_at:Date.now()+((signupResp.session.expires_in||3600)*1000)};
      localStorage.setItem('vc_session',JSON.stringify(SESSION));
      return afterAuthed();
    }else{
      // No session yet (email confirmation required). Save the org
      // details (if any) so we can finish provisioning right after
      // they confirm and sign in for the first time. Invited
      // employees can leave these blank — claim_pending_invite()
      // handles their case with no extra data needed.
      if(hasOrgDetails){
        localStorage.setItem('vc_pending_org',JSON.stringify(fields));
        if(SIGNUP_LOGO_DATA_URL)localStorage.setItem('vc_pending_logo',SIGNUP_LOGO_DATA_URL);
      }
      showMsg('authMsg','Check your email to confirm your account, then sign in to finish setup.',false);
      setAuthTab('signin');
      if(fields.p_slug){
        document.getElementById('siSlug').value=fields.p_slug;
        previewTenant('siSlug','siPreview');
      }
    }
  }).catch(function(err){
    showMsg('authMsg',err.message||'Could not create your account.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Create organization & continue';
  });
}
// Called right after a successful sign-in. If this account signed
// up before email confirmation completed, its tenant was never
// created — finish that now that we have a real session.
function finishPendingTenantIfAny(){
  var raw=localStorage.getItem('vc_pending_org');
  if(!raw)return Promise.resolve(false);
  var fields;
  try{fields=JSON.parse(raw);}catch(e){localStorage.removeItem('vc_pending_org');return Promise.resolve(false);}
  return rpc('create_tenant',fields,true).then(function(){
    localStorage.removeItem('vc_pending_org');
    return true;
  }).catch(function(){
    // Most likely this account already has a tenant (e.g. they
    // finished setup in another tab) — don't block sign-in over it.
    localStorage.removeItem('vc_pending_org');
    return false;
  });
}

// ------------------------------------------------------------
// Context load + enter app
// ------------------------------------------------------------
function loadMyContextAndEnter(){
  return rpc('claim_pending_invite',{},true).catch(function(){return null;}).then(function(){
    return rpc('get_my_context',{},true);
  }).then(function(rows){
    var ctx=Array.isArray(rows)?rows[0]:rows;
    if(!ctx || !ctx.tenant_id)throw new Error('No workspace is linked to this account yet.');
    CTX=ctx;
    enterApp();
    startSessionRefreshTimer();
  });
}
function enterApp(){
  document.getElementById('authScreen').style.display='none';
  document.getElementById('appShell').classList.add('show');
  applyBranding('app',CTX.config,CTX.company_name,CTX.vertical);
  document.getElementById('appRole').textContent=CTX.role;
  document.getElementById('appUserName').textContent=CTX.name||'';
  var navAdmin=document.getElementById('navAdminPanel');
  if(navAdmin)navAdmin.style.display=(CTX.role==='owner'||CTX.role==='admin')?'flex':'none';
  loadActiveNoticeBanner();
  var h=new Date().getHours();
  document.getElementById('dashGreeting').textContent=(h<12?'Good morning':h<17?'Good afternoon':'Good evening')+', '+(CTX.name?CTX.name.split(' ')[0]:'');
  document.getElementById('dashSub').textContent=CTX.company_name+' · '+humanizeVertical(CTX.vertical);
  var term=(CTX.config&&CTX.config.terminology)||{};
  document.getElementById('navPeople').textContent=term.entity_person_plural||'People';
  document.getElementById('navActivities').textContent=term.entity_activity_plural||'Activities';
  document.getElementById('peopleTitle').textContent=term.entity_person_plural||'People';
  document.getElementById('peopleSub').textContent='Every '+(term.entity_person||'person')+' your organization tracks.';
  document.getElementById('peopleAddBtn').textContent='+ Add '+(term.entity_person||'Person');
  document.getElementById('activitiesTitle').textContent=term.entity_activity_plural||'Activities';
  document.getElementById('pNameLabel').textContent=(term.entity_person||'Person')+' name';
  document.getElementById('aPersonLabel').textContent=term.entity_person||'Person';
  populateBrandingForm();
  populateMarksheetTemplateForm();
  populateFeeReceiptTemplateForm();
  populateCommitmentLetterTemplateForm();
  populateGeminiKeyForm();
  switchView('dashboard');
}
// ------------------------------------------------------------
// Dashboard: stats, quick actions, AI suggestions
// ------------------------------------------------------------
function loadDashboard(){
  renderModuleGrid();
  renderQuickActions();
  renderDashboardStats();
  loadAiSuggestions(false);
}
function renderDashboardStats(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var el=document.getElementById('dashStats');
  el.innerHTML='<div class="glass-stat"><div class="gs-value">…</div><div class="gs-label">Loading</div></div>';
  Promise.all([
    getTable('people','select=id,status,custom_fields',true).catch(function(){return [];}),
    getTable('activities','select=id,stage',true).catch(function(){return [];})
  ]).then(function(res){
    var people=res[0]||[],activities=res[1]||[];
    PEOPLE_CACHE=people.length?people:PEOPLE_CACHE;
    var activeCount=people.filter(function(p){return p.status==='active';}).length;
    var withResult=people.map(function(p){return computeResult(p.custom_fields);}).filter(Boolean);
    var avgPct=withResult.length?Math.round(withResult.reduce(function(s,r){return s+r.pct;},0)/withResult.length):null;
    var openActivities=activities.length;
    var stats=[
      {value:people.length,label:'Total '+(term.entity_person_plural||'People')},
      {value:activeCount,label:'Active'},
      {value:openActivities,label:term.entity_activity_plural||'Activities'},
      {value:(avgPct!=null?avgPct+'%':'—'),label:'Avg Result'}
    ];
    el.innerHTML=stats.map(function(s,i){
      return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
    }).join('');
  });
}
function renderQuickActions(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var isAdmin=CTX.role==='owner'||CTX.role==='admin';
  var actions=[
    {icon:'➕',label:'Add '+(term.entity_person||'Person'),fn:"switchView('people');setTimeout(function(){openPersonModal();},150)"},
    {icon:'📋',label:'Add '+(term.entity_activity||'Activity'),fn:"switchView('activities');setTimeout(function(){openActivityModal();},150)"},
    {icon:'🔎',label:'Search Results',fn:"switchView('results')"},
    {icon:'⬆️',label:'Upload Excel',fn:"switchView('results');setTimeout(function(){openExcelUploadModal();},150)"},
    {icon:'✨',label:'Ask AI',fn:"openAiPanel('')"}
  ];
  if(isAdmin)actions.push({icon:'⚙️',label:'Branding & Settings',fn:"showSettings()"});
  var el=document.getElementById('quickActions');
  el.innerHTML=actions.map(function(a,i){
    return '<div class="qa-btn" style="animation-delay:'+(i*0.04).toFixed(2)+'s" onclick="'+a.fn+'"><span class="qa-icon">'+a.icon+'</span>'+a.label+'</div>';
  }).join('');
}
function loadAiSuggestions(forceRefresh){
  var body=document.getElementById('aiSuggestBody');
  var integ=(CTX.config&&CTX.config.integrations)||{};
  if(!integ.geminiApiKey){
    body.innerHTML='Set up your Gemini API key in Settings to get AI-generated suggestions here.';
    return;
  }
  body.innerHTML='<div class="empty-hint">Thinking…</div>';
  var term=(CTX.config&&CTX.config.terminology)||{};
  var withResult=PEOPLE_CACHE.map(function(p){return computeResult(p.custom_fields);}).filter(Boolean);
  var failCount=withResult.filter(function(r){return !r.pass;}).length;
  var stageCounts={};
  ACTIVITIES_CACHE.forEach(function(a){stageCounts[a.stage]=(stageCounts[a.stage]||0)+1;});
  var snapshot='Organization: '+CTX.company_name+' ('+humanizeVertical(CTX.vertical)+')\n'
    +'Total '+(term.entity_person_plural||'people')+': '+PEOPLE_CACHE.length+'\n'
    +(withResult.length?('Students failing: '+failCount+' of '+withResult.length+'\n'):'')
    +(Object.keys(stageCounts).length?('Activity pipeline: '+Object.keys(stageCounts).map(function(k){return k+'='+stageCounts[k];}).join(', ')):'');
  var prompt='You are an assistant embedded in a '+(term.org_label||'organization')+' management dashboard. '
    +'Based on this snapshot, give exactly 3 short, specific, actionable suggestions (one line each, no numbering symbols other than a dash):\n\n'+snapshot;
  callGeminiAssist(prompt).then(function(text){
    var lines=text.split('\n').map(function(l){return l.replace(/^[-•*\s]+/,'').trim();}).filter(Boolean).slice(0,4);
    body.innerHTML=lines.map(function(l){return '<div class="ai-suggest-body-item">💡 '+escapeHtml(l)+'</div>';}).join('')||escapeHtml(text);
  }).catch(function(err){
    body.innerHTML='<span style="color:var(--ink-3);">'+escapeHtml(err.message||'Suggestions unavailable right now.')+'</span>';
  });
}

function renderModuleGrid(){
  var cfg=CTX.config||{};
  var modules=cfg.modules||{};
  var term=cfg.terminology||{};
  var ICONS={people:'👤',activities:'📋',transactions:'💳',schedule:'🗓️',reports:'📊',notices:'📢',aiAssistant:'✨'};
  var LABELS={people:term.entity_person_plural,activities:term.entity_activity_plural,transactions:'Fees',
    schedule:(term.entity_schedule_subject_plural?term.entity_schedule_subject_plural+' Schedule':'Schedule'),reports:'Reports',notices:'Notices',aiAssistant:'AI Assistant'};
  var LIVE={people:true,activities:true,results:true,transactions:true}; // modules with a real, working view so far
  var VIEW_MAP={transactions:'fees'}; // module key -> actual view id, where they differ
  var grid=document.getElementById('moduleGrid');
  var i=0;
  grid.innerHTML=Object.keys(modules).filter(function(k){return modules[k];}).map(function(k){
    var isLive=!!LIVE[k];
    var targetView=VIEW_MAP[k]||k;
    var delay=(i++ * 0.05).toFixed(2);
    return '<div class="module-card glass-module" style="cursor:'+(isLive?'pointer':'default')+';animation-delay:'+delay+'s" '+(isLive?'onclick="switchView(\''+targetView+'\')"':'')+'>'
      +'<div class="rail-card-body">'
      +'<div class="m-icon">'+(ICONS[k]||'▫️')+'</div>'
      +'<div class="m-name">'+(LABELS[k]||k)+'</div>'
      +'<div class="m-status">'+(isLive?'Open →':'Scaffolded — built next')+'</div>'
      +'</div></div>';
  }).join('');
}

// ------------------------------------------------------------
// View switching
// ------------------------------------------------------------
function switchView(view){
  CURRENT_VIEW=view;
  ['dashboard','visitors','people','activities','results','attendance','fees','expenses','hostel','studentcare','library','marketing','coldcalling','coordinator','reportbuilder','adminpanel','settings'].forEach(function(v){
    var el=document.getElementById('view'+capitalize(v));
    if(el)el.style.display=(v===view)?'block':'none';
  });
  document.querySelectorAll('.sidebar-item').forEach(function(el){
    el.classList.toggle('active',el.getAttribute('data-view')===view);
  });
  document.querySelectorAll('.bpn-item[data-view]').forEach(function(el){
    el.classList.toggle('active',el.getAttribute('data-view')===view);
  });
  closeSidebarOnMobile();
  if(view==='people')loadPeople();
  if(view==='activities')loadActivities();
  if(view==='results')loadResults();
  if(view==='attendance')initAttendanceView();
  if(view==='hostel')initHostelView();
  if(view==='studentcare')initCareView();
  if(view==='fees')loadFees();
  if(view==='expenses')loadExpenses();
  if(view==='library')loadLibrary();
  if(view==='marketing')loadMarketing();
  if(view==='coldcalling')initColdCallingView();
  if(view==='coordinator')loadCoordinatorShifts();
  if(view==='adminpanel')initAdminPanel();
  if(view==='reportbuilder')initReportBuilder();
  if(view==='dashboard')loadDashboard();
  if(view==='visitors')initVisitorsView();
}
function capitalize(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('show');
  document.getElementById('sidebarScrim').classList.toggle('show');
}
function closeSidebarOnMobile(){
  document.getElementById('sidebar').classList.remove('show');
  document.getElementById('sidebarScrim').classList.remove('show');
}
function openModal(id){document.getElementById(id).classList.add('show');}
function closeModal(id){document.getElementById(id).classList.remove('show');}
function showDashboard(){switchView('dashboard');}
function showSettings(){switchView('settings');}

// ------------------------------------------------------------
// Branding settings (admin/owner only — enforced server-side by RLS;
// the UI simply won't be useful to lower roles since the PATCH will
// be rejected, but we don't hide it client-side-only as a security
// boundary — RLS is the real boundary here)
// ------------------------------------------------------------
function populateBrandingForm(){
  var cfg=CTX.config||{};
  var brand=cfg.brand||{};
  var app=cfg.app||{};
  document.getElementById('bAppName').value=app.appName||CTX.company_name||'';
  document.getElementById('bAccent').value=brand.accentColor||'#2563eb';
  document.getElementById('bSecondary').value=brand.secondaryColor||'#7c3aed';
  var prev=document.getElementById('bLogoPreview');
  if(brand.logoUrl){prev.src=brand.logoUrl;prev.style.display='inline-block';}else{prev.style.display='none';}
  pendingLogoDataUrl=null;
}
function handleLogoFile(e){
  var f=e.target.files[0];
  if(!f)return;
  var reader=new FileReader();
  reader.onload=function(){
    var img=new Image();
    img.onload=function(){
      var maxDim=300;
      var scale=Math.min(1,maxDim/Math.max(img.width,img.height));
      var canvas=document.createElement('canvas');
      canvas.width=img.width*scale;canvas.height=img.height*scale;
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      pendingLogoDataUrl=canvas.toDataURL('image/png',0.9);
      var prev=document.getElementById('bLogoPreview');
      prev.src=pendingLogoDataUrl;prev.style.display='inline-block';
    };
    img.src=reader.result;
  };
  reader.readAsDataURL(f);
}
function saveBranding(){
  var btn=document.getElementById('bSaveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.app=cfg.app||{};
  cfg.brand=cfg.brand||{};
  cfg.app.appName=document.getElementById('bAppName').value.trim()||cfg.app.appName;
  cfg.brand.accentColor=document.getElementById('bAccent').value;
  cfg.brand.secondaryColor=document.getElementById('bSecondary').value;
  if(pendingLogoDataUrl)cfg.brand.logoUrl=pendingLogoDataUrl;

  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    CTX.company_name=cfg.app.appName;
    applyBranding('app',cfg,cfg.app.appName,CTX.vertical);
    renderModuleGrid();
    showMsg('brandMsg','Branding updated — everyone in your organization sees this immediately.',false);
    toast('✅ Branding saved');
  }).catch(function(err){
    showMsg('brandMsg',(err.message||'Could not save — you may need admin access to change branding.'),true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Save branding';
  });
}

// ------------------------------------------------------------
// MARKSHEET TEMPLATE (per-tenant, stored in tenant_config.config.reportTemplates.marksheet)
// ------------------------------------------------------------
function getMarksheetTemplate(){
  var rt=(CTX.config&&CTX.config.reportTemplates)||{};
  var ms=rt.marksheet||{};
  return {
    headerText:ms.headerText||CTX.company_name||'',
    titleText:ms.titleText||'STATEMENT OF MARKS',
    footerText:ms.footerText||'This is a system-generated statement of marks.',
    font:ms.font||"'Inter',sans-serif",
    color:ms.color||(CTX.config&&CTX.config.brand&&CTX.config.brand.accentColor)||'#2563eb',
    watermark:ms.watermark||''
  };
}
function populateMarksheetTemplateForm(){
  var t=getMarksheetTemplate();
  document.getElementById('msHeaderText').value=t.headerText;
  document.getElementById('msTitleText').value=t.titleText;
  document.getElementById('msFooterText').value=t.footerText;
  document.getElementById('msFont').value=t.font;
  document.getElementById('msColor').value=t.color;
  document.getElementById('msWatermark').value=t.watermark;
}
// ------------------------------------------------------------
// GLOBAL GEMINI ASSISTANT
// ------------------------------------------------------------
// The API key itself never touches this file or the browser network
// tab in plaintext-to-Gemini form — callGeminiAssist() calls OUR OWN
// edge function (with the user's session token), which resolves the
// tenant's key server-side and proxies the request. See:
// supabase/functions/gemini-assist
function callGeminiAssist(prompt,imageBase64,mimeType){
  var payload={prompt:prompt};
  if(imageBase64){payload.imageBase64=imageBase64;payload.mimeType=mimeType||'image/jpeg';}
  return fetch(SUPABASE_URL+'/functions/v1/gemini-assist',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+(SESSION&&SESSION.access_token||'')},
    body:JSON.stringify(payload)
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok)throw new Error(j.error||'AI request failed.');
      return j.text||'';
    });
  });
}
function populateGeminiKeyForm(){
  var integ=(CTX.config&&CTX.config.integrations)||{};
  document.getElementById('aiApiKey').value=integ.geminiApiKey?'••••••••••••••••':'';
}
function saveGeminiKey(){
  var btn=document.getElementById('aiKeySaveBtn');
  var val=document.getElementById('aiApiKey').value.trim();
  if(!val||val.indexOf('•')>-1){showMsg('aiKeyMsg','Paste a real Gemini API key to save.',true);return;}
  btn.disabled=true;btn.textContent='Saving…';
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.integrations=cfg.integrations||{};
  cfg.integrations.geminiApiKey=val;
  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    populateGeminiKeyForm();
    showMsg('aiKeyMsg','✅ Saved — everyone signed in to your organization can now use the AI Assistant.',false);
    toast('✅ Gemini key saved');
  }).catch(function(err){
    showMsg('aiKeyMsg',err.message||'Could not save — you may need admin access.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Save key';
  });
}

// ---- Floating panel ----
var AI_MODE='summarize';
var AI_PREFIX={
  summarize:'Summarize the following text clearly and concisely:\n\n',
  report:'Using the following data, write a concise, professional report a manager could read in under a minute. Use short headings and bullet points where useful. Point out any notable patterns, risks, or numbers worth flagging:\n\n',
  rewrite:'Rewrite the following text in a clear, professional tone, keeping the same meaning:\n\n',
  improve:'Improve the grammar, clarity and structure of the following text without changing its meaning:\n\n',
  translate:'Translate the following text to {LANG}:\n\n',
  analyze:'Analyze the following text and pull out the key points, risks, and any numbers that stand out:\n\n',
  suggest:'Based on the following text, suggest 3-5 concrete, practical next steps:\n\n'
};
function openAiPanel(prefillText){
  document.getElementById('aiPanel').classList.add('show');
  if(prefillText)document.getElementById('aiInput').value=prefillText;
  document.getElementById('aiOutputWrap').style.display='none';
  clearMsg('aiMsg');
}
function closeAiPanel(){document.getElementById('aiPanel').classList.remove('show');}
function setAiMode(mode){
  AI_MODE=mode;
  document.querySelectorAll('.ai-mode-btn').forEach(function(el){el.classList.toggle('active',el.getAttribute('data-mode')===mode);});
  document.getElementById('aiTranslateLangWrap').style.display=(mode==='translate')?'block':'none';
}
function runAiAssist(){
  var text=document.getElementById('aiInput').value.trim();
  if(!text){showMsg('aiMsg','Type or paste some text first.',true);return;}
  var prefix=AI_PREFIX[AI_MODE]||'';
  if(AI_MODE==='translate'){
    var lang=document.getElementById('aiTranslateLang').value.trim()||'Hindi';
    prefix=prefix.replace('{LANG}',lang);
  }
  var btn=document.getElementById('aiRunBtn');
  btn.disabled=true;btn.textContent='Thinking…';
  clearMsg('aiMsg');
  callGeminiAssist(prefix+text).then(function(resultText){
    document.getElementById('aiOutput').textContent=resultText;
    document.getElementById('aiOutputWrap').style.display='block';
  }).catch(function(err){
    showMsg('aiMsg',err.message||'AI Assistant is unavailable right now.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Run';
  });
}
function copyAiOutput(){
  var text=document.getElementById('aiOutput').textContent;
  navigator.clipboard.writeText(text).then(function(){toast('✅ Copied');});
}

// ------------------------------------------------------------
// Per-section "Generate Report" — every module gets a one-click,
// context-aware report built from whatever is currently on screen.
// ------------------------------------------------------------
function generateSectionReport(section){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var text='';
  if(section==='people'){
    var byStatus={};
    PEOPLE_CACHE.forEach(function(p){byStatus[p.status||'active']=(byStatus[p.status||'active']||0)+1;});
    text=(term.entity_person_plural||'People')+' overview for '+CTX.company_name+'\n'
      +'Total: '+PEOPLE_CACHE.length+'\n'
      +Object.keys(byStatus).map(function(s){return capitalize(s)+': '+byStatus[s];}).join('\n');
  }else if(section==='activities'){
    var byStage={};
    getStages().forEach(function(s){byStage[s]=0;});
    ACTIVITIES_CACHE.forEach(function(a){byStage[a.stage]=(byStage[a.stage]||0)+1;});
    text=(term.entity_activity_plural||'Activities')+' pipeline for '+CTX.company_name+'\n'
      +Object.keys(byStage).map(function(s){return s+': '+byStage[s];}).join('\n');
  }else if(section==='results'){
    var rows=getFilteredResultsPeople();
    var withResult=rows.map(function(p){return computeResult(p.custom_fields);}).filter(Boolean);
    var pass=withResult.filter(function(r){return r.pass;}).length;
    var avg=withResult.length?Math.round(withResult.reduce(function(s,r){return s+r.pct;},0)/withResult.length):0;
    text='Results overview for '+CTX.company_name+' (current filters)\n'
      +'Students with recorded marks: '+withResult.length+' of '+rows.length+'\n'
      +'Pass: '+pass+' · Fail: '+(withResult.length-pass)+'\n'
      +'Average percentage: '+avg+'%';
  }else if(section==='fees'){
    var feeRows=getFilteredFees().map(computeFeeStatus);
    var collected=feeRows.reduce(function(s,r){return s+r.paid;},0);
    var pending=feeRows.reduce(function(s,r){return s+r.pending;},0);
    var overdueCount=feeRows.filter(function(r){return r.status==='overdue';}).length;
    text='Fees overview for '+CTX.company_name+' (current filters)\n'
      +'Fee records: '+feeRows.length+'\n'
      +'Collected: '+collected.toLocaleString()+' · Pending: '+pending.toLocaleString()+'\n'
      +'Overdue accounts: '+overdueCount;
  }else if(section==='expenses'){
    var expRows=getFilteredExpenses();
    var byCur={};
    expRows.forEach(function(e){var cf=e.custom_fields||{};byCur[e.currency||'NPR']=(byCur[e.currency||'NPR']||0)+(parseFloat(e.amount)||0);});
    text='Expenses overview for '+CTX.company_name+' (current filters)\n'
      +'Total entries: '+expRows.length+'\n'
      +Object.keys(byCur).map(function(c){return c+': '+byCur[c].toLocaleString();}).join(', ');
  }else if(section==='coldcalling'){
    var byOutcome={};
    CC_CALL_LOGS.forEach(function(l){var o=(l.custom_fields||{}).outcome||'—';byOutcome[o]=(byOutcome[o]||0)+1;});
    text='Cold Calling overview for '+CTX.company_name+'\n'
      +'Total contacts: '+CC_CONTACTS.length+'\n'
      +'Calls logged: '+CC_CALL_LOGS.length+'\n'
      +Object.keys(byOutcome).map(function(o){return o+': '+byOutcome[o];}).join(', ');
  }else if(section==='coordinator'){
    text='Coordinator Shifts overview for '+CTX.company_name+'\n'
      +'Total shift entries: '+COORD_SHIFTS.length;
  }else if(section==='visitors'){
    var byStatus={};
    VISITORS_CACHE.forEach(function(v){var s=(v.custom_fields||{}).status||'New';byStatus[s]=(byStatus[s]||0)+1;});
    text='Visitors overview for '+CTX.company_name+'\n'
      +'Total visits: '+VISITORS_CACHE.length+'\n'
      +Object.keys(byStatus).map(function(s){return s+': '+byStatus[s];}).join(', ');
  }else if(section==='library'){
    var libRows=getFilteredLibrary();
    var withOut=libRows.filter(function(l){return l.custom_fields&&l.custom_fields.outTime;});
    text='Library overview for '+CTX.company_name+' (current filters)\n'
      +'Total entries: '+libRows.length+'\n'
      +'Checked out: '+withOut.length+' · Still in: '+(libRows.length-withOut.length);
  }else if(section==='marketing'){
    var mktRows=getFilteredMarketing();
    var totalReach=mktRows.reduce(function(s,m){return s+(parseFloat(m.custom_fields&&m.custom_fields.reach)||0);},0);
    var totalDownloads=mktRows.reduce(function(s,m){return s+(parseFloat(m.custom_fields&&m.custom_fields.downloads)||0);},0);
    var campaigns={};
    mktRows.forEach(function(m){var c=(m.custom_fields&&m.custom_fields.campaign)||'Uncategorized';campaigns[c]=true;});
    text='Marketing overview for '+CTX.company_name+' (current filters)\n'
      +'Total assets: '+mktRows.length+'\n'
      +'Total reach: '+totalReach.toLocaleString()+' · Total downloads/shares: '+totalDownloads.toLocaleString()+'\n'
      +'Active campaigns: '+Object.keys(campaigns).length;
  }else if(section==='attendance'){
    var attRows=ATTENDANCE_CACHE||[];
    var present=attRows.filter(function(a){return (a.custom_fields||{}).status==='present';}).length;
    text='Attendance overview for '+CTX.company_name+'\n'
      +'Records loaded: '+attRows.length+'\n'
      +'Present: '+present+' of '+attRows.length;
  }else if(section==='hostel'){
    text='Hostel overview for '+CTX.company_name+'\n'
      +'Room assignments: '+HOSTEL_ROOMS.length+'\n'
      +'Open room issues: '+HOSTEL_ISSUES.length+'\n'
      +'Mess issues: '+HOSTEL_MESS.length+'\n'
      +'Active leave/pass records: '+HOSTEL_LEAVE.length;
  }else if(section==='studentcare'){
    var openDisputes=CARE_DISPUTES.filter(function(r){return (r.custom_fields||{}).status!=='resolved';}).length;
    var openComplaints=CARE_COMPLAINTS.filter(function(r){return (r.custom_fields||{}).status!=='resolved';}).length;
    text='Student Care overview for '+CTX.company_name+'\n'
      +'Disputes: '+CARE_DISPUTES.length+' ('+openDisputes+' open)\n'
      +'Complaints: '+CARE_COMPLAINTS.length+' ('+openComplaints+' open)\n'
      +'Mentor sessions logged: '+CARE_MENTOR.length;
  }
  openAiPanel(text);
  setAiMode('report');
}

function saveMarksheetTemplate(){
  var btn=document.getElementById('msSaveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.reportTemplates=cfg.reportTemplates||{};
  cfg.reportTemplates.marksheet={
    headerText:document.getElementById('msHeaderText').value.trim(),
    titleText:document.getElementById('msTitleText').value.trim()||'STATEMENT OF MARKS',
    footerText:document.getElementById('msFooterText').value.trim(),
    font:document.getElementById('msFont').value,
    color:document.getElementById('msColor').value,
    watermark:document.getElementById('msWatermark').value.trim()
  };
  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    showMsg('msTemplateMsg','Template saved — every marksheet downloaded from Results will use this from now on.',false);
    toast('✅ Marksheet template saved');
  }).catch(function(err){
    showMsg('msTemplateMsg',err.message||'Could not save — you may need admin access.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Save template';
  });
}

// ------------------------------------------------------------
// FEE RECEIPT TEMPLATE (per-tenant, independent from the marksheet template)
// ------------------------------------------------------------
function getFeeReceiptTemplate(){
  var rt=(CTX.config&&CTX.config.reportTemplates)||{};
  var fr=rt.feeReceipt||{};
  return {
    headerText:fr.headerText||CTX.company_name||'',
    titleText:fr.titleText||'FEE RECEIPT',
    footerText:fr.footerText||'Thank you for your payment.',
    font:fr.font||"'Inter',sans-serif",
    color:fr.color||(CTX.config&&CTX.config.brand&&CTX.config.brand.accentColor)||'#2563eb'
  };
}
function populateFeeReceiptTemplateForm(){
  var t=getFeeReceiptTemplate();
  document.getElementById('frHeaderText').value=t.headerText;
  document.getElementById('frTitleText').value=t.titleText;
  document.getElementById('frFooterText').value=t.footerText;
  document.getElementById('frFont').value=t.font;
  document.getElementById('frColor').value=t.color;
}
function getCommitmentLetterTemplate(){
  var cl=(CTX.config&&CTX.config.reportTemplates&&CTX.config.reportTemplates.commitmentLetter)||{};
  return {
    headerText:cl.headerText||CTX.company_name,
    titleText:cl.titleText||'COMMITMENT LETTER',
    bodyTemplate:cl.bodyTemplate||'Dear {{name}},\n\nThis is to confirm your admission into {{course}}, batch {{batch}}, with roll number {{roll}}, effective {{date}}.\n\nBy signing below, you commit to abide by the institution\'s code of conduct, academic policies, and attendance requirements throughout your enrollment.',
    footerText:cl.footerText||'This letter is system-generated and valid without a physical stamp.',
    font:cl.font||"'Inter',sans-serif",
    color:cl.color||(CTX.config&&CTX.config.brand&&CTX.config.brand.accentColor)||'#2563eb'
  };
}
function populateCommitmentLetterTemplateForm(){
  var t=getCommitmentLetterTemplate();
  document.getElementById('clHeaderText').value=t.headerText;
  document.getElementById('clTitleText').value=t.titleText;
  document.getElementById('clBodyTemplate').value=t.bodyTemplate;
  document.getElementById('clFooterText').value=t.footerText;
  document.getElementById('clFont').value=t.font;
  document.getElementById('clColor').value=t.color;
}
function saveCommitmentLetterTemplate(){
  var btn=document.getElementById('clSaveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.reportTemplates=cfg.reportTemplates||{};
  cfg.reportTemplates.commitmentLetter={
    headerText:document.getElementById('clHeaderText').value.trim(),
    titleText:document.getElementById('clTitleText').value.trim()||'COMMITMENT LETTER',
    bodyTemplate:document.getElementById('clBodyTemplate').value,
    footerText:document.getElementById('clFooterText').value.trim(),
    font:document.getElementById('clFont').value,
    color:document.getElementById('clColor').value
  };
  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    showMsg('clTemplateMsg','Template saved — every commitment letter will use this from now on.',false);
    toast('✅ Commitment letter template saved');
  }).catch(function(err){
    showMsg('clTemplateMsg',err.message||'Could not save.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Save template';
  });
}
function saveFeeReceiptTemplate(){
  var btn=document.getElementById('frSaveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.reportTemplates=cfg.reportTemplates||{};
  cfg.reportTemplates.feeReceipt={
    headerText:document.getElementById('frHeaderText').value.trim(),
    titleText:document.getElementById('frTitleText').value.trim()||'FEE RECEIPT',
    footerText:document.getElementById('frFooterText').value.trim(),
    font:document.getElementById('frFont').value,
    color:document.getElementById('frColor').value
  };
  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    showMsg('frTemplateMsg','Template saved — every fee receipt will use this from now on.',false);
    toast('✅ Fee receipt template saved');
  }).catch(function(err){
    showMsg('frTemplateMsg',err.message||'Could not save — you may need admin access.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='Save template';
  });
}

// ------------------------------------------------------------
// PEOPLE MODULE
// ------------------------------------------------------------
function loadPeople(){
  var listEl=document.getElementById('peopleList');
  var key=cacheKeyFor('people');
  cacheGet(key).then(function(cached){
    if(cached&&cached.length&&!PEOPLE_CACHE.length){PEOPLE_CACHE=cached;renderPeopleList();}
    else if(!PEOPLE_CACHE.length){listEl.innerHTML='<div class="rail-card-body"><div class="empty-hint">Loading…</div></div>';}
  });
  getTable('people','order=created_at.desc',true).then(function(rows){
    PEOPLE_CACHE=rows||[];
    cacheSet(key,PEOPLE_CACHE);
    renderPeopleList();
  }).catch(function(err){
    if(!PEOPLE_CACHE.length)listEl.innerHTML='<div class="rail-card-body"><div class="empty-hint">Offline — showing nothing cached yet. '+(err.message||'')+'</div></div>';
  });
}
function computeResult(cf){
  var marks=(cf&&cf.marks)||[];
  if(!marks.length)return null;
  var totObt=0,totMax=0;
  marks.forEach(function(m){
    totObt+=(parseFloat(m.internal)||0)+(parseFloat(m.external)||0);
    totMax+=(parseFloat(m.max)||100);
  });
  var pct=totMax?Math.round((totObt/totMax)*1000)/10:0;
  return {totObt:totObt,totMax:totMax,pct:pct,pass:pct>=40};
}
var PEOPLE_SELECTED={};
function renderPeopleList(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var rows=getFilteredPeopleList();
  var listEl=document.getElementById('peopleList');
  if(!rows.length){
    listEl.innerHTML='<div class="rail-card-body"><div class="empty-hint">No '+(term.entity_person_plural||'people').toLowerCase()+' yet. Tap "+ Add" to create the first one.</div></div>';
    updatePeopleBulkBar();
    return;
  }
  listEl.innerHTML=rows.map(function(p){
    var initials=(p.full_name||'?').trim().split(/\s+/).map(function(w){return w[0];}).slice(0,2).join('').toUpperCase();
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    var result=computeResult(p.custom_fields);
    var checked=PEOPLE_SELECTED[p.id]?'checked':'';
    return '<div class="p-row">'
      +'<input type="checkbox" onclick="event.stopPropagation();togglePersonSelect(\''+p.id+'\')" '+checked+' style="width:auto;margin-right:2px;">'
      +'<div class="p-avatar" onclick="openPersonModal(\''+p.id+'\')" style="cursor:pointer;">'+initials+'</div>'
      +'<div onclick="openPersonModal(\''+p.id+'\')" style="cursor:pointer;flex:1;"><div class="p-name">'+escapeHtml(p.full_name||'—')+(ac.rollNo?'<span class="p-roll">Roll '+escapeHtml(ac.rollNo)+'</span>':'')+'</div>'
      +'<div class="p-meta">'+escapeHtml(p.email||p.phone||ac.batch||'No contact info')+'</div></div>'
      +(result?'<span class="pf-badge '+(result.pass?'pass':'fail')+'">'+result.pct+'% · '+(result.pass?'Pass':'Fail')+'</span>':'')
      +'<div class="p-status '+(p.status||'active')+'">'+(p.status||'active')+'</div>'
      +'</div>';
  }).join('');
  updatePeopleBulkBar();
}
var marksRowCount=0;
function addMarksRow(data){
  var idx=marksRowCount++;
  document.getElementById('marksHead').style.display='grid';
  var wrap=document.getElementById('marksRows');
  var row=document.createElement('div');
  row.className='marks-row';
  row.id='mrow'+idx;
  row.innerHTML='<input placeholder="Subject" id="mSub'+idx+'" value="'+(data&&data.subject?escapeHtml(data.subject):'')+'">'
    +'<input type="number" id="mInt'+idx+'" value="'+(data?data.internal:'')+'">'
    +'<input type="number" id="mExt'+idx+'" value="'+(data?data.external:'')+'">'
    +'<input type="number" id="mMax'+idx+'" value="'+(data&&data.max?data.max:100)+'">'
    +'<span class="mr-remove" onclick="removeMarksRow('+idx+')">✕</span>';
  wrap.appendChild(row);
  ['mInt'+idx,'mExt'+idx,'mMax'+idx].forEach(function(id){
    document.getElementById(id).addEventListener('input',refreshMarksSummary);
  });
  refreshMarksSummary();
}
function removeMarksRow(idx){
  var el=document.getElementById('mrow'+idx);
  if(el)el.remove();
  if(!document.getElementById('marksRows').children.length)document.getElementById('marksHead').style.display='none';
  refreshMarksSummary();
}
function collectMarksFromForm(){
  var wrap=document.getElementById('marksRows');
  var out=[];
  Array.prototype.forEach.call(wrap.children,function(row){
    var idx=row.id.replace('mrow','');
    var subject=document.getElementById('mSub'+idx).value.trim();
    if(!subject)return;
    out.push({
      subject:subject,
      internal:parseFloat(document.getElementById('mInt'+idx).value)||0,
      external:parseFloat(document.getElementById('mExt'+idx).value)||0,
      max:parseFloat(document.getElementById('mMax'+idx).value)||100
    });
  });
  return out;
}
function refreshMarksSummary(){
  var result=computeResult({marks:collectMarksFromForm()});
  var el=document.getElementById('marksSummary');
  if(!result){el.textContent='';return;}
  el.innerHTML='<span>Total: '+result.totObt+' / '+result.totMax+'</span><span class="pf-badge '+(result.pass?'pass':'fail')+'">'+result.pct+'% · '+(result.pass?'Pass':'Fail')+'</span>';
}
function openPersonModal(id){
  clearMsg('personMsg');
  var p=id?PEOPLE_CACHE.find(function(x){return x.id===id;}):null;
  var ac=(p&&p.custom_fields&&p.custom_fields.academic)||{};
  var marks=(p&&p.custom_fields&&p.custom_fields.marks)||[];
  document.getElementById('personModalTitle').textContent=p?'Edit person':'Add person';
  document.getElementById('pId').value=p?p.id:'';
  document.getElementById('pName').value=p?(p.full_name||''):'';
  document.getElementById('pEmail').value=p?(p.email||''):'';
  document.getElementById('pPhone').value=p?(p.phone||''):'';
  document.getElementById('pStatus').value=p?(p.status||'active'):'active';
  document.getElementById('pRollNo').value=ac.rollNo||'';
  document.getElementById('pRegNo').value=ac.regNo||'';
  document.getElementById('pUniNo').value=ac.uniNo||'';
  document.getElementById('pBatch').value=ac.batch||'';
  document.getElementById('pCategory').value=ac.category||'';
  document.getElementById('marksRows').innerHTML='';
  marksRowCount=0;
  document.getElementById('marksHead').style.display='none';
  if(marks.length){marks.forEach(function(m){addMarksRow(m);});}else{document.getElementById('marksSummary').textContent='';}
  document.getElementById('pDeleteBtn').style.display=p?'inline-flex':'none';
  document.getElementById('pDupBtn').style.display=p?'inline-flex':'none';
  openModal('personModal');
}
function savePerson(){
  var id=document.getElementById('pId').value;
  var name=document.getElementById('pName').value.trim();
  if(!name){showMsg('personMsg','Name is required.',true);return;}
  var existing=id?PEOPLE_CACHE.find(function(x){return x.id===id;}):null;
  var customFields=Object.assign({},existing?existing.custom_fields:{});
  customFields.academic={
    rollNo:document.getElementById('pRollNo').value.trim()||null,
    regNo:document.getElementById('pRegNo').value.trim()||null,
    uniNo:document.getElementById('pUniNo').value.trim()||null,
    batch:document.getElementById('pBatch').value.trim()||null,
    category:document.getElementById('pCategory').value.trim()||null
  };
  customFields.marks=collectMarksFromForm();
  var body={
    full_name:name,
    email:document.getElementById('pEmail').value.trim()||null,
    phone:document.getElementById('pPhone').value.trim()||null,
    status:document.getElementById('pStatus').value,
    custom_fields:customFields
  };
  var req;
  if(id){
    req=patchTable('people','id=eq.'+id,body,true);
  }else{
    body.tenant_id=CTX.tenant_id;
    body.created_by=CTX.user_id;
    body.type='contact';
    req=postTable('people',body,true);
  }
  req.then(function(){
    closeModal('personModal');
    toast('✅ Saved');
    loadPeople();
  }).catch(function(err){
    showMsg('personMsg',err.message||'Could not save.',true);
  });
}
function deletePersonConfirm(){
  var id=document.getElementById('pId').value;
  if(!id)return;
  var record=PEOPLE_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  if(!confirm('Remove this record?'))return;
  closeModal('personModal');
  deleteWithUndo('people',record,loadPeople,'Person removed');
}
function duplicatePerson(){
  var id=document.getElementById('pId').value;
  var record=PEOPLE_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('personModal');
  duplicateRecord('people',record,{full_name:(record.full_name||'')+' (copy)'},loadPeople);
}

// ---- Bulk select ----
function togglePersonSelect(id){
  if(PEOPLE_SELECTED[id])delete PEOPLE_SELECTED[id];else PEOPLE_SELECTED[id]=true;
  updatePeopleBulkBar();
}
function clearPeopleSelection(){
  PEOPLE_SELECTED={};
  renderPeopleList();
}
function updatePeopleBulkBar(){
  var count=Object.keys(PEOPLE_SELECTED).length;
  document.getElementById('peopleBulkBar').style.display=count?'block':'none';
  if(count)document.getElementById('peopleBulkCount').textContent=count+' selected';
}
function bulkDeleteSelectedPeople(){
  var ids=Object.keys(PEOPLE_SELECTED);
  if(!ids.length)return;
  if(!confirm('Delete '+ids.length+' selected record(s)? This cannot be undone.'))return;
  Promise.all(ids.map(function(id){return deleteTable('people','id=eq.'+id,true);}))
    .then(function(){toast('✅ '+ids.length+' record(s) deleted');PEOPLE_SELECTED={};loadPeople();})
    .catch(function(err){toast(err.message||'Some deletions failed',true);loadPeople();});
}
function bulkExportSelectedPeople(){
  var ids=Object.keys(PEOPLE_SELECTED);
  var rows=ids.length?PEOPLE_CACHE.filter(function(p){return PEOPLE_SELECTED[p.id];}):PEOPLE_CACHE;
  exportPeopleRowsCsv(rows);
}

// ---- CSV Export ----
function csvEscape(v){
  v=(v==null?'':String(v));
  if(/[",\n]/.test(v))return '"'+v.replace(/"/g,'""')+'"';
  return v;
}
function exportPeopleRowsCsv(rows){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var header=['Name','Email','Phone','Status','Roll No','Registration No','University No','Batch','Category'];
  var lines=[header.join(',')];
  rows.forEach(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    lines.push([p.full_name,p.email,p.phone,p.status,ac.rollNo,ac.regNo,ac.uniNo,ac.batch,ac.category].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(term.entity_person_plural||'people').toLowerCase()+'.csv';
  a.click();
}
function getFilteredPeopleList(){
  var q=(document.getElementById('peopleSearch').value||'').trim().toLowerCase();
  var statusFilter=document.getElementById('peopleStatusFilter').value;
  return PEOPLE_CACHE.filter(function(p){
    if(statusFilter && (p.status||'active')!==statusFilter)return false;
    if(!q)return true;
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    var hay=[p.full_name,p.email,p.phone,ac.rollNo,ac.regNo,ac.uniNo,ac.batch,ac.category].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
function exportPeopleCsv(){
  exportPeopleRowsCsv(getFilteredPeopleList());
}

// ---- Excel/CSV Import (name, email, phone, roll no, batch, category) ----
function handlePeopleImport(e){
  var f=e.target.files[0];
  if(!f)return;
  var reader=new FileReader();
  reader.onload=function(evt){
    var wb;
    try{wb=XLSX.read(evt.target.result,{type:'binary'});}catch(err){toast('Could not read this file',true);return;}
    var sheet=wb.Sheets[wb.SheetNames[0]];
    var rows=XLSX.utils.sheet_to_json(sheet,{defval:''});
    if(!rows.length){toast('No data rows found',true);return;}
    importPeopleRows(rows);
  };
  reader.readAsBinaryString(f);
}
function importPeopleRows(rows){
  toast('Importing '+rows.length+' record(s)…');
  var created=0,failed=0;
  function next(i){
    if(i>=rows.length){
      toast('✅ Import done — '+created+' created'+(failed?(', '+failed+' failed'):''));
      loadPeople();
      return;
    }
    var row=rows[i];
    var keys=Object.keys(row);
    function get(names){
      for(var n=0;n<names.length;n++){
        var k=keys.find(function(kk){return kk.toLowerCase().replace(/\s/g,'')===names[n];});
        if(k)return row[k];
      }
      return '';
    }
    var name=get(['name','fullname','studentname']);
    if(!name){failed++;return next(i+1);}
    var body={
      tenant_id:CTX.tenant_id,created_by:CTX.user_id,type:'contact',status:'active',
      full_name:String(name).trim(),
      email:String(get(['email'])||'').trim()||null,
      phone:String(get(['phone','mobile','contactnumber'])||'').trim()||null,
      custom_fields:{academic:{
        rollNo:String(get(['rollno','roll'])||'').trim()||null,
        batch:String(get(['batch'])||'').trim()||null,
        category:String(get(['category'])||'').trim()||null
      }}
    };
    postTable('people',body,true).then(function(){created++;next(i+1);}).catch(function(){failed++;next(i+1);});
  }
  next(0);
}

// ------------------------------------------------------------
// ACTIVITIES MODULE (pipeline board)
// ------------------------------------------------------------
function getStages(){
  var wf=(CTX.config&&CTX.config.workflows)||{};
  return wf.activity_pipeline_stages||['New','In Progress','Completed'];
}
function loadActivities(){
  var board=document.getElementById('activitiesBoard');
  var key=cacheKeyFor('activities');
  cacheGet(key).then(function(cached){
    if(cached&&cached.length&&!ACTIVITIES_CACHE.length){ACTIVITIES_CACHE=cached;renderActivitiesBoard();}
    else if(!ACTIVITIES_CACHE.length){board.innerHTML='<div class="empty-hint">Loading…</div>';}
  });
  Promise.all([
    getTable('activities','type=eq.activity&order=created_at.desc',true),
    PEOPLE_CACHE.length?Promise.resolve(PEOPLE_CACHE):getTable('people','order=full_name.asc',true)
  ]).then(function(res){
    ACTIVITIES_CACHE=res[0]||[];
    PEOPLE_CACHE=res[1]||PEOPLE_CACHE;
    cacheSet(key,ACTIVITIES_CACHE);
    populatePersonDropdown();
    renderActivitiesBoard();
  }).catch(function(err){
    if(!ACTIVITIES_CACHE.length)board.innerHTML='<div class="empty-hint">Offline — nothing cached yet. '+(err.message||'')+'</div>';
  });
}
function populatePersonDropdown(){
  var sel=document.getElementById('aPersonId');
  var term=(CTX.config&&CTX.config.terminology)||{};
  sel.innerHTML='<option value="">— None —</option>'+PEOPLE_CACHE.map(function(p){
    return '<option value="'+p.id+'">'+escapeHtml(p.full_name||('Unnamed '+(term.entity_person||'person')))+'</option>';
  }).join('');
}
function renderActivitiesBoard(){
  var stages=getStages();
  var board=document.getElementById('activitiesBoard');
  board.innerHTML=stages.map(function(stage){
    var items=ACTIVITIES_CACHE.filter(function(a){return a.stage===stage;});
    return '<div class="kanban-col">'
      +'<div class="kanban-col-head"><span>'+escapeHtml(stage)+'</span><span class="kanban-count">'+items.length+'</span></div>'
      +(items.length?items.map(function(a){
          var person=PEOPLE_CACHE.find(function(p){return p.id===a.person_id;});
          return '<div class="kanban-card" onclick="openActivityModal(\''+a.id+'\')">'
            +'<div class="k-title">'+escapeHtml(a.title||'Untitled')+'</div>'
            +(person?'<div class="k-person">'+escapeHtml(person.full_name)+'</div>':'')
            +(a.due_date?'<div class="k-due">Due '+a.due_date+'</div>':'')
            +'</div>';
        }).join(''):'<div class="kanban-empty">Nothing here</div>')
      +'</div>';
  }).join('');
}
function openActivityModal(id){
  clearMsg('activityMsg');
  var a=id?ACTIVITIES_CACHE.find(function(x){return x.id===id;}):null;
  document.getElementById('activityModalTitle').textContent=a?'Edit activity':'Add activity';
  document.getElementById('aId').value=a?a.id:'';
  document.getElementById('aTitle').value=a?(a.title||''):'';
  document.getElementById('aPersonId').value=a?(a.person_id||''):'';
  document.getElementById('aDueDate').value=a?(a.due_date||''):'';
  document.getElementById('aNotes').value=a?(a.notes||''):'';
  var stageSel=document.getElementById('aStage');
  stageSel.innerHTML=getStages().map(function(s){return '<option value="'+s+'">'+s+'</option>';}).join('');
  stageSel.value=a?a.stage:getStages()[0];
  document.getElementById('aDeleteBtn').style.display=a?'inline-flex':'none';
  document.getElementById('aDupBtn').style.display=a?'inline-flex':'none';
  var meeting=(a&&a.custom_fields&&a.custom_fields.meeting)||{};
  document.getElementById('mPlatform').value=meeting.platform||'meet';
  document.getElementById('mLink').value=meeting.link||'';
  document.getElementById('mRecording').value=meeting.recording||'';
  document.getElementById('mNotes').value=meeting.notes||'';
  document.getElementById('mSummaryWrap').style.display=meeting.summary?'block':'none';
  document.getElementById('mSummaryOutput').textContent=meeting.summary||'';
  updateMeetingLaunchButton();
  openModal('activityModal');
}
function saveActivity(){
  var id=document.getElementById('aId').value;
  var title=document.getElementById('aTitle').value.trim();
  if(!title){showMsg('activityMsg','Title is required.',true);return;}
  var existing=id?ACTIVITIES_CACHE.find(function(x){return x.id===id;}):null;
  var cf=Object.assign({},existing?existing.custom_fields:{});
  var summaryText=document.getElementById('mSummaryOutput').textContent.trim();
  cf.meeting={
    platform:document.getElementById('mPlatform').value,
    link:document.getElementById('mLink').value.trim()||null,
    recording:document.getElementById('mRecording').value.trim()||null,
    notes:document.getElementById('mNotes').value.trim()||null,
    summary:summaryText||null
  };
  var body={
    title:title,
    person_id:document.getElementById('aPersonId').value||null,
    stage:document.getElementById('aStage').value,
    due_date:document.getElementById('aDueDate').value||null,
    notes:document.getElementById('aNotes').value.trim()||null,
    custom_fields:cf
  };
  var req;
  if(id){
    req=patchTable('activities','id=eq.'+id,body,true);
  }else{
    body.tenant_id=CTX.tenant_id;
    body.created_by=CTX.user_id;
    body.type='activity';
    req=postTable('activities',body,true);
  }
  req.then(function(){
    closeModal('activityModal');
    toast('✅ Saved');
    loadActivities();
  }).catch(function(err){
    showMsg('activityMsg',err.message||'Could not save.',true);
  });
}
function deleteActivityConfirm(){
  var id=document.getElementById('aId').value;
  if(!id)return;
  var record=ACTIVITIES_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  if(!confirm('Remove this activity?'))return;
  closeModal('activityModal');
  deleteWithUndo('activities',record,loadActivities,'Activity removed');
}
function duplicateActivity(){
  var id=document.getElementById('aId').value;
  var record=ACTIVITIES_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('activityModal');
  duplicateRecord('activities',record,{title:(record.title||'')+' (copy)',stage:getStages()[0]},loadActivities);
}

// ------------------------------------------------------------
// VIRTUAL VISIT — Meet/Zoom/Teams launch, AI meeting summary, share
// ------------------------------------------------------------
var MEETING_PLATFORM_META={
  meet:{label:'Google Meet',newUrl:'https://meet.new'},
  zoom:{label:'Zoom',newUrl:'https://zoom.us/start'},
  teams:{label:'Microsoft Teams',newUrl:'https://teams.microsoft.com/start'}
};
function updateMeetingLaunchButton(){
  var platform=document.getElementById('mPlatform').value;
  var link=document.getElementById('mLink').value.trim();
  var meta=MEETING_PLATFORM_META[platform];
  var btn=document.getElementById('mLaunchBtn');
  if(link){
    btn.textContent='🚀 Launch '+meta.label+' meeting';
    btn.style.display='inline-flex';
  }else{
    btn.textContent='🚀 Start a new '+meta.label+' meeting';
    btn.style.display='inline-flex';
  }
}
function launchMeeting(){
  var platform=document.getElementById('mPlatform').value;
  var link=document.getElementById('mLink').value.trim();
  var meta=MEETING_PLATFORM_META[platform];
  window.open(link||meta.newUrl,'_blank');
}
function generateMeetingSummary(){
  var notes=document.getElementById('mNotes').value.trim();
  if(!notes){toast('Add some meeting notes first',true);return;}
  var personId=document.getElementById('aPersonId').value;
  var p=personId?findPersonById(personId):null;
  var term=(CTX.config&&CTX.config.terminology)||{};
  var prompt='The following are raw notes from a virtual meeting with a '+(term.entity_person||'contact')
    +(p?(' named '+p.full_name):'')+'. Write:\n'
    +'1) A short 2-3 sentence summary suitable to share with a parent/guardian.\n'
    +'2) A bullet list of 2-4 concrete follow-up action items.\n\nNotes:\n'+notes;
  var wrap=document.getElementById('mSummaryWrap');
  wrap.style.display='block';
  document.getElementById('mSummaryOutput').textContent='Thinking…';
  callGeminiAssist(prompt).then(function(text){
    document.getElementById('mSummaryOutput').textContent=text;
  }).catch(function(err){
    document.getElementById('mSummaryOutput').textContent='';
    wrap.style.display='none';
    toast(err.message||'AI summary unavailable right now.',true);
  });
}
function shareMeetingWhatsApp(){
  var personId=document.getElementById('aPersonId').value;
  var p=personId?findPersonById(personId):null;
  var text=(document.getElementById('aTitle').value||'Meeting summary')+'\n\n'+document.getElementById('mSummaryOutput').textContent;
  window.open('https://wa.me/'+(p&&p.phone?p.phone.replace(/[^0-9]/g,''):'')+'?text='+encodeURIComponent(text),'_blank');
}
function shareMeetingEmail(){
  var personId=document.getElementById('aPersonId').value;
  var p=personId?findPersonById(personId):null;
  var text=document.getElementById('mSummaryOutput').textContent;
  window.location.href='mailto:'+(p&&p.email?p.email:'')+'?subject='+encodeURIComponent(document.getElementById('aTitle').value||'Meeting summary')+'&body='+encodeURIComponent(text);
}

function escapeHtml(s){
  return (s==null?'':String(s)).replace(/[&<>"']/g,function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

// ------------------------------------------------------------
// RESULTS MODULE
// ------------------------------------------------------------
var RESULTS_SELECTED_ID=null;
function loadResults(){
  var listEl=document.getElementById('resultsList');
  listEl.innerHTML='<div class="empty-hint" style="padding:16px;">Loading…</div>';
  getTable('people','order=full_name.asc',true).then(function(rows){
    PEOPLE_CACHE=rows||[];
    populateResultsFilters();
    renderResultsList();
    renderAnalysis();
  }).catch(function(err){
    listEl.innerHTML='<div class="empty-hint" style="padding:16px;">Could not load: '+(err.message||'')+'</div>';
  });
}
function populateResultsFilters(){
  var batches={},categories={};
  PEOPLE_CACHE.forEach(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    if(ac.batch)batches[ac.batch]=true;
    if(ac.category)categories[ac.category]=true;
  });
  var bSel=document.getElementById('rBatchFilter'),cSel=document.getElementById('rCategoryFilter');
  var curB=bSel.value,curC=cSel.value;
  bSel.innerHTML='<option value="">All</option>'+Object.keys(batches).sort().map(function(b){return '<option value="'+escapeHtml(b)+'">'+escapeHtml(b)+'</option>';}).join('');
  cSel.innerHTML='<option value="">All</option>'+Object.keys(categories).sort().map(function(c){return '<option value="'+escapeHtml(c)+'">'+escapeHtml(c)+'</option>';}).join('');
  bSel.value=curB;cSel.value=curC;
}
function getFilteredResultsPeople(){
  var q=(document.getElementById('rSearch').value||'').trim().toLowerCase();
  var batch=document.getElementById('rBatchFilter').value;
  var category=document.getElementById('rCategoryFilter').value;
  return PEOPLE_CACHE.filter(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    if(batch && ac.batch!==batch)return false;
    if(category && ac.category!==category)return false;
    if(!q)return true;
    var hay=[p.full_name,ac.rollNo,ac.regNo,ac.uniNo].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
function renderResultsList(){
  var rows=getFilteredResultsPeople();
  var listEl=document.getElementById('resultsList');
  var term=(CTX.config&&CTX.config.terminology)||{};
  if(!rows.length){
    listEl.innerHTML='<div class="empty-hint" style="padding:16px;">No matching '+(term.entity_person_plural||'people').toLowerCase()+'.</div>';
  }else{
    listEl.innerHTML=rows.map(function(p){
      var ac=(p.custom_fields&&p.custom_fields.academic)||{};
      var result=computeResult(p.custom_fields);
      return '<div class="result-row'+(p.id===RESULTS_SELECTED_ID?' active':'')+'" onclick="showResultProfile(\''+p.id+'\')">'
        +'<div><div class="p-name">'+escapeHtml(p.full_name||'—')+'</div>'
        +'<div class="p-meta">'+(ac.rollNo?'Roll '+escapeHtml(ac.rollNo)+' · ':'')+(ac.batch||'')+'</div></div>'
        +(result?'<span class="pf-badge '+(result.pass?'pass':'fail')+'" style="margin-left:auto;">'+result.pct+'%</span>':'')
        +'</div>';
    }).join('');
  }
  renderAnalysis();
}
function showResultProfile(id){
  RESULTS_SELECTED_ID=id;
  renderResultsList();
  var p=PEOPLE_CACHE.find(function(x){return x.id===id;});
  var card=document.getElementById('resultProfileCard');
  if(!p){card.style.display='none';return;}
  card.style.display='block';
  var term=(CTX.config&&CTX.config.terminology)||{};
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  var marks=(p.custom_fields&&p.custom_fields.marks)||[];
  var result=computeResult(p.custom_fields);
  var initials=(p.full_name||'?').trim().split(/\s+/).map(function(w){return w[0];}).slice(0,2).join('').toUpperCase();
  var html='<div class="rp-head"><div class="rp-avatar">'+initials+'</div><div>'
    +'<div class="rp-name">'+escapeHtml(p.full_name||'—')+'</div>'
    +'<div class="rp-meta">'+(term.entity_person||'Student')+' · '+escapeHtml(ac.batch||'—')+' · '+escapeHtml(ac.category||'—')+'</div>'
    +'</div></div>';
  html+='<table class="rp-table"><tr><td style="color:var(--ink-3);">Roll No</td><td>'+escapeHtml(ac.rollNo||'—')+'</td><td style="color:var(--ink-3);">Registration No</td><td>'+escapeHtml(ac.regNo||'—')+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">University No</td><td>'+escapeHtml(ac.uniNo||'—')+'</td><td style="color:var(--ink-3);">Contact</td><td>'+escapeHtml(p.phone||p.email||'—')+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">Attendance</td><td colspan="3">'+computeAttendancePctLabel(p.id)+'</td></tr></table>';
  if(marks.length){
    html+='<table class="rp-table"><tr><th>Subject</th><th>Internal</th><th>External</th><th>Total</th></tr>'
      +marks.map(function(m){return '<tr><td>'+escapeHtml(m.subject)+'</td><td>'+m.internal+'</td><td>'+m.external+'</td><td>'+(parseFloat(m.internal||0)+parseFloat(m.external||0))+' / '+m.max+'</td></tr>';}).join('')
      +'</table>';
    html+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">'
      +'<span class="pf-badge '+(result.pass?'pass':'fail')+'" style="font-size:12px;">'+result.pct+'% · '+(result.pass?'Pass':'Fail')+'</span>'
      +'<span class="p-meta">'+result.totObt+' / '+result.totMax+' marks</span></div>';
  }else{
    html+='<p class="empty-hint">No marks recorded yet — add them from the People module.</p>';
  }
  html+='<div class="rp-actions">'
    +'<button class="btn btn-primary btn-sm" onclick="downloadMarksheet(\''+p.id+'\')">⬇️ Download Marksheet</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="openCommitmentLetterModal(\''+p.id+'\')">📜 Commitment Letter</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="shareResultWhatsApp(\''+p.id+'\')">💬 WhatsApp</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="shareResultEmail(\''+p.id+'\')">✉️ Email</button>'
    +(p.phone?'<a class="btn btn-ghost btn-sm" href="tel:'+p.phone+'" style="text-decoration:none;display:inline-flex;">📞 Call</a>':'')
    +(marks.length?'<button class="btn btn-ghost btn-sm" onclick="aiSummarizeResult(\''+p.id+'\')">✨ AI Summary</button>':'')
    +'</div>';
  document.getElementById('resultProfile').innerHTML=html;
}
function aiSummarizeResult(id){
  var p=PEOPLE_CACHE.find(function(x){return x.id===id;});
  if(!p)return;
  var text=buildResultSummaryText(p)+'\n\nWrite a short, warm 2-3 sentence performance summary suitable to share with a parent, in plain language.';
  openAiPanel(text);
  setAiMode('summarize');
}
function buildResultSummaryText(p){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  var result=computeResult(p.custom_fields);
  var lines=[(CTX.config&&CTX.config.app&&CTX.config.app.appName)||CTX.company_name];
  lines.push((term.entity_person||'Student')+' Result — '+(p.full_name||''));
  if(ac.rollNo)lines.push('Roll No: '+ac.rollNo);
  if(ac.batch)lines.push('Batch: '+ac.batch);
  if(result)lines.push('Result: '+result.totObt+'/'+result.totMax+' ('+result.pct+'%) — '+(result.pass?'PASS':'FAIL'));
  return lines.join('\n');
}
function shareResultWhatsApp(id){
  var p=PEOPLE_CACHE.find(function(x){return x.id===id;});
  if(!p)return;
  var text=buildResultSummaryText(p);
  var phone=(p.phone||'').replace(/[^0-9]/g,'');
  window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(text),'_blank');
}
function shareResultEmail(id){
  var p=PEOPLE_CACHE.find(function(x){return x.id===id;});
  if(!p)return;
  var text=buildResultSummaryText(p);
  var subject=(p.full_name||'Student')+' — Result';
  window.location.href='mailto:'+(p.email||'')+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(text);
}
function downloadMarksheet(id){
  var p=PEOPLE_CACHE.find(function(x){return x.id===id;});
  if(!p)return;
  var t=getMarksheetTemplate();
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  var marks=(p.custom_fields&&p.custom_fields.marks)||[];
  var result=computeResult(p.custom_fields);
  var logo=(CTX.config&&CTX.config.brand&&CTX.config.brand.logoUrl)||null;
  var html='<div style="font-family:'+t.font+';max-width:640px;margin:0 auto;position:relative;">'
    +(t.watermark?'<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:64px;color:'+t.color+';opacity:0.08;transform:rotate(-25deg);pointer-events:none;">'+escapeHtml(t.watermark)+'</div>':'')
    +'<div style="text-align:center;margin-bottom:16px;border-bottom:3px solid '+t.color+';padding-bottom:14px;">'
    +(logo?'<img src="'+logo+'" style="width:56px;height:56px;object-fit:contain;margin-bottom:8px;">':'')
    +'<div style="font-size:19px;font-weight:700;">'+escapeHtml(t.headerText)+'</div>'
    +'<div style="font-size:14px;font-weight:600;margin-top:6px;color:'+t.color+';">'+escapeHtml(t.titleText)+'</div></div>'
    +'<table style="width:100%;font-size:12px;margin-bottom:14px;">'
    +'<tr><td style="color:#666;padding:3px 0;">Name</td><td style="text-align:right;font-weight:600;">'+escapeHtml(p.full_name||'-')+'</td></tr>'
    +'<tr><td style="color:#666;padding:3px 0;">Roll No</td><td style="text-align:right;">'+escapeHtml(ac.rollNo||'-')+'</td></tr>'
    +'<tr><td style="color:#666;padding:3px 0;">Batch / Category</td><td style="text-align:right;">'+escapeHtml(ac.batch||'-')+' / '+escapeHtml(ac.category||'-')+'</td></tr>'
    +'<tr><td style="color:#666;padding:3px 0;">Date</td><td style="text-align:right;">'+new Date().toLocaleDateString()+'</td></tr>'
    +'</table>'
    +'<table style="width:100%;font-size:12.5px;border-collapse:collapse;">'
    +'<tr style="border-bottom:2px solid #333;"><th style="text-align:left;padding:6px 0;">Subject</th><th style="text-align:right;">Internal</th><th style="text-align:right;">External</th><th style="text-align:right;">Total</th></tr>'
    +marks.map(function(m){return '<tr style="border-bottom:1px solid #ddd;"><td style="padding:6px 0;">'+escapeHtml(m.subject)+'</td><td style="text-align:right;">'+m.internal+'</td><td style="text-align:right;">'+m.external+'</td><td style="text-align:right;">'+(parseFloat(m.internal||0)+parseFloat(m.external||0))+' / '+m.max+'</td></tr>';}).join('')
    +'</table>'
    +(result?'<div style="text-align:center;margin-top:16px;font-size:17px;font-weight:700;color:'+t.color+';">'+result.pct+'% — '+(result.pass?'PASS':'FAIL')+'</div>':'')
    +'<div style="margin-top:20px;font-size:11px;color:#888;text-align:center;">'+escapeHtml(t.footerText)+'</div>'
    +'</div>';
  document.getElementById('printArea').innerHTML=html;
  setTimeout(function(){window.print();},80);
}

// ------------------------------------------------------------
// COMMITMENT LETTER — generation modal (template engine + AI + signature)
// ------------------------------------------------------------
var CL_ACTIVE_PERSON_ID=null;
var CL_SIG_CTX=null,CL_SIG_DRAWING=false,CL_SIG_HAS_INK=false;
function fillCommitmentPlaceholders(template,p){
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  return template
    .replace(/\{\{name\}\}/g,p.full_name||'')
    .replace(/\{\{course\}\}/g,ac.category||CTX.vertical||'')
    .replace(/\{\{batch\}\}/g,ac.batch||'')
    .replace(/\{\{roll\}\}/g,ac.rollNo||'')
    .replace(/\{\{date\}\}/g,new Date().toLocaleDateString());
}
function openCommitmentLetterModal(personId){
  var p=findPersonById(personId);
  if(!p)return;
  CL_ACTIVE_PERSON_ID=personId;
  clearMsg('clMsg');
  var t=getCommitmentLetterTemplate();
  document.getElementById('clPreviewBody').value=fillCommitmentPlaceholders(t.bodyTemplate,p);
  openModal('commitmentLetterModal');
  setTimeout(initClSignaturePad,50); // after modal is visible so canvas has real dimensions
}
function initClSignaturePad(){
  var canvas=document.getElementById('clSignatureCanvas');
  var ratio=window.devicePixelRatio||1;
  canvas.width=canvas.clientWidth*ratio;
  canvas.height=canvas.clientHeight*ratio;
  CL_SIG_CTX=canvas.getContext('2d');
  CL_SIG_CTX.scale(ratio,ratio);
  CL_SIG_CTX.strokeStyle='#12141a';
  CL_SIG_CTX.lineWidth=2;
  CL_SIG_CTX.lineCap='round';
  CL_SIG_HAS_INK=false;
  function pos(e){
    var r=canvas.getBoundingClientRect();
    var t=(e.touches&&e.touches[0])||e;
    return {x:t.clientX-r.left,y:t.clientY-r.top};
  }
  function start(e){CL_SIG_DRAWING=true;var p=pos(e);CL_SIG_CTX.beginPath();CL_SIG_CTX.moveTo(p.x,p.y);e.preventDefault();}
  function move(e){if(!CL_SIG_DRAWING)return;var p=pos(e);CL_SIG_CTX.lineTo(p.x,p.y);CL_SIG_CTX.stroke();CL_SIG_HAS_INK=true;e.preventDefault();}
  function end(){CL_SIG_DRAWING=false;}
  canvas.onmousedown=start;canvas.onmousemove=move;canvas.onmouseup=end;canvas.onmouseleave=end;
  canvas.ontouchstart=start;canvas.ontouchmove=move;canvas.ontouchend=end;
}
function clClearSignature(){
  var canvas=document.getElementById('clSignatureCanvas');
  if(CL_SIG_CTX)CL_SIG_CTX.clearRect(0,0,canvas.width,canvas.height);
  CL_SIG_HAS_INK=false;
}
function aiDraftCommitmentLetter(){
  var current=document.getElementById('clPreviewBody').value;
  var prompt='Refine this admission commitment letter for a '+humanizeVertical(CTX.vertical)+' to sound formal, warm, and professional, keeping every fact (names, dates, roll numbers) exactly unchanged:\n\n'+current;
  showMsg('clMsg','Asking AI to refine wording…',false);
  callGeminiAssist(prompt).then(function(text){
    document.getElementById('clPreviewBody').value=text;
    clearMsg('clMsg');
  }).catch(function(err){
    showMsg('clMsg',err.message||'AI refine unavailable — your original text is unchanged.',true);
  });
}
function downloadCommitmentLetter(){
  var p=findPersonById(CL_ACTIVE_PERSON_ID);
  if(!p)return;
  var t=getCommitmentLetterTemplate();
  var body=document.getElementById('clPreviewBody').value;
  var logo=(CTX.config&&CTX.config.brand&&CTX.config.brand.logoUrl)||null;
  var sigDataUrl=(CL_SIG_CTX&&CL_SIG_HAS_INK)?document.getElementById('clSignatureCanvas').toDataURL('image/png'):null;
  var html='<div style="font-family:'+t.font+';max-width:640px;margin:0 auto;">'
    +'<div style="text-align:center;margin-bottom:18px;border-bottom:3px solid '+t.color+';padding-bottom:14px;">'
    +(logo?'<img src="'+logo+'" style="width:56px;height:56px;object-fit:contain;margin-bottom:8px;">':'')
    +'<div style="font-size:19px;font-weight:700;">'+escapeHtml(t.headerText)+'</div>'
    +'<div style="font-size:14px;font-weight:600;margin-top:6px;color:'+t.color+';">'+escapeHtml(t.titleText)+'</div></div>'
    +'<div style="font-size:13px;line-height:1.8;white-space:pre-wrap;margin-bottom:24px;">'+escapeHtml(body)+'</div>'
    +(sigDataUrl?'<div style="margin-top:30px;"><img src="'+sigDataUrl+'" style="max-width:200px;max-height:70px;"><div style="border-top:1px solid #333;width:200px;font-size:10.5px;color:#888;padding-top:4px;">Student Signature</div></div>':'')
    +'<div style="margin-top:26px;font-size:10.5px;color:#888;text-align:center;">'+escapeHtml(t.footerText)+'</div>'
    +'</div>';
  document.getElementById('printArea').innerHTML=html;
  setTimeout(function(){window.print();},80);
  // Lightweight audit trail — logged as an activity, doesn't block the download if it fails.
  postTable('activities',{tenant_id:CTX.tenant_id,created_by:CTX.user_id,person_id:p.id,type:'commitment_letter',title:'Commitment Letter Generated',custom_fields:{generatedAt:new Date().toISOString(),hasSignature:!!sigDataUrl}},true).catch(function(){});
}
function shareCommitmentLetterWhatsApp(){
  var p=findPersonById(CL_ACTIVE_PERSON_ID);
  if(!p)return;
  var body=document.getElementById('clPreviewBody').value;
  window.open('https://wa.me/'+(p.phone||'').replace(/[^0-9]/g,'')+'?text='+encodeURIComponent(body),'_blank');
}
function shareCommitmentLetterEmail(){
  var p=findPersonById(CL_ACTIVE_PERSON_ID);
  if(!p)return;
  var body=document.getElementById('clPreviewBody').value;
  window.location.href='mailto:'+(p.email||'')+'?subject='+encodeURIComponent('Commitment Letter')+'&body='+encodeURIComponent(body);
}

// ------------------------------------------------------------
// Lightweight inline SVG charts (no external chart library needed)
// ------------------------------------------------------------
function renderAnalysis(){
  var rows=getFilteredResultsPeople();
  var pass=0,fail=0,haveResult=0;
  var catTotals={};
  rows.forEach(function(p){
    var r=computeResult(p.custom_fields);
    if(!r)return;
    haveResult++;
    if(r.pass)pass++;else fail++;
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    var cat=ac.category||'Uncategorized';
    catTotals[cat]=catTotals[cat]||{sum:0,count:0};
    catTotals[cat].sum+=r.pct;catTotals[cat].count++;
  });
  document.getElementById('pieChartHolder').innerHTML=haveResult?svgPie(pass,fail):'<div class="empty-hint">No results yet</div>';
  var catAverages=Object.keys(catTotals).map(function(c){return {label:c,value:Math.round(catTotals[c].sum/catTotals[c].count)};});
  document.getElementById('barChartHolder').innerHTML=catAverages.length?svgBar(catAverages,{suffix:'%',maxValue:100}):'<div class="empty-hint">No category data yet</div>';
}
function svgPie(a,b,labels){
  labels=labels||['Pass','Fail'];
  var total=a+b||1;
  var aDeg=(a/total)*360;
  var accent=(CTX.config&&CTX.config.brand&&CTX.config.brand.accentColor)||'#2563eb';
  function coords(deg){var r=50,cx=60,cy=60,ang=(deg-90)*Math.PI/180;return [cx+r*Math.cos(ang),cy+r*Math.sin(ang)];}
  var start=coords(0),end=coords(aDeg);
  var largeArc=aDeg>180?1:0;
  var aPath='M60,60 L'+start[0]+','+start[1]+' A50,50 0 '+largeArc+' 1 '+end[0]+','+end[1]+' Z';
  return '<svg width="130" height="130" viewBox="0 0 120 120">'
    +'<circle cx="60" cy="60" r="50" fill="var(--err)" opacity="0.85"></circle>'
    +(a>0?'<path d="'+aPath+'" fill="'+accent+'"></path>':'')
    +'</svg>'
    +'<div style="display:flex;gap:14px;margin-top:8px;font-size:11.5px;">'
    +'<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+accent+';margin-right:4px;"></span>'+labels[0]+' ('+a.toLocaleString()+')</span>'
    +'<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--err);margin-right:4px;"></span>'+labels[1]+' ('+b.toLocaleString()+')</span>'
    +'</div>';
}
function svgBar(data,opts){
  opts=opts||{};
  var suffix=(opts.suffix!==undefined)?opts.suffix:'%';
  var maxValue=opts.maxValue||Math.max.apply(null,data.map(function(d){return d.value;}).concat([1]));
  var w=240,barH=22,gap=10,accent=(CTX.config&&CTX.config.brand&&CTX.config.brand.accentColor)||'#2563eb';
  var h=data.length*(barH+gap);
  var bars=data.map(function(d,i){
    var y=i*(barH+gap);
    var barW=Math.max(4,(d.value/maxValue)*(w-70));
    return '<text x="0" y="'+(y+barH-6)+'" font-size="11" fill="var(--ink-2)">'+escapeHtml(d.label)+'</text>'
      +'<rect x="70" y="'+y+'" width="'+barW+'" height="'+barH+'" rx="4" fill="'+accent+'"></rect>'
      +'<text x="'+(76+barW)+'" y="'+(y+barH-6)+'" font-size="11" fill="var(--ink-2)">'+d.value.toLocaleString()+suffix+'</text>';
  }).join('');
  return '<svg width="100%" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+bars+'</svg>';
}

// ------------------------------------------------------------
// EXCEL BULK UPLOAD (Roll No -> auto student mapping -> marks)
// ------------------------------------------------------------
function openExcelUploadModal(){
  document.getElementById('excelProgress').innerHTML='';
  clearMsg('excelMsg');
  document.getElementById('excelFileInput').value='';
  openModal('excelModal');
}
function normRoll(v){return (v==null?'':String(v)).trim().toLowerCase();}
function handleResultsExcelUpload(e){
  var f=e.target.files[0];
  if(!f)return;
  var progEl=document.getElementById('excelProgress');
  progEl.innerHTML='<div class="empty-hint">Reading file…</div>';
  var reader=new FileReader();
  reader.onload=function(evt){
    var wb;
    try{
      wb=XLSX.read(evt.target.result,{type:'binary'});
    }catch(err){
      showMsg('excelMsg','Could not read this file — is it a valid Excel/CSV file?',true);
      progEl.innerHTML='';
      return;
    }
    var sheet=wb.Sheets[wb.SheetNames[0]];
    var rows=XLSX.utils.sheet_to_json(sheet,{defval:''});
    if(!rows.length){showMsg('excelMsg','The file has no data rows.',true);progEl.innerHTML='';return;}
    processExcelRows(rows,progEl);
  };
  reader.onerror=function(){showMsg('excelMsg','Could not read this file.',true);progEl.innerHTML='';};
  reader.readAsBinaryString(f);
}
// Detects columns: first column = roll no, second = name, remaining are
// either "<Subject>" (single mark, uses the default max) or
// "<Subject> Internal" / "<Subject> External" pairs.
function parseSubjectColumns(headerKeys){
  var subjectCols=headerKeys.slice(2); // skip roll + name
  var pairs={}; // subject -> {internalKey, externalKey, singleKey}
  subjectCols.forEach(function(key){
    var lower=key.toLowerCase().trim();
    var mInt=lower.match(/^(.*)\s+internal$/);
    var mExt=lower.match(/^(.*)\s+external$/);
    if(mInt){
      var s1=mInt[1].trim();
      pairs[s1]=pairs[s1]||{};
      pairs[s1].internalKey=key;
    }else if(mExt){
      var s2=mExt[1].trim();
      pairs[s2]=pairs[s2]||{};
      pairs[s2].externalKey=key;
    }else{
      pairs[lower]=pairs[lower]||{};
      pairs[lower].singleKey=key;
      pairs[lower].displayName=key;
    }
  });
  return pairs;
}
function processExcelRows(rows,progEl){
  var headerKeys=Object.keys(rows[0]);
  if(headerKeys.length<3){
    showMsg('excelMsg','Expected at least: Roll No, Name, and one subject column.',true);
    progEl.innerHTML='';
    return;
  }
  var rollKey=headerKeys[0],nameKey=headerKeys[1];
  var subjectMap=parseSubjectColumns(headerKeys);
  var defaultMax=parseFloat(document.getElementById('excelDefaultMax').value)||100;
  var createMissing=document.getElementById('excelCreateMissing').checked;

  var byRoll={};
  PEOPLE_CACHE.forEach(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    if(ac.rollNo)byRoll[normRoll(ac.rollNo)]=p;
  });

  var updated=0,created=0,skipped=0,failed=0;
  progEl.innerHTML='<div class="empty-hint">Processing 0 / '+rows.length+'…</div>';

  function buildMarksFromRow(row){
    var marks=[];
    Object.keys(subjectMap).forEach(function(subjKey){
      var def=subjectMap[subjKey];
      if(def.internalKey || def.externalKey){
        var internal=parseFloat(row[def.internalKey])||0;
        var external=parseFloat(row[def.externalKey])||0;
        marks.push({subject:capitalize(subjKey),internal:internal,external:external,max:defaultMax});
      }else if(def.singleKey){
        var val=row[def.singleKey];
        if(val===''||val==null)return;
        marks.push({subject:def.displayName,internal:parseFloat(val)||0,external:0,max:defaultMax});
      }
    });
    return marks;
  }

  function processIndex(i){
    if(i>=rows.length){
      var summary=updated+' updated, '+created+' created, '+skipped+' skipped (no roll no), '+failed+' failed.';
      progEl.innerHTML='<div class="empty-hint">Done — '+summary+'</div>';
      showMsg('excelMsg',summary,failed>0);
      loadResults();
      return;
    }
    progEl.innerHTML='<div class="empty-hint">Processing '+(i+1)+' / '+rows.length+'…</div>';
    var row=rows[i];
    var rollRaw=row[rollKey];
    var name=(row[nameKey]||'').toString().trim();
    var roll=normRoll(rollRaw);
    if(!roll){skipped++;return processIndex(i+1);}
    var marks=buildMarksFromRow(row);
    var existing=byRoll[roll];

    if(existing){
      var cf=Object.assign({},existing.custom_fields);
      cf.marks=marks;
      patchTable('people','id=eq.'+existing.id,{custom_fields:cf},true).then(function(){
        existing.custom_fields=cf;
        updated++;processIndex(i+1);
      }).catch(function(){failed++;processIndex(i+1);});
    }else if(createMissing){
      var body={
        tenant_id:CTX.tenant_id,created_by:CTX.user_id,type:'contact',
        full_name:name||('Roll '+rollRaw),status:'active',
        custom_fields:{academic:{rollNo:String(rollRaw).trim()},marks:marks}
      };
      postTable('people',body,true).then(function(p){
        byRoll[roll]=p;PEOPLE_CACHE.push(p);
        created++;processIndex(i+1);
      }).catch(function(){failed++;processIndex(i+1);});
    }else{
      skipped++;processIndex(i+1);
    }
  }
  processIndex(0);
}

// ------------------------------------------------------------
// FEES MODULE
// ------------------------------------------------------------
var FEES_SELECTED_ID=null;
function computeFeeStatus(f){
  var cf=f.custom_fields||{};
  var paid=(cf.paymentHistory||[]).reduce(function(s,p){return s+(parseFloat(p.amount)||0);},0);
  var total=parseFloat(f.amount)||0;
  var fine=parseFloat(cf.fine)||0;
  var totalDue=total+fine;
  var pending=Math.max(0,totalDue-paid);
  var overdue=cf.dueDate && new Date(cf.dueDate)<new Date() && pending>0;
  var status=pending<=0?'paid':(paid>0?'partial':(overdue?'overdue':'pending'));
  return {paid:paid,total:total,fine:fine,totalDue:totalDue,pending:pending,status:status,overdue:!!overdue};
}
function loadFees(){
  var listEl=document.getElementById('feesList');
  var key=cacheKeyFor('fees');
  cacheGet(key).then(function(cached){
    if(cached&&cached.length&&!FEES_CACHE.length){
      FEES_CACHE=cached;
      populateFeeBatchFilter();populateFeePersonDropdown();renderFeesList();renderFeeStats();renderFeeAnalysis();
    }else if(!FEES_CACHE.length){listEl.innerHTML='<div class="empty-hint" style="padding:16px;">Loading…</div>';}
  });
  Promise.all([
    getTable('transactions','type=eq.fee&order=created_at.desc',true),
    PEOPLE_CACHE.length?Promise.resolve(PEOPLE_CACHE):getTable('people','order=full_name.asc',true)
  ]).then(function(res){
    FEES_CACHE=res[0]||[];
    PEOPLE_CACHE=res[1]||PEOPLE_CACHE;
    cacheSet(key,FEES_CACHE);
    populateFeeBatchFilter();
    populateFeePersonDropdown();
    renderFeesList();
    renderFeeStats();
    renderFeeAnalysis();
  }).catch(function(err){
    if(!FEES_CACHE.length)listEl.innerHTML='<div class="empty-hint" style="padding:16px;">Offline — nothing cached yet. '+(err.message||'')+'</div>';
  });
}
function findPersonById(id){return PEOPLE_CACHE.find(function(p){return p.id===id;});}
function populateFeeBatchFilter(){
  var batches={};
  PEOPLE_CACHE.forEach(function(p){var ac=(p.custom_fields&&p.custom_fields.academic)||{};if(ac.batch)batches[ac.batch]=true;});
  var sel=document.getElementById('feeBatchFilter');
  var cur=sel.value;
  sel.innerHTML='<option value="">All</option>'+Object.keys(batches).sort().map(function(b){return '<option value="'+escapeHtml(b)+'">'+escapeHtml(b)+'</option>';}).join('');
  sel.value=cur;
}
function populateFeePersonDropdown(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var sel=document.getElementById('fPersonId');
  sel.innerHTML=PEOPLE_CACHE.map(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    return '<option value="'+p.id+'">'+escapeHtml(p.full_name||'Unnamed')+(ac.rollNo?' (Roll '+escapeHtml(ac.rollNo)+')':'')+'</option>';
  }).join('')||'<option value="">No '+(term.entity_person_plural||'people').toLowerCase()+' yet — add one first</option>';
}
function getFilteredFees(){
  var q=(document.getElementById('feeSearch').value||'').trim().toLowerCase();
  var batch=document.getElementById('feeBatchFilter').value;
  var currency=document.getElementById('feeCurrencyFilter').value;
  var statusFilter=document.getElementById('feeStatusFilter').value;
  return FEES_CACHE.filter(function(f){
    var p=findPersonById(f.person_id)||{};
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    if(batch && ac.batch!==batch)return false;
    if(currency && (f.currency||'NPR')!==currency)return false;
    var result=computeFeeStatus(f);
    if(statusFilter && result.status!==statusFilter)return false;
    if(!q)return true;
    var hay=[p.full_name,ac.rollNo].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
function currencySymbol(code){
  return ({NPR:'₨',INR:'₹',USD:'$'})[code]||code||'';
}
function renderFeeStats(){
  var rows=getFilteredFees();
  var byCurrency={};
  rows.forEach(function(f){
    var cur=f.currency||'NPR';
    var r=computeFeeStatus(f);
    byCurrency[cur]=byCurrency[cur]||{collected:0,pending:0};
    byCurrency[cur].collected+=r.paid;
    byCurrency[cur].pending+=r.pending;
  });
  var overdueCount=rows.filter(function(f){return computeFeeStatus(f).status==='overdue';}).length;
  var stats=[];
  Object.keys(byCurrency).forEach(function(cur){
    stats.push({value:currencySymbol(cur)+byCurrency[cur].collected.toLocaleString(),label:'Collected ('+cur+')'});
    stats.push({value:currencySymbol(cur)+byCurrency[cur].pending.toLocaleString(),label:'Pending ('+cur+')'});
  });
  stats.push({value:overdueCount,label:'Overdue'});
  stats.push({value:rows.length,label:'Fee Records'});
  document.getElementById('feeStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
var FEES_BULK_SELECTED={};
function renderFeesList(){
  var rows=getFilteredFees();
  var listEl=document.getElementById('feesList');
  if(!rows.length){
    listEl.innerHTML='<div class="empty-hint" style="padding:16px;">No fee records match. Tap "+ Add Fee Record" to create one.</div>';
  }else{
    listEl.innerHTML=rows.map(function(f){
      var p=findPersonById(f.person_id)||{};
      var ac=(p.custom_fields&&p.custom_fields.academic)||{};
      var r=computeFeeStatus(f);
      var checked=FEES_BULK_SELECTED[f.id]?'checked':'';
      return '<div class="result-row'+(f.id===FEES_SELECTED_ID?' active':'')+'">'
        +'<input type="checkbox" onclick="event.stopPropagation();toggleFeeSelect(\''+f.id+'\')" '+checked+' style="width:auto;margin-right:8px;">'
        +'<div style="flex:1;cursor:pointer;" onclick="showFeeProfile(\''+f.id+'\')"><div class="p-name">'+escapeHtml(p.full_name||'—')+(ac.rollNo?'<span class="p-roll">Roll '+escapeHtml(ac.rollNo)+'</span>':'')+'</div>'
        +'<div class="p-meta">'+escapeHtml(f.category||'Fee')+' · Due '+(f.custom_fields&&f.custom_fields.dueDate||'—')+'</div></div>'
        +'<span class="pf-badge '+(r.status==='paid'?'pass':'fail')+'" style="margin-left:auto;">'+currencySymbol(f.currency)+r.pending.toLocaleString()+' · '+r.status+'</span>'
        +'</div>';
    }).join('');
  }
  renderFeeStats();
  renderFeeAnalysis();
  updateFeeBulkBar();
}
function toggleFeeSelect(id){
  if(FEES_BULK_SELECTED[id])delete FEES_BULK_SELECTED[id];else FEES_BULK_SELECTED[id]=true;
  updateFeeBulkBar();
}
function clearFeeSelection(){FEES_BULK_SELECTED={};renderFeesList();}
function updateFeeBulkBar(){
  var bar=document.getElementById('feesBulkBar');
  if(!bar)return;
  var count=Object.keys(FEES_BULK_SELECTED).length;
  bar.style.display=count?'block':'none';
  if(count)document.getElementById('feesBulkCount').textContent=count+' selected';
}
function bulkDeleteSelectedFees(){
  var ids=Object.keys(FEES_BULK_SELECTED);
  if(!ids.length)return;
  if(!confirm('Delete '+ids.length+' selected fee record(s)? This cannot be undone.'))return;
  Promise.all(ids.map(function(id){return deleteTable('transactions','id=eq.'+id,true);}))
    .then(function(){toast('✅ '+ids.length+' record(s) deleted');FEES_BULK_SELECTED={};loadFees();})
    .catch(function(err){toast(err.message||'Some deletions failed',true);loadFees();});
}
function bulkExportSelectedFees(){
  var ids=Object.keys(FEES_BULK_SELECTED);
  var rows=ids.length?FEES_CACHE.filter(function(f){return FEES_BULK_SELECTED[f.id];}):getFilteredFees();
  exportFeesRowsCsv(rows);
}
function openFeeModal(id){
  clearMsg('feeMsg');
  populateFeePersonDropdown();
  var f=id?FEES_CACHE.find(function(x){return x.id===id;}):null;
  document.getElementById('feeModalTitle').textContent=f?'Edit fee record':'Add fee record';
  document.getElementById('fId').value=f?f.id:'';
  if(f)document.getElementById('fPersonId').value=f.person_id;
  document.getElementById('fCategory').value=f?(f.category||''):'';
  document.getElementById('fTotal').value=f?f.amount:'';
  document.getElementById('fCurrency').value=f?(f.currency||'NPR'):'NPR';
  var cf=(f&&f.custom_fields)||{};
  document.getElementById('fDueDate').value=cf.dueDate||'';
  document.getElementById('fFine').value=cf.fine||0;
  document.getElementById('fRemarks').value=cf.remarks||'';
  document.getElementById('installmentsRows').innerHTML='';
  installmentRowCount=0;
  document.getElementById('installmentsHead').style.display='none';
  (cf.installments||[]).forEach(function(i){addInstallmentRow(i);});
  document.getElementById('fDeleteBtn').style.display=f?'inline-flex':'none';
  document.getElementById('fDupBtn').style.display=f?'inline-flex':'none';
  openModal('feeModal');
}
var installmentRowCount=0;
function addInstallmentRow(data){
  var idx=installmentRowCount++;
  document.getElementById('installmentsHead').style.display='grid';
  var wrap=document.getElementById('installmentsRows');
  var row=document.createElement('div');
  row.className='marks-row';
  row.id='irow'+idx;
  row.style.gridTemplateColumns='1fr 1fr 28px';
  row.innerHTML='<input placeholder="e.g. 1st installment" id="iLabel'+idx+'" value="'+(data&&data.label?escapeHtml(data.label):'')+'">'
    +'<input type="number" placeholder="Amount" id="iAmount'+idx+'" value="'+(data?data.amount:'')+'">'
    +'<span class="mr-remove" onclick="removeInstallmentRow('+idx+')">✕</span>';
  wrap.appendChild(row);
}
function removeInstallmentRow(idx){
  var el=document.getElementById('irow'+idx);
  if(el)el.remove();
  if(!document.getElementById('installmentsRows').children.length)document.getElementById('installmentsHead').style.display='none';
}
function collectInstallmentsFromForm(){
  var wrap=document.getElementById('installmentsRows');
  var out=[];
  Array.prototype.forEach.call(wrap.children,function(row){
    var idx=row.id.replace('irow','');
    var label=document.getElementById('iLabel'+idx).value.trim();
    if(!label)return;
    out.push({label:label,amount:parseFloat(document.getElementById('iAmount'+idx).value)||0});
  });
  return out;
}
function saveFee(){
  var id=document.getElementById('fId').value;
  var personId=document.getElementById('fPersonId').value;
  var total=parseFloat(document.getElementById('fTotal').value);
  if(!personId){showMsg('feeMsg','Choose a student.',true);return;}
  if(!total||total<=0){showMsg('feeMsg','Enter a valid total fee amount.',true);return;}
  var existing=id?FEES_CACHE.find(function(x){return x.id===id;}):null;
  var cf=Object.assign({},existing?existing.custom_fields:{});
  cf.dueDate=document.getElementById('fDueDate').value||null;
  cf.fine=parseFloat(document.getElementById('fFine').value)||0;
  cf.remarks=document.getElementById('fRemarks').value.trim()||null;
  cf.installments=collectInstallmentsFromForm();
  cf.paymentHistory=cf.paymentHistory||[];
  var body={person_id:personId,category:document.getElementById('fCategory').value.trim()||'Tuition',amount:total,currency:document.getElementById('fCurrency').value,custom_fields:cf};
  var req;
  if(id){
    req=patchTable('transactions','id=eq.'+id,body,true);
  }else{
    body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='fee';body.status='recorded';
    req=postTable('transactions',body,true);
  }
  req.then(function(){closeModal('feeModal');toast('✅ Saved');loadFees();})
    .catch(function(err){showMsg('feeMsg',err.message||'Could not save.',true);});
}
function exportFeesRowsCsv(rows){
  var header=['Student','Category','Currency','Total','Paid','Pending','Status','Due Date'];
  var lines=[header.join(',')];
  rows.forEach(function(f){
    var p=findPersonById(f.person_id)||{};
    var r=computeFeeStatus(f);
    lines.push([p.full_name,f.category,f.currency||'NPR',r.totalDue,r.paid,r.pending,r.status,(f.custom_fields&&f.custom_fields.dueDate)||''].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='fees.csv';a.click();
}
function exportFeesCsv(){
  exportFeesRowsCsv(getFilteredFees());
}
function deleteFeeConfirm(){
  var id=document.getElementById('fId').value;
  if(!id)return;
  var record=FEES_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  if(!confirm('Delete this fee record?'))return;
  closeModal('feeModal');
  deleteWithUndo('transactions',record,loadFees,'Fee record removed');
}
function duplicateFee(){
  var id=document.getElementById('fId').value;
  var record=FEES_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('feeModal');
  var cf=Object.assign({},record.custom_fields,{paymentHistory:[]});
  duplicateRecord('transactions',record,{custom_fields:cf},loadFees);
}
function computeAttendancePctLabel(personId){
  var rows=(ATTENDANCE_CACHE||[]).filter(function(a){return a.person_id===personId;});
  if(!rows.length)return '<span style="color:var(--ink-3);">No data yet — visit Attendance page</span>';
  var present=rows.filter(function(a){var s=(a.custom_fields||{}).status;return s==='present'||s==='late';}).length;
  var pct=Math.round((present/rows.length)*100);
  return '<span class="pf-badge '+(pct>=75?'pass':'fail')+'">'+pct+'%</span> ('+rows.length+' days recorded)';
}
function showFeeProfile(id){
  FEES_SELECTED_ID=id;
  renderFeesList();
  var f=FEES_CACHE.find(function(x){return x.id===id;});
  var card=document.getElementById('feeProfileCard');
  if(!f){card.style.display='none';return;}
  card.style.display='block';
  var p=findPersonById(f.person_id)||{};
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  var r=computeFeeStatus(f);
  var cf=f.custom_fields||{};
  var initials=(p.full_name||'?').trim().split(/\s+/).map(function(w){return w[0];}).slice(0,2).join('').toUpperCase();
  var html='<div class="rp-head"><div class="rp-avatar">'+initials+'</div><div>'
    +'<div class="rp-name">'+escapeHtml(p.full_name||'—')+'</div>'
    +'<div class="rp-meta">'+escapeHtml(f.category||'Fee')+' · '+escapeHtml(ac.batch||'—')+' · Roll '+escapeHtml(ac.rollNo||'—')+'</div>'
    +'</div></div>';
  html+='<table class="rp-table">'
    +'<tr><td style="color:var(--ink-3);">Total (incl. fine)</td><td>'+currencySymbol(f.currency)+r.totalDue.toLocaleString()+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">Paid</td><td>'+currencySymbol(f.currency)+r.paid.toLocaleString()+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">Pending</td><td>'+currencySymbol(f.currency)+r.pending.toLocaleString()+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">Due date</td><td>'+(cf.dueDate||'—')+'</td></tr>'
    +(cf.lastReminderSent?'<tr><td style="color:var(--ink-3);">Last reminder</td><td>'+cf.lastReminderSent+'</td></tr>':'')
    +'</table>';
  html+='<span class="pf-badge '+(r.status==='paid'?'pass':'fail')+'" style="font-size:12px;">'+r.status.toUpperCase()+'</span>';
  if(cf.remarks)html+='<p class="empty-hint">Remarks: '+escapeHtml(cf.remarks)+'</p>';
  var history=cf.paymentHistory||[];
  if(history.length){
    html+='<div class="modal-section-head" style="border-top:none;padding-top:0;">Payment history</div>';
    html+='<table class="rp-table"><tr><th>Date</th><th>Amount</th><th>Method</th><th>Note</th></tr>'
      +history.map(function(h){return '<tr><td>'+h.date+'</td><td>'+h.amount+'</td><td>'+escapeHtml(h.method||'')+'</td><td>'+escapeHtml(h.note||'')+'</td></tr>';}).join('')
      +'</table>';
  }
  html+='<div class="rp-actions">'
    +(r.pending>0?'<button class="btn btn-primary btn-sm" onclick="openPaymentModal(\''+f.id+'\')">💵 Record Payment</button>':'')
    +'<button class="btn btn-ghost btn-sm" onclick="downloadReceipt(\''+f.id+'\')">⬇️ Receipt</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="shareFeeWhatsApp(\''+f.id+'\')">💬 WhatsApp Reminder</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="shareFeeEmail(\''+f.id+'\')">✉️ Email Reminder</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="openPersonModal(\''+p.id+'\')" style="display:'+(p.id?'inline-flex':'none')+';">✏️ Edit Fee</button>'
    +'</div>';
  document.getElementById('feeProfile').innerHTML=html;
}
function openPaymentModal(feeId){
  document.getElementById('payFeeId').value=feeId;
  document.getElementById('payAmount').value='';
  document.getElementById('payDate').value=new Date().toISOString().slice(0,10);
  document.getElementById('payNote').value='';
  clearMsg('paymentMsg');
  openModal('paymentModal');
}
function recordPayment(){
  var feeId=document.getElementById('payFeeId').value;
  var amount=parseFloat(document.getElementById('payAmount').value);
  if(!amount||amount<=0){showMsg('paymentMsg','Enter a valid amount.',true);return;}
  var f=FEES_CACHE.find(function(x){return x.id===feeId;});
  if(!f)return;
  var cf=Object.assign({},f.custom_fields);
  cf.paymentHistory=(cf.paymentHistory||[]).concat([{
    date:document.getElementById('payDate').value,amount:amount,
    method:document.getElementById('payMethod').value,note:document.getElementById('payNote').value.trim()
  }]);
  patchTable('transactions','id=eq.'+feeId,{custom_fields:cf},true).then(function(){
    f.custom_fields=cf;
    closeModal('paymentModal');
    toast('✅ Payment recorded');
    loadFees();
    showFeeProfile(feeId);
  }).catch(function(err){showMsg('paymentMsg',err.message||'Could not record payment.',true);});
}
function buildFeeSummaryText(f){
  var p=findPersonById(f.person_id)||{};
  var r=computeFeeStatus(f);
  var cf=f.custom_fields||{};
  var cur=currencySymbol(f.currency);
  return [
    CTX.company_name,
    'Fee Reminder — '+(p.full_name||''),
    (f.category||'Fee')+': '+cur+r.totalDue.toLocaleString(),
    'Paid: '+cur+r.paid.toLocaleString()+' · Pending: '+cur+r.pending.toLocaleString(),
    cf.dueDate?('Due date: '+cf.dueDate):''
  ].filter(Boolean).join('\n');
}
function markReminderSent(feeId){
  var f=FEES_CACHE.find(function(x){return x.id===feeId;});
  if(!f)return;
  var cf=Object.assign({},f.custom_fields,{lastReminderSent:new Date().toISOString().slice(0,10)});
  patchTable('transactions','id=eq.'+feeId,{custom_fields:cf},true).then(function(){
    f.custom_fields=cf;
    if(FEES_SELECTED_ID===feeId)showFeeProfile(feeId);
  }).catch(function(){});
}
function shareFeeWhatsApp(feeId){
  var f=FEES_CACHE.find(function(x){return x.id===feeId;});
  if(!f)return;
  var p=findPersonById(f.person_id)||{};
  window.open('https://wa.me/'+(p.phone||'').replace(/[^0-9]/g,'')+'?text='+encodeURIComponent(buildFeeSummaryText(f)),'_blank');
  markReminderSent(feeId);
}
function shareFeeEmail(feeId){
  var f=FEES_CACHE.find(function(x){return x.id===feeId;});
  if(!f)return;
  var p=findPersonById(f.person_id)||{};
  window.location.href='mailto:'+(p.email||'')+'?subject='+encodeURIComponent('Fee Reminder')+'&body='+encodeURIComponent(buildFeeSummaryText(f));
  markReminderSent(feeId);
}
function downloadReceipt(feeId){
  var f=FEES_CACHE.find(function(x){return x.id===feeId;});
  if(!f)return;
  var p=findPersonById(f.person_id)||{};
  var r=computeFeeStatus(f);
  var t=getFeeReceiptTemplate();
  var brand=(CTX.config&&CTX.config.brand)||{};
  var logo=brand.logoUrl;
  var history=(f.custom_fields&&f.custom_fields.paymentHistory)||[];
  var html='<div style="font-family:'+t.font+';max-width:600px;margin:0 auto;">'
    +'<div style="text-align:center;margin-bottom:16px;border-bottom:3px solid '+t.color+';padding-bottom:14px;">'
    +(logo?'<img src="'+logo+'" style="width:52px;height:52px;object-fit:contain;margin-bottom:8px;">':'')
    +'<div style="font-size:18px;font-weight:700;">'+escapeHtml(t.headerText)+'</div>'
    +'<div style="font-size:13px;font-weight:600;margin-top:4px;color:'+t.color+';">'+escapeHtml(t.titleText)+'</div></div>'
    +'<table style="width:100%;font-size:12.5px;margin-bottom:14px;">'
    +'<tr><td style="color:#666;">Student</td><td style="text-align:right;font-weight:600;">'+escapeHtml(p.full_name||'-')+'</td></tr>'
    +'<tr><td style="color:#666;">Category</td><td style="text-align:right;">'+escapeHtml(f.category||'-')+'</td></tr>'
    +'<tr><td style="color:#666;">Date</td><td style="text-align:right;">'+new Date().toLocaleDateString()+'</td></tr>'
    +'</table>'
    +'<table style="width:100%;font-size:12.5px;border-collapse:collapse;">'
    +'<tr style="border-bottom:2px solid #333;"><th style="text-align:left;">Date</th><th style="text-align:right;">Amount</th><th style="text-align:right;">Method</th></tr>'
    +history.map(function(h){return '<tr style="border-bottom:1px solid #ddd;"><td>'+h.date+'</td><td style="text-align:right;">'+currencySymbol(f.currency)+h.amount+'</td><td style="text-align:right;">'+escapeHtml(h.method||'')+'</td></tr>';}).join('')
    +'</table>'
    +'<div style="text-align:center;margin-top:16px;font-size:15px;font-weight:700;color:'+t.color+';">Total Paid: '+currencySymbol(f.currency)+r.paid.toLocaleString()+' / Pending: '+currencySymbol(f.currency)+r.pending.toLocaleString()+'</div>'
    +'<div style="margin-top:18px;font-size:11px;color:#888;text-align:center;">'+escapeHtml(t.footerText)+'</div>'
    +'</div>';
  document.getElementById('printArea').innerHTML=html;
  setTimeout(function(){window.print();},80);
}
function renderFeeAnalysis(){
  var rows=getFilteredFees().map(computeFeeStatus);
  var paidTotal=rows.reduce(function(s,r){return s+r.paid;},0);
  var pendingTotal=rows.reduce(function(s,r){return s+r.pending;},0);
  document.getElementById('feePieChartHolder').innerHTML=(paidTotal+pendingTotal)>0?svgPie(Math.round(paidTotal),Math.round(pendingTotal),['Paid','Pending']):'<div class="empty-hint">No data yet</div>';
  var byBatch={};
  getFilteredFees().forEach(function(f){
    var p=findPersonById(f.person_id)||{};
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    var batch=ac.batch||'Unassigned';
    var r=computeFeeStatus(f);
    byBatch[batch]=(byBatch[batch]||0)+r.paid;
  });
  var barData=Object.keys(byBatch).map(function(b){return {label:b,value:Math.round(byBatch[b])};});
  document.getElementById('feeBarChartHolder').innerHTML=barData.length?svgBar(barData,{suffix:''}):'<div class="empty-hint">No data yet</div>';
}

// ------------------------------------------------------------
// LIBRARY MODULE (stored as activities.type='library_visit')
// ------------------------------------------------------------
var SIG_CTX=null,SIG_DRAWING=false,SIG_HAS_INK=false;
var LIB_PHOTO_BASE64=null,LIB_PHOTO_MIME=null;

function loadLibrary(){
  var tbody=document.getElementById('libTableBody');
  var key=cacheKeyFor('library');
  cacheGet(key).then(function(cached){
    if(cached&&cached.length&&!LIBRARY_CACHE.length){LIBRARY_CACHE=cached;renderLibraryList();}
    else if(!LIBRARY_CACHE.length){tbody.innerHTML='<tr><td colspan="7" class="empty-hint" style="padding:16px;">Loading…</td></tr>';}
  });
  Promise.all([
    getTable('activities','type=eq.library_visit&order=created_at.desc',true),
    PEOPLE_CACHE.length?Promise.resolve(PEOPLE_CACHE):getTable('people','order=full_name.asc',true)
  ]).then(function(res){
    LIBRARY_CACHE=res[0]||[];
    PEOPLE_CACHE=res[1]||PEOPLE_CACHE;
    cacheSet(key,LIBRARY_CACHE);
    renderLibraryList();
  }).catch(function(err){
    if(!LIBRARY_CACHE.length)tbody.innerHTML='<tr><td colspan="7" class="empty-hint" style="padding:16px;">Offline — nothing cached yet. '+(err.message||'')+'</td></tr>';
  });
}
function getFilteredLibrary(){
  var q=(document.getElementById('libSearch').value||'').trim().toLowerCase();
  var dateFilter=document.getElementById('libDateFilter').value;
  return LIBRARY_CACHE.filter(function(l){
    var cf=l.custom_fields||{};
    if(dateFilter && cf.date!==dateFilter)return false;
    if(!q)return true;
    var p=findPersonById(l.person_id)||{};
    var hay=[p.full_name,cf.serialNo].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
function computeDurationLabel(inTime,outTime){
  if(!inTime||!outTime)return '—';
  var a=inTime.split(':'),b=outTime.split(':');
  var mins=(parseInt(b[0])*60+parseInt(b[1]))-(parseInt(a[0])*60+parseInt(a[1]));
  if(mins<0)return '—';
  return Math.floor(mins/60)+'h '+(mins%60)+'m';
}
var LIBRARY_BULK_SELECTED={};
function renderLibraryList(){
  var rows=getFilteredLibrary();
  var tbody=document.getElementById('libTableBody');
  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="7" class="empty-hint" style="padding:16px;">No entries match. Tap "+ Add Entry" to create one.</td></tr>';
  }else{
    tbody.innerHTML=rows.map(function(l){
      var p=findPersonById(l.person_id)||{};
      var cf=l.custom_fields||{};
      var checked=LIBRARY_BULK_SELECTED[l.id]?'checked':'';
      return '<tr>'
        +'<td><input type="checkbox" onclick="toggleLibrarySelect(\''+l.id+'\')" '+checked+' style="width:auto;"></td>'
        +'<td>'+escapeHtml(cf.serialNo||'—')+'</td>'
        +'<td>'+escapeHtml(p.full_name||'—')+'</td>'
        +'<td>'+(cf.inTime||'—')+'</td>'
        +'<td>'+(cf.outTime||'—')+'</td>'
        +'<td>'+computeDurationLabel(cf.inTime,cf.outTime)+'</td>'
        +'<td><button class="btn btn-ghost btn-sm" style="width:auto;" onclick="openLibraryModal(\''+l.id+'\')">Edit</button></td>'
        +'</tr>';
    }).join('');
  }
  renderLibStats();
  renderLibAnalysis();
  updateLibraryBulkBar();
}
function toggleLibrarySelect(id){
  if(LIBRARY_BULK_SELECTED[id])delete LIBRARY_BULK_SELECTED[id];else LIBRARY_BULK_SELECTED[id]=true;
  updateLibraryBulkBar();
}
function clearLibrarySelection(){LIBRARY_BULK_SELECTED={};renderLibraryList();}
function updateLibraryBulkBar(){
  var bar=document.getElementById('libraryBulkBar');
  if(!bar)return;
  var count=Object.keys(LIBRARY_BULK_SELECTED).length;
  bar.style.display=count?'block':'none';
  if(count)document.getElementById('libraryBulkCount').textContent=count+' selected';
}
function bulkDeleteSelectedLibrary(){
  var ids=Object.keys(LIBRARY_BULK_SELECTED);
  if(!ids.length)return;
  if(!confirm('Delete '+ids.length+' selected entry(ies)? This cannot be undone.'))return;
  Promise.all(ids.map(function(id){return deleteTable('activities','id=eq.'+id,true);}))
    .then(function(){toast('✅ '+ids.length+' entry(ies) deleted');LIBRARY_BULK_SELECTED={};loadLibrary();})
    .catch(function(err){toast(err.message||'Some deletions failed',true);loadLibrary();});
}
function bulkExportSelectedLibrary(){
  var ids=Object.keys(LIBRARY_BULK_SELECTED);
  var rows=ids.length?LIBRARY_CACHE.filter(function(l){return LIBRARY_BULK_SELECTED[l.id];}):getFilteredLibrary();
  exportLibraryRowsCsv(rows);
}
function renderLibStats(){
  var rows=getFilteredLibrary();
  var today=new Date().toISOString().slice(0,10);
  var todayCount=rows.filter(function(l){return (l.custom_fields||{}).date===today;}).length;
  var withDuration=rows.map(function(l){
    var cf=l.custom_fields||{};
    if(!cf.inTime||!cf.outTime)return null;
    var a=cf.inTime.split(':'),b=cf.outTime.split(':');
    var mins=(parseInt(b[0])*60+parseInt(b[1]))-(parseInt(a[0])*60+parseInt(a[1]));
    return mins>=0?mins:null;
  }).filter(function(m){return m!=null;});
  var avgMins=withDuration.length?Math.round(withDuration.reduce(function(s,m){return s+m;},0)/withDuration.length):0;
  var stats=[
    {value:rows.length,label:'Total Entries'},
    {value:todayCount,label:'Today'},
    {value:(avgMins?Math.floor(avgMins/60)+'h '+(avgMins%60)+'m':'—'),label:'Avg Duration'}
  ];
  document.getElementById('libStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function renderLibAnalysis(){
  var rows=getFilteredLibrary();
  var byDate={};
  rows.forEach(function(l){
    var d=(l.custom_fields||{}).date||'Unknown';
    byDate[d]=(byDate[d]||0)+1;
  });
  var data=Object.keys(byDate).sort().slice(-10).map(function(d){return {label:d.slice(5),value:byDate[d]};});
  document.getElementById('libBarChartHolder').innerHTML=data.length?svgBar(data,{suffix:'',maxValue:Math.max.apply(null,data.map(function(d){return d.value;}))}):'<div class="empty-hint">No data yet</div>';
}
function populateLibraryPersonDropdown(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var sel=document.getElementById('lPersonId');
  sel.innerHTML=PEOPLE_CACHE.map(function(p){return '<option value="'+p.id+'">'+escapeHtml(p.full_name||'Unnamed')+'</option>';}).join('')
    ||'<option value="">No '+(term.entity_person_plural||'people').toLowerCase()+' yet</option>';
}

// ---- Signature pad (simple canvas drawing) ----
function initSignaturePad(){
  var canvas=document.getElementById('sigCanvas');
  var ratio=window.devicePixelRatio||1;
  canvas.width=canvas.clientWidth*ratio;
  canvas.height=canvas.clientHeight*ratio;
  SIG_CTX=canvas.getContext('2d');
  SIG_CTX.scale(ratio,ratio);
  SIG_CTX.strokeStyle='#12141a';
  SIG_CTX.lineWidth=2;
  SIG_CTX.lineCap='round';
  SIG_HAS_INK=false;
  function pos(e){
    var r=canvas.getBoundingClientRect();
    var t=(e.touches&&e.touches[0])||e;
    return {x:t.clientX-r.left,y:t.clientY-r.top};
  }
  function start(e){SIG_DRAWING=true;var p=pos(e);SIG_CTX.beginPath();SIG_CTX.moveTo(p.x,p.y);e.preventDefault();}
  function move(e){if(!SIG_DRAWING)return;var p=pos(e);SIG_CTX.lineTo(p.x,p.y);SIG_CTX.stroke();SIG_HAS_INK=true;e.preventDefault();}
  function end(){SIG_DRAWING=false;}
  canvas.onmousedown=start;canvas.onmousemove=move;canvas.onmouseup=end;canvas.onmouseleave=end;
  canvas.ontouchstart=start;canvas.ontouchmove=move;canvas.ontouchend=end;
}
function clearSignature(){
  var canvas=document.getElementById('sigCanvas');
  if(SIG_CTX)SIG_CTX.clearRect(0,0,canvas.width,canvas.height);
  SIG_HAS_INK=false;
}
function getSignatureDataUrl(){
  if(!SIG_HAS_INK)return null;
  return document.getElementById('sigCanvas').toDataURL('image/png');
}

// ---- Photo upload + Gemini vision extraction ----
function handleLibraryPhoto(e){
  var f=e.target.files[0];
  if(!f)return;
  var reader=new FileReader();
  reader.onload=function(){
    var fullDataUrl=reader.result;
    LIB_PHOTO_BASE64=fullDataUrl.split(',')[1];
    LIB_PHOTO_MIME=f.type||'image/jpeg';
    var wrap=document.getElementById('libPhotoPreviewWrap');
    document.getElementById('libPhotoPreview').src=fullDataUrl;
    wrap.style.display='block';
    extractLibraryPhotoData();
  };
  reader.readAsDataURL(f);
}
function extractLibraryPhotoData(){
  var statusEl=document.getElementById('libExtractStatus');
  statusEl.style.display='block';
  statusEl.textContent='Reading the photo with AI…';
  var prompt='This is a photo of a physical library visitor register page or a single entry. '
    +'Extract these fields if visible: Serial Number, Name, In Time (24hr HH:MM), Out Time (24hr HH:MM). '
    +'Reply ONLY as compact JSON like {"serialNo":"","name":"","inTime":"","outTime":""} — use empty string for anything not clearly visible. No other text.';
  callGeminiAssist(prompt,LIB_PHOTO_BASE64,LIB_PHOTO_MIME).then(function(text){
    var cleaned=text.replace(/```json|```/g,'').trim();
    var data={};
    try{data=JSON.parse(cleaned);}catch(e){/* leave fields as-is if parsing fails */}
    if(data.serialNo)document.getElementById('lSerial').value=data.serialNo;
    if(data.inTime)document.getElementById('lInTime').value=data.inTime;
    if(data.outTime)document.getElementById('lOutTime').value=data.outTime;
    if(data.name){
      var sel=document.getElementById('lPersonId');
      var match=Array.prototype.find.call(sel.options,function(o){return o.textContent.toLowerCase().indexOf(data.name.toLowerCase())>-1;});
      if(match)sel.value=match.value;
    }
    statusEl.textContent='✅ Read from photo — please double-check before saving.';
    setTimeout(function(){statusEl.style.display='none';},4000);
  }).catch(function(err){
    statusEl.textContent=err.message||'Could not read the photo — please fill in manually.';
  });
}

function openLibraryModal(id){
  clearMsg('libMsg');
  LIB_PHOTO_BASE64=null;LIB_PHOTO_MIME=null;
  document.getElementById('libPhotoPreviewWrap').style.display='none';
  document.getElementById('libPhotoInput').value='';
  document.getElementById('libExtractStatus').style.display='none';
  var loadPeoplePromise=PEOPLE_CACHE.length?Promise.resolve():getTable('people','order=full_name.asc',true).then(function(r){PEOPLE_CACHE=r||[];}).catch(function(){});
  loadPeoplePromise.then(populateLibraryPersonDropdown);
  var l=id?LIBRARY_CACHE.find(function(x){return x.id===id;}):null;
  var cf=(l&&l.custom_fields)||{};
  document.getElementById('libModalTitle').textContent=l?'Edit library entry':'Add library entry';
  document.getElementById('lId').value=l?l.id:'';
  document.getElementById('lSerial').value=cf.serialNo||'';
  if(l)document.getElementById('lPersonId').value=l.person_id||'';
  document.getElementById('lInTime').value=cf.inTime||'';
  document.getElementById('lOutTime').value=cf.outTime||'';
  document.getElementById('lDate').value=cf.date||new Date().toISOString().slice(0,10);
  document.getElementById('lDeleteBtn').style.display=l?'inline-flex':'none';
  document.getElementById('lDupBtn').style.display=l?'inline-flex':'none';
  openModal('libraryModal');
  setTimeout(function(){
    initSignaturePad();
    if(cf.signatureDataUrl){
      var img=new Image();
      img.onload=function(){SIG_CTX.drawImage(img,0,0,document.getElementById('sigCanvas').clientWidth,document.getElementById('sigCanvas').clientHeight);SIG_HAS_INK=true;};
      img.src=cf.signatureDataUrl;
    }
  },50);
}
function saveLibraryEntry(){
  var id=document.getElementById('lId').value;
  var personId=document.getElementById('lPersonId').value;
  if(!personId){showMsg('libMsg','Choose a person.',true);return;}
  var existing=id?LIBRARY_CACHE.find(function(x){return x.id===id;}):null;
  var cf=Object.assign({},existing?existing.custom_fields:{});
  cf.serialNo=document.getElementById('lSerial').value.trim()||null;
  cf.inTime=document.getElementById('lInTime').value||null;
  cf.outTime=document.getElementById('lOutTime').value||null;
  cf.date=document.getElementById('lDate').value||new Date().toISOString().slice(0,10);
  var sig=getSignatureDataUrl();
  if(sig)cf.signatureDataUrl=sig;
  if(LIB_PHOTO_BASE64)cf.sourcePhotoNote='Entry created/edited from an uploaded register photo';
  var body={person_id:personId,title:'Library Visit',stage:cf.outTime?'Checked Out':'Checked In',custom_fields:cf};
  var req;
  if(id){
    req=patchTable('activities','id=eq.'+id,body,true);
  }else{
    body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='library_visit';
    req=postTable('activities',body,true);
  }
  req.then(function(){closeModal('libraryModal');toast('✅ Saved');loadLibrary();})
    .catch(function(err){showMsg('libMsg',err.message||'Could not save.',true);});
}
function exportLibraryRowsCsv(rows){
  var header=['Serial No','Name','In Time','Out Time','Duration','Date'];
  var lines=[header.join(',')];
  rows.forEach(function(l){
    var p=findPersonById(l.person_id)||{};
    var cf=l.custom_fields||{};
    lines.push([cf.serialNo,p.full_name,cf.inTime,cf.outTime,computeDurationLabel(cf.inTime,cf.outTime),cf.date].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='library.csv';a.click();
}
function exportLibraryCsv(){
  exportLibraryRowsCsv(getFilteredLibrary());
}
function deleteLibraryConfirm(){
  var id=document.getElementById('lId').value;
  if(!id)return;
  var record=LIBRARY_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  if(!confirm('Delete this library entry?'))return;
  closeModal('libraryModal');
  deleteWithUndo('activities',record,loadLibrary,'Library entry removed');
}
function duplicateLibraryEntry(){
  var id=document.getElementById('lId').value;
  var record=LIBRARY_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('libraryModal');
  duplicateRecord('activities',record,{},loadLibrary);
}

// ------------------------------------------------------------
// MARKETING HUB (stored as activities.type='marketing_asset')
// ------------------------------------------------------------
var MK_MEDIA_DATA_URL=null;
function loadMarketing(){
  var grid=document.getElementById('mktGrid');
  var key=cacheKeyFor('marketing');
  cacheGet(key).then(function(cached){
    if(cached&&cached.length&&!MARKETING_CACHE.length){MARKETING_CACHE=cached;populateMktFilters();renderMarketingGrid();}
    else if(!MARKETING_CACHE.length){grid.innerHTML='<div class="empty-hint">Loading…</div>';}
  });
  getTable('activities','type=eq.marketing_asset&order=created_at.desc',true).then(function(rows){
    MARKETING_CACHE=rows||[];
    cacheSet(key,MARKETING_CACHE);
    populateMktFilters();
    renderMarketingGrid();
  }).catch(function(err){
    if(!MARKETING_CACHE.length)grid.innerHTML='<div class="empty-hint">Offline — nothing cached yet. '+(err.message||'')+'</div>';
  });
}
function populateMktFilters(){
  var platforms={},campaigns={};
  MARKETING_CACHE.forEach(function(m){
    var cf=m.custom_fields||{};
    if(cf.platform)platforms[cf.platform]=true;
    if(cf.campaign)campaigns[cf.campaign]=true;
  });
  var pSel=document.getElementById('mktPlatformFilter'),cSel=document.getElementById('mktCampaignFilter');
  var curP=pSel.value,curC=cSel.value;
  pSel.innerHTML='<option value="">All</option>'+Object.keys(platforms).sort().map(function(p){return '<option value="'+escapeHtml(p)+'">'+escapeHtml(p)+'</option>';}).join('');
  cSel.innerHTML='<option value="">All</option>'+Object.keys(campaigns).sort().map(function(c){return '<option value="'+escapeHtml(c)+'">'+escapeHtml(c)+'</option>';}).join('');
  pSel.value=curP;cSel.value=curC;
}
function getFilteredMarketing(){
  var q=(document.getElementById('mktSearch').value||'').trim().toLowerCase();
  var type=document.getElementById('mktTypeFilter').value;
  var platform=document.getElementById('mktPlatformFilter').value;
  var campaign=document.getElementById('mktCampaignFilter').value;
  return MARKETING_CACHE.filter(function(m){
    var cf=m.custom_fields||{};
    if(type && cf.assetType!==type)return false;
    if(platform && cf.platform!==platform)return false;
    if(campaign && cf.campaign!==campaign)return false;
    if(!q)return true;
    var hay=[cf.caption,cf.campaign,cf.hashtags].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
function renderMktStats(){
  var rows=getFilteredMarketing();
  var totalReach=rows.reduce(function(s,m){return s+(parseFloat(m.custom_fields&&m.custom_fields.reach)||0);},0);
  var totalDownloads=rows.reduce(function(s,m){return s+(parseFloat(m.custom_fields&&m.custom_fields.downloads)||0);},0);
  var campaigns={};
  rows.forEach(function(m){var c=(m.custom_fields&&m.custom_fields.campaign)||null;if(c)campaigns[c]=true;});
  var stats=[
    {value:rows.length,label:'Total Assets'},
    {value:totalReach.toLocaleString(),label:'Total Reach'},
    {value:totalDownloads.toLocaleString(),label:'Downloads/Shares'},
    {value:Object.keys(campaigns).length,label:'Campaigns'}
  ];
  document.getElementById('mktStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
var MKT_TYPE_ICON={image:'🖼️',video:'🎬',poster:'📰',caption:'💬'};
var MARKETING_BULK_SELECTED={};
function renderMarketingGrid(){
  var rows=getFilteredMarketing();
  var grid=document.getElementById('mktGrid');
  if(!rows.length){
    grid.innerHTML='<div class="empty-hint">No assets match. Tap "+ Add Asset" to create the first one.</div>';
  }else{
    grid.innerHTML=rows.map(function(m,i){
      var cf=m.custom_fields||{};
      var thumb=(cf.assetType==='image'||cf.assetType==='poster')&&cf.mediaDataUrl
        ?'<img class="mkt-thumb" src="'+cf.mediaDataUrl+'">'
        :'<div class="mkt-thumb-ph">'+(MKT_TYPE_ICON[cf.assetType]||'📁')+'</div>';
      var checked=MARKETING_BULK_SELECTED[m.id]?'checked':'';
      return '<div class="rail-card mkt-card" style="animation-delay:'+(i*0.03).toFixed(2)+'s;position:relative;">'
        +'<input type="checkbox" onclick="event.stopPropagation();toggleMarketingSelect(\''+m.id+'\')" '+checked+' style="position:absolute;top:8px;left:8px;width:auto;z-index:2;">'
        +'<div onclick="showMarketingDetail(\''+m.id+'\')">'
        +thumb
        +'<div class="mkt-card-body">'
        +'<div class="mkt-caption">'+escapeHtml(cf.caption||cf.campaign||'Untitled')+'</div>'
        +'<div class="mkt-meta"><span class="mkt-platform-chip">'+escapeHtml(cf.platform||'—')+'</span><span>👁 '+(cf.reach||0)+' · ⬇ '+(cf.downloads||0)+'</span></div>'
        +'</div></div></div>';
    }).join('');
  }
  renderMktStats();
  renderCampaignHistory();
  renderPlatformHistory();
  renderMktAnalysis();
  updateMarketingBulkBar();
}
function toggleMarketingSelect(id){
  if(MARKETING_BULK_SELECTED[id])delete MARKETING_BULK_SELECTED[id];else MARKETING_BULK_SELECTED[id]=true;
  updateMarketingBulkBar();
}
function clearMarketingSelection(){MARKETING_BULK_SELECTED={};renderMarketingGrid();}
function updateMarketingBulkBar(){
  var bar=document.getElementById('marketingBulkBar');
  if(!bar)return;
  var count=Object.keys(MARKETING_BULK_SELECTED).length;
  bar.style.display=count?'block':'none';
  if(count)document.getElementById('marketingBulkCount').textContent=count+' selected';
}
function bulkDeleteSelectedMarketing(){
  var ids=Object.keys(MARKETING_BULK_SELECTED);
  if(!ids.length)return;
  if(!confirm('Delete '+ids.length+' selected asset(s)? This cannot be undone.'))return;
  Promise.all(ids.map(function(id){return deleteTable('activities','id=eq.'+id,true);}))
    .then(function(){toast('✅ '+ids.length+' asset(s) deleted');MARKETING_BULK_SELECTED={};loadMarketing();})
    .catch(function(err){toast(err.message||'Some deletions failed',true);loadMarketing();});
}
function bulkExportSelectedMarketing(){
  var ids=Object.keys(MARKETING_BULK_SELECTED);
  var rows=ids.length?MARKETING_CACHE.filter(function(m){return MARKETING_BULK_SELECTED[m.id];}):getFilteredMarketing();
  exportMarketingRowsCsv(rows);
}
function renderCampaignHistory(){
  var rows=getFilteredMarketing();
  var byCampaign={};
  rows.forEach(function(m){
    var cf=m.custom_fields||{};
    var c=cf.campaign||'Uncategorized';
    byCampaign[c]=byCampaign[c]||{count:0,reach:0,downloads:0};
    byCampaign[c].count++;
    byCampaign[c].reach+=parseFloat(cf.reach)||0;
    byCampaign[c].downloads+=parseFloat(cf.downloads)||0;
  });
  var keys=Object.keys(byCampaign);
  document.getElementById('mktCampaignHistory').innerHTML=keys.length?keys.map(function(c){
    var d=byCampaign[c];
    return '<div class="history-row"><span class="h-name">'+escapeHtml(c)+'</span><span class="h-stats"><span>'+d.count+' assets</span><span>👁 '+d.reach.toLocaleString()+'</span><span>⬇ '+d.downloads.toLocaleString()+'</span></span></div>';
  }).join(''):'<div class="empty-hint">No campaigns yet.</div>';
}
function renderPlatformHistory(){
  var rows=getFilteredMarketing();
  var byPlatform={};
  rows.forEach(function(m){
    var cf=m.custom_fields||{};
    var p=cf.platform||'Unspecified';
    byPlatform[p]=byPlatform[p]||{count:0,reach:0};
    byPlatform[p].count++;
    byPlatform[p].reach+=parseFloat(cf.reach)||0;
  });
  var keys=Object.keys(byPlatform);
  document.getElementById('mktPlatformHistory').innerHTML=keys.length?keys.map(function(p){
    var d=byPlatform[p];
    return '<div class="history-row"><span class="h-name">'+escapeHtml(p)+'</span><span class="h-stats"><span>'+d.count+' posts</span><span>👁 '+d.reach.toLocaleString()+'</span></span></div>';
  }).join(''):'<div class="empty-hint">No posts yet.</div>';
}
function renderMktAnalysis(){
  var rows=getFilteredMarketing();
  var byPlatform={};
  rows.forEach(function(m){
    var cf=m.custom_fields||{};
    var p=cf.platform||'Unspecified';
    byPlatform[p]=(byPlatform[p]||0)+(parseFloat(cf.reach)||0);
  });
  var reachData=Object.keys(byPlatform).map(function(p){return {label:p,value:Math.round(byPlatform[p])};});
  document.getElementById('mktReachChartHolder').innerHTML=reachData.length?svgBar(reachData,{suffix:''}):'<div class="empty-hint">No data yet</div>';

  var byType={};
  rows.forEach(function(m){var t=(m.custom_fields&&m.custom_fields.assetType)||'other';byType[t]=(byType[t]||0)+1;});
  var typeData=Object.keys(byType).map(function(t){return {label:capitalize(t),value:byType[t]};});
  document.getElementById('mktTypeChartHolder').innerHTML=typeData.length?svgBar(typeData,{suffix:'',maxValue:Math.max.apply(null,typeData.map(function(d){return d.value;}))}):'<div class="empty-hint">No data yet</div>';
}
function toggleMarketingMediaFields(){
  var type=document.getElementById('mkType').value;
  document.getElementById('mkMediaFieldWrap').style.display=(type==='image'||type==='poster')?'block':'none';
}
function handleMarketingMedia(e){
  var f=e.target.files[0];
  if(!f)return;
  compressImage(f,600,0.85).then(function(dataUrl){
    MK_MEDIA_DATA_URL=dataUrl;
    var prev=document.getElementById('mkMediaPreview');
    prev.src=dataUrl;prev.style.display='block';
  });
}
function compressImage(file,maxDim,quality){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(){
      var img=new Image();
      img.onload=function(){
        var scale=Math.min(1,maxDim/Math.max(img.width,img.height));
        var canvas=document.createElement('canvas');
        canvas.width=img.width*scale;canvas.height=img.height*scale;
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',quality||0.85));
      };
      img.onerror=reject;
      img.src=reader.result;
    };
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}
function generateMarketingCaption(){
  var campaign=document.getElementById('mkCampaign').value.trim();
  var platform=document.getElementById('mkPlatform').value;
  var term=(CTX.config&&CTX.config.terminology)||{};
  var prompt='Write a short, engaging social media caption for '+platform+' promoting "'+(campaign||(term.org_label||'our organization'))
    +'" for '+CTX.company_name+' ('+humanizeVertical(CTX.vertical)+'). Keep it under 40 words, friendly tone, no hashtags in this part.';
  toast('Generating caption…');
  callGeminiAssist(prompt).then(function(text){
    document.getElementById('mkCaption').value=text.trim();
  }).catch(function(err){toast(err.message||'Could not generate caption',true);});
}
function generateMarketingHashtags(){
  var caption=document.getElementById('mkCaption').value.trim()||document.getElementById('mkCampaign').value.trim();
  if(!caption){toast('Write a caption or campaign name first',true);return;}
  var prompt='Suggest 8-10 relevant, popular social media hashtags for this post (space separated, each starting with #, no explanation):\n\n'+caption;
  toast('Generating hashtags…');
  callGeminiAssist(prompt).then(function(text){
    document.getElementById('mkHashtags').value=text.trim().replace(/\n/g,' ');
  }).catch(function(err){toast(err.message||'Could not generate hashtags',true);});
}
function generateMarketingIdea(){
  var platform=document.getElementById('mkPlatform').value;
  var term=(CTX.config&&CTX.config.terminology)||{};
  var prompt='Suggest one creative, specific social media post idea (concept + caption draft) for '+platform+', for a '
    +humanizeVertical(CTX.vertical)+' organization called '+CTX.company_name+'. Keep it practical and postable this week.';
  toast('Generating idea…');
  callGeminiAssist(prompt).then(function(text){
    document.getElementById('mkCaption').value=text.trim();
  }).catch(function(err){toast(err.message||'Could not generate idea',true);});
}
function openMarketingModal(id){
  clearMsg('mktMsg');
  MK_MEDIA_DATA_URL=null;
  var m=id?MARKETING_CACHE.find(function(x){return x.id===id;}):null;
  var cf=(m&&m.custom_fields)||{};
  document.getElementById('mktModalTitle').textContent=m?'Edit asset':'Add marketing asset';
  document.getElementById('mkId').value=m?m.id:'';
  document.getElementById('mkType').value=cf.assetType||'image';
  document.getElementById('mkPlatform').value=cf.platform||'Instagram';
  document.getElementById('mkCampaign').value=cf.campaign||'';
  document.getElementById('mkCaption').value=cf.caption||'';
  document.getElementById('mkHashtags').value=cf.hashtags||'';
  document.getElementById('mkVideoLink').value=cf.videoLink||'';
  document.getElementById('mkDate').value=cf.postedDate||new Date().toISOString().slice(0,10);
  document.getElementById('mkReach').value=cf.reach||0;
  document.getElementById('mkDownloads').value=cf.downloads||0;
  document.getElementById('mkNotes').value=cf.notes||'';
  var prev=document.getElementById('mkMediaPreview');
  if(cf.mediaDataUrl){prev.src=cf.mediaDataUrl;prev.style.display='block';}else{prev.style.display='none';}
  document.getElementById('mkDeleteBtn').style.display=m?'inline-flex':'none';
  document.getElementById('mkDupBtn').style.display=m?'inline-flex':'none';
  toggleMarketingMediaFields();
  openModal('marketingModal');
}
function saveMarketingAsset(){
  var id=document.getElementById('mkId').value;
  var existing=id?MARKETING_CACHE.find(function(x){return x.id===id;}):null;
  var cf=Object.assign({},existing?existing.custom_fields:{});
  cf.assetType=document.getElementById('mkType').value;
  cf.platform=document.getElementById('mkPlatform').value;
  cf.campaign=document.getElementById('mkCampaign').value.trim()||null;
  cf.caption=document.getElementById('mkCaption').value.trim()||null;
  cf.hashtags=document.getElementById('mkHashtags').value.trim()||null;
  cf.videoLink=document.getElementById('mkVideoLink').value.trim()||null;
  cf.postedDate=document.getElementById('mkDate').value||null;
  cf.reach=parseFloat(document.getElementById('mkReach').value)||0;
  cf.downloads=parseFloat(document.getElementById('mkDownloads').value)||0;
  cf.notes=document.getElementById('mkNotes').value.trim()||null;
  if(MK_MEDIA_DATA_URL)cf.mediaDataUrl=MK_MEDIA_DATA_URL;
  var body={title:cf.campaign||cf.caption||'Marketing Asset',custom_fields:cf};
  var req;
  if(id){
    req=patchTable('activities','id=eq.'+id,body,true);
  }else{
    body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='marketing_asset';
    req=postTable('activities',body,true);
  }
  req.then(function(){closeModal('marketingModal');toast('✅ Saved');loadMarketing();})
    .catch(function(err){showMsg('mktMsg',err.message||'Could not save.',true);});
}
function exportMarketingRowsCsv(rows){
  var header=['Type','Platform','Campaign','Caption','Reach','Downloads','Posted Date'];
  var lines=[header.join(',')];
  rows.forEach(function(m){
    var cf=m.custom_fields||{};
    lines.push([cf.assetType,cf.platform,cf.campaign,cf.caption,cf.reach,cf.downloads,cf.postedDate].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='marketing.csv';a.click();
}
function exportMarketingCsv(){
  exportMarketingRowsCsv(getFilteredMarketing());
}
function deleteMarketingConfirm(){
  var id=document.getElementById('mkId').value;
  if(!id)return;
  var record=MARKETING_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  if(!confirm('Delete this marketing asset?'))return;
  closeModal('marketingModal');
  deleteWithUndo('activities',record,loadMarketing,'Marketing asset removed');
}
function duplicateMarketingAsset(){
  var id=document.getElementById('mkId').value;
  var record=MARKETING_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('marketingModal');
  duplicateRecord('activities',record,{},loadMarketing);
}
function showMarketingDetail(id){
  var m=MARKETING_CACHE.find(function(x){return x.id===id;});
  if(!m)return;
  var cf=m.custom_fields||{};
  var thumb=(cf.assetType==='image'||cf.assetType==='poster')&&cf.mediaDataUrl
    ?'<img src="'+cf.mediaDataUrl+'" style="width:100%;border-radius:10px;margin-bottom:12px;">':'';
  var html=thumb
    +'<div class="rp-meta" style="margin-bottom:8px;">'+escapeHtml(cf.platform||'—')+' · '+escapeHtml(cf.campaign||'No campaign')+'</div>'
    +'<div style="font-size:13px;margin-bottom:10px;white-space:pre-wrap;">'+escapeHtml(cf.caption||'')+'</div>'
    +(cf.hashtags?'<div style="font-size:12px;color:var(--accent);margin-bottom:10px;">'+escapeHtml(cf.hashtags)+'</div>':'')
    +(cf.videoLink?'<div style="margin-bottom:10px;"><a href="'+cf.videoLink+'" target="_blank">🔗 Open link</a></div>':'')
    +'<table class="rp-table"><tr><td style="color:var(--ink-3);">Reach</td><td>'+(cf.reach||0).toLocaleString()+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">Downloads/Shares</td><td>'+(cf.downloads||0).toLocaleString()+'</td></tr>'
    +'<tr><td style="color:var(--ink-3);">Posted</td><td>'+(cf.postedDate||'—')+'</td></tr></table>'
    +(cf.notes?'<p class="empty-hint">'+escapeHtml(cf.notes)+'</p>':'')
    +'<div class="rp-actions">'
    +'<button class="btn btn-primary btn-sm" onclick="closeModal(\'marketingDetailModal\');openMarketingModal(\''+m.id+'\')">✏️ Edit</button>'
    +'<button class="btn btn-ghost btn-sm" onclick="aiReportMarketingAsset(\''+m.id+'\')">✨ AI Report</button>'
    +'</div>';
  document.getElementById('mktDetailBody').innerHTML=html;
  openModal('marketingDetailModal');
}
function aiReportMarketingAsset(id){
  var m=MARKETING_CACHE.find(function(x){return x.id===id;});
  if(!m)return;
  var cf=m.custom_fields||{};
  var text='Platform: '+(cf.platform||'—')+'\nCampaign: '+(cf.campaign||'—')+'\nCaption: '+(cf.caption||'—')
    +'\nReach: '+(cf.reach||0)+'\nDownloads/Shares: '+(cf.downloads||0);
  closeModal('marketingDetailModal');
  openAiPanel(text);
  setAiMode('report');
}

// ------------------------------------------------------------
// REPORT BUILDER — cross-cutting, fully customizable export engine
// ------------------------------------------------------------
var RB_CUSTOM_BLOCKS=[];
var RB_AI_SUMMARY=null;
var RB_LAST_HTML=null;
var RB_LAST_TEXT=null;

var RB_SECTIONS=[
  {key:'people',label:'People — status overview'},
  {key:'activities',label:'Activities — pipeline overview'},
  {key:'results',label:'Results — pass/fail & averages'},
  {key:'fees',label:'Fees — collections overview'},
  {key:'library',label:'Library — visit overview'},
  {key:'marketing',label:'Marketing — reach & campaigns'}
];
function initReportBuilder(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  document.getElementById('rbTitle').value=document.getElementById('rbTitle').value||(CTX.company_name+' — Report');
  var wrap=document.getElementById('rbSectionChecks');
  wrap.innerHTML=RB_SECTIONS.map(function(s){
    var label=s.label.replace('People',term.entity_person_plural||'People').replace('Activities',term.entity_activity_plural||'Activities');
    return '<label class="rb-check-row"><input type="checkbox" id="rbSec_'+s.key+'" checked> '+label+'</label>';
  }).join('');
  renderCustomBlocks();
}
function addCustomTextBlock(){
  RB_CUSTOM_BLOCKS.push({heading:'',text:''});
  renderCustomBlocks();
}
function removeCustomTextBlock(i){
  RB_CUSTOM_BLOCKS.splice(i,1);
  renderCustomBlocks();
}
function renderCustomBlocks(){
  var wrap=document.getElementById('rbCustomBlocks');
  wrap.innerHTML=RB_CUSTOM_BLOCKS.map(function(b,i){
    return '<div class="rb-custom-block">'
      +'<input class="gi" placeholder="Heading" value="'+escapeHtml(b.heading)+'" oninput="RB_CUSTOM_BLOCKS['+i+'].heading=this.value">'
      +'<textarea class="ai-textarea" style="min-height:50px;" placeholder="Text" oninput="RB_CUSTOM_BLOCKS['+i+'].text=this.value">'+escapeHtml(b.text)+'</textarea>'
      +'<button type="button" class="btn btn-ghost btn-sm" onclick="removeCustomTextBlock('+i+')">Remove block</button>'
      +'</div>';
  }).join('')||'<div class="empty-hint">No custom blocks yet.</div>';
}
function buildReportSectionsData(){
  var term=(CTX.config&&CTX.config.terminology)||{};
  var sections=[];
  if(document.getElementById('rbSec_people')&&document.getElementById('rbSec_people').checked){
    var byStatus={};
    PEOPLE_CACHE.forEach(function(p){byStatus[p.status||'active']=(byStatus[p.status||'active']||0)+1;});
    sections.push({heading:(term.entity_person_plural||'People')+' Overview',
      lines:['Total: '+PEOPLE_CACHE.length].concat(Object.keys(byStatus).map(function(s){return capitalize(s)+': '+byStatus[s];}))});
  }
  if(document.getElementById('rbSec_activities')&&document.getElementById('rbSec_activities').checked){
    var byStage={};
    ACTIVITIES_CACHE.forEach(function(a){byStage[a.stage]=(byStage[a.stage]||0)+1;});
    sections.push({heading:(term.entity_activity_plural||'Activities')+' Pipeline',
      lines:Object.keys(byStage).length?Object.keys(byStage).map(function(s){return s+': '+byStage[s];}):['No activities yet']});
  }
  if(document.getElementById('rbSec_results')&&document.getElementById('rbSec_results').checked){
    var withResult=PEOPLE_CACHE.map(function(p){return computeResult(p.custom_fields);}).filter(Boolean);
    var pass=withResult.filter(function(r){return r.pass;}).length;
    var avg=withResult.length?Math.round(withResult.reduce(function(s,r){return s+r.pct;},0)/withResult.length):0;
    sections.push({heading:'Results Overview',
      lines:['Students with marks: '+withResult.length,'Pass: '+pass+' · Fail: '+(withResult.length-pass),'Average: '+avg+'%']});
  }
  if(document.getElementById('rbSec_fees')&&document.getElementById('rbSec_fees').checked){
    var feeRows=(FEES_CACHE||[]).map(computeFeeStatus);
    var collected=feeRows.reduce(function(s,r){return s+r.paid;},0);
    var pending=feeRows.reduce(function(s,r){return s+r.pending;},0);
    sections.push({heading:'Fees Overview',
      lines:['Fee records: '+feeRows.length,'Collected: '+collected.toLocaleString(),'Pending: '+pending.toLocaleString()]});
  }
  if(document.getElementById('rbSec_library')&&document.getElementById('rbSec_library').checked){
    sections.push({heading:'Library Overview',
      lines:['Total entries: '+(LIBRARY_CACHE||[]).length]});
  }
  if(document.getElementById('rbSec_marketing')&&document.getElementById('rbSec_marketing').checked){
    var totalReach=(MARKETING_CACHE||[]).reduce(function(s,m){return s+(parseFloat(m.custom_fields&&m.custom_fields.reach)||0);},0);
    sections.push({heading:'Marketing Overview',
      lines:['Total assets: '+(MARKETING_CACHE||[]).length,'Total reach: '+totalReach.toLocaleString()]});
  }
  return sections;
}
function ensureAllDataLoaded(){
  return Promise.all([
    getTable('people','order=full_name.asc',true).then(function(r){PEOPLE_CACHE=r||[];}).catch(function(){}),
    getTable('activities','type=eq.activity&order=created_at.desc',true).then(function(r){ACTIVITIES_CACHE=r||[];}).catch(function(){}),
    getTable('transactions','type=eq.fee&order=created_at.desc',true).then(function(r){FEES_CACHE=r||[];}).catch(function(){}),
    getTable('activities','type=eq.library_visit&order=created_at.desc',true).then(function(r){LIBRARY_CACHE=r||[];}).catch(function(){}),
    getTable('activities','type=eq.marketing_asset&order=created_at.desc',true).then(function(r){MARKETING_CACHE=r||[];}).catch(function(){}),
    getTable('activities','type=eq.attendance&order=created_at.desc',true).then(function(r){ATTENDANCE_CACHE=r||[];}).catch(function(){}),
    getTable('transactions','type=eq.expense&order=created_at.desc',true).then(function(r){EXPENSES_CACHE=r||[];}).catch(function(){}),
    getTable('activities','type=eq.hostel_room&order=created_at.desc',true).then(function(r){HOSTEL_ROOMS=r||[];}).catch(function(){}),
    getTable('activities','type=eq.hostel_issue&order=created_at.desc',true).then(function(r){HOSTEL_ISSUES=r||[];}).catch(function(){}),
    getTable('activities','type=eq.hostel_mess&order=created_at.desc',true).then(function(r){HOSTEL_MESS=r||[];}).catch(function(){}),
    getTable('activities','type=eq.hostel_leave&order=created_at.desc',true).then(function(r){HOSTEL_LEAVE=r||[];}).catch(function(){}),
    getTable('activities','type=eq.care_dispute&order=created_at.desc',true).then(function(r){CARE_DISPUTES=r||[];}).catch(function(){}),
    getTable('activities','type=eq.care_complaint&order=created_at.desc',true).then(function(r){CARE_COMPLAINTS=r||[];}).catch(function(){}),
    getTable('activities','type=eq.care_mentor&order=created_at.desc',true).then(function(r){CARE_MENTOR=r||[];}).catch(function(){}),
    getTable('activities','type=eq.cold_contact&order=created_at.desc',true).then(function(r){CC_CONTACTS=r||[];}).catch(function(){}),
    getTable('activities','type=eq.cold_call_log&order=created_at.desc',true).then(function(r){CC_CALL_LOGS=r||[];}).catch(function(){}),
    getTable('activities','type=eq.coordinator_shift&order=created_at.desc',true).then(function(r){COORD_SHIFTS=r||[];}).catch(function(){}),
    getTable('activities','type=eq.visitor&order=created_at.desc',true).then(function(r){VISITORS_CACHE=r||[];}).catch(function(){})
  ]);
}

// ------------------------------------------------------------
// GOOGLE DRIVE BACKUP
// ------------------------------------------------------------
// Scope is deliberately 'drive.file' — the most restrictive Drive
// scope Google offers: this app can only see/touch files IT creates,
// never the rest of the user's Drive. No server-side token storage;
// the access token lives only in this tab's memory and expires in
// ~1 hour, so each backup session needs (at most) one Google consent
// prompt. This is the correct, minimal-trust design for a client-only
// (no backend) integration.
var GOOGLE_CLIENT_ID='190330738-1is7qojb509potnqgo3bs3758o5ppfuv.apps.googleusercontent.com';
var GOOGLE_DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file';
var gDriveTokenClient=null;
var gDriveAccessToken=null;

function connectGoogleDrive(){
  if(!window.google||!google.accounts||!google.accounts.oauth2){
    showMsg('driveMsg','Google sign-in is still loading — try again in a second.',true);
    return;
  }
  if(!gDriveTokenClient){
    gDriveTokenClient=google.accounts.oauth2.initTokenClient({
      client_id:GOOGLE_CLIENT_ID,
      scope:GOOGLE_DRIVE_SCOPE,
      callback:function(resp){
        if(resp.error){showMsg('driveMsg','Could not connect — '+resp.error,true);return;}
        gDriveAccessToken=resp.access_token;
        document.getElementById('driveStatus').textContent='✅ Connected — ready to back up.';
        document.getElementById('driveBackupBtn').style.display='inline-flex';
        document.getElementById('driveConnectBtn').textContent='Reconnect';
        showMsg('driveMsg','Connected! Your Drive access token is only kept in this browser tab.',false);
      }
    });
  }
  gDriveTokenClient.requestAccessToken();
}
function backupToDrive(){
  if(!gDriveAccessToken){showMsg('driveMsg','Connect Google Drive first.',true);return;}
  var btn=document.getElementById('driveBackupBtn');
  btn.disabled=true;btn.textContent='Backing up…';
  ensureAllDataLoaded().then(function(){
    var payload={
      exportedAt:new Date().toISOString(),
      organization:CTX.company_name,
      vertical:CTX.vertical,
      people:PEOPLE_CACHE,
      activities:ACTIVITIES_CACHE,
      fees:FEES_CACHE,
      library:LIBRARY_CACHE,
      marketing:MARKETING_CACHE,
      tenantConfig:CTX.config
    };
    var fileName='verticore-backup-'+(CTX.company_name||'org').replace(/[^a-z0-9]+/gi,'-')+'-'+new Date().toISOString().slice(0,10)+'.json';
    var boundary='verticore-boundary-'+Date.now();
    var metadata={name:fileName,mimeType:'application/json'};
    var body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)
      +'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(payload,null,2)
      +'\r\n--'+boundary+'--';
    return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{
      method:'POST',
      headers:{'Authorization':'Bearer '+gDriveAccessToken,'Content-Type':'multipart/related; boundary='+boundary},
      body:body
    });
  }).then(function(r){
    if(!r.ok)return r.json().then(function(j){throw new Error((j.error&&j.error.message)||'Upload failed');});
    return r.json();
  }).then(function(file){
    showMsg('driveMsg','✅ Backed up as "'+file.name+'" in your Google Drive.',false);
    toast('✅ Backup saved to Google Drive');
  }).catch(function(err){
    if(String(err.message||'').indexOf('invalid_grant')>-1||String(err).indexOf('401')>-1){
      showMsg('driveMsg','Your Drive session expired — tap Reconnect and try again.',true);
      gDriveAccessToken=null;
      document.getElementById('driveBackupBtn').style.display='none';
      document.getElementById('driveStatus').textContent='Session expired — reconnect.';
    }else{
      showMsg('driveMsg',err.message||'Backup failed.',true);
    }
  }).finally(function(){
    btn.disabled=false;btn.textContent='☁️ Backup Now';
  });
}
function generateReportAiSummary(){
  toast('Loading latest data…');
  ensureAllDataLoaded().then(function(){
    var sections=buildReportSectionsData();
    var snapshot=sections.map(function(s){return s.heading+': '+s.lines.join(', ');}).join('\n');
    if(!snapshot){toast('Select at least one section first',true);return;}
    toast('Generating executive summary…');
    return callGeminiAssist('Write a short (3-4 sentence) executive summary for a management report, based on this data:\n\n'+snapshot).then(function(text){
      RB_AI_SUMMARY=text.trim();
      toast('✅ AI summary added — tap Generate Preview');
    });
  }).catch(function(err){toast(err.message||'Could not generate summary',true);});
}
function buildReportPreview(){
  var previewEl=document.getElementById('rbPreview');
  previewEl.innerHTML='<div class="empty-hint">Loading latest data…</div>';
  ensureAllDataLoaded().then(function(){
    renderReportPreviewNow();
  });
}
function renderReportPreviewNow(){
  var title=document.getElementById('rbTitle').value.trim()||(CTX.company_name+' — Report');
  var font=document.getElementById('rbFont').value;
  var color=document.getElementById('rbColor').value;
  var footer=document.getElementById('rbFooter').value.trim();
  var signName=document.getElementById('rbSignName').value.trim();
  var signTitle=document.getElementById('rbSignTitle').value.trim();
  var sections=buildReportSectionsData();
  var logo=(CTX.config&&CTX.config.brand&&CTX.config.brand.logoUrl)||null;

  var textLines=[title,''];
  var html='<div style="font-family:'+font+';max-width:680px;margin:0 auto;">'
    +'<div style="text-align:center;margin-bottom:18px;border-bottom:3px solid '+color+';padding-bottom:14px;">'
    +(logo?'<img src="'+logo+'" style="width:52px;height:52px;object-fit:contain;margin-bottom:8px;">':'')
    +'<div style="font-size:19px;font-weight:700;">'+escapeHtml(title)+'</div>'
    +'<div style="font-size:11px;color:#888;margin-top:4px;">'+CTX.company_name+' · '+new Date().toLocaleDateString()+'</div></div>';

  if(RB_AI_SUMMARY){
    html+='<div style="margin-bottom:16px;padding:12px 14px;background:#f6f7f9;border-radius:8px;font-size:13px;"><b style="color:'+color+';">Executive Summary</b><br>'+escapeHtml(RB_AI_SUMMARY)+'</div>';
    textLines.push('EXECUTIVE SUMMARY',RB_AI_SUMMARY,'');
  }
  sections.forEach(function(s){
    html+='<div style="margin-bottom:14px;"><div style="font-size:13px;font-weight:700;color:'+color+';margin-bottom:6px;">'+escapeHtml(s.heading)+'</div>'
      +'<div style="font-size:12.5px;">'+s.lines.map(escapeHtml).join('<br>')+'</div></div>';
    textLines.push(s.heading.toUpperCase(),s.lines.join(' · '),'');
  });
  RB_CUSTOM_BLOCKS.forEach(function(b){
    if(!b.heading&&!b.text)return;
    html+='<div style="margin-bottom:14px;"><div style="font-size:13px;font-weight:700;color:'+color+';margin-bottom:6px;">'+escapeHtml(b.heading)+'</div>'
      +'<div style="font-size:12.5px;white-space:pre-wrap;">'+escapeHtml(b.text)+'</div></div>';
    textLines.push(b.heading.toUpperCase(),b.text,'');
  });
  if(signName){
    html+='<div style="margin-top:24px;font-size:12.5px;">_______________________<br>'+escapeHtml(signName)+(signTitle?'<br>'+escapeHtml(signTitle):'')+'</div>';
    textLines.push('— '+signName+(signTitle?' ('+signTitle+')':''));
  }
  if(footer)html+='<div style="margin-top:18px;font-size:11px;color:#888;text-align:center;">'+escapeHtml(footer)+'</div>';

  RB_LAST_HTML=html+'</div>';
  RB_LAST_TEXT=textLines.join('\n');
  document.getElementById('rbPreview').innerHTML=RB_LAST_HTML;
}
function exportReportPrint(){
  if(!RB_LAST_HTML){toast('Generate a preview first',true);return;}
  document.getElementById('printArea').innerHTML=RB_LAST_HTML;
  setTimeout(function(){window.print();},80);
}
function exportReportWord(){
  if(!RB_LAST_HTML){toast('Generate a preview first',true);return;}
  var doc='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body>'+RB_LAST_HTML+'</body></html>';
  var blob=new Blob([doc],{type:'application/msword'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(document.getElementById('rbTitle').value.trim()||'report')+'.doc';
  a.click();
}
function exportReportExcel(){
  if(!RB_LAST_TEXT){toast('Generate a preview first',true);return;}
  var rows=RB_LAST_TEXT.split('\n').map(function(line){return [line];});
  var ws=XLSX.utils.aoa_to_sheet(rows);
  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Report');
  XLSX.writeFile(wb,(document.getElementById('rbTitle').value.trim()||'report')+'.xlsx');
}
function exportReportEmail(){
  if(!RB_LAST_TEXT){toast('Generate a preview first',true);return;}
  window.location.href='mailto:?subject='+encodeURIComponent(document.getElementById('rbTitle').value.trim()||'Report')+'&body='+encodeURIComponent(RB_LAST_TEXT);
}
function exportReportWhatsApp(){
  if(!RB_LAST_TEXT){toast('Generate a preview first',true);return;}
  window.open('https://wa.me/?text='+encodeURIComponent(RB_LAST_TEXT),'_blank');
}

// ------------------------------------------------------------
// ATTENDANCE MODULE (stored as activities.type='attendance')
// ------------------------------------------------------------
var ATTENDANCE_CACHE=[];
var ATT_ROSTER_STATE={}; // personId -> 'present'|'absent'|'late'
function initAttendanceView(){
  if(!document.getElementById('attDate').value){
    document.getElementById('attDate').value=new Date().toISOString().slice(0,10);
  }
  Promise.resolve(PEOPLE_CACHE.length?PEOPLE_CACHE:getTable('people','order=full_name.asc',true).then(function(r){PEOPLE_CACHE=r||[];return PEOPLE_CACHE;})).then(function(){
    populateAttendanceBatchFilter();
    loadAttendanceAnalytics();
  });
}
function populateAttendanceBatchFilter(){
  var batches={};
  PEOPLE_CACHE.forEach(function(p){var ac=(p.custom_fields&&p.custom_fields.academic)||{};if(ac.batch)batches[ac.batch]=true;});
  var sel=document.getElementById('attBatch');
  var cur=sel.value;
  sel.innerHTML='<option value="">Choose a batch…</option>'+Object.keys(batches).sort().map(function(b){return '<option value="'+escapeHtml(b)+'">'+escapeHtml(b)+'</option>';}).join('');
  sel.value=cur;
}
function loadAttendanceRoster(){
  var date=document.getElementById('attDate').value;
  var batch=document.getElementById('attBatch').value;
  var rosterEl=document.getElementById('attRoster');
  if(!date||!batch){
    rosterEl.innerHTML='<div class="empty-hint" style="padding:16px;">Choose a batch and date to load the roster.</div>';
    document.getElementById('attSaveBtn').style.display='none';
    return;
  }
  rosterEl.innerHTML='<div class="empty-hint" style="padding:16px;">Loading…</div>';
  var students=PEOPLE_CACHE.filter(function(p){return (p.custom_fields&&p.custom_fields.academic&&p.custom_fields.academic.batch)===batch;});
  getTable('activities','type=eq.attendance&custom_fields->>date=eq.'+date,true).then(function(existing){
    ATT_ROSTER_STATE={};
    (existing||[]).forEach(function(a){ATT_ROSTER_STATE[a.person_id]=(a.custom_fields||{}).status;});
    renderAttendanceRoster(students);
    document.getElementById('attSaveBtn').style.display='inline-flex';
  }).catch(function(){
    ATT_ROSTER_STATE={};
    renderAttendanceRoster(students);
    document.getElementById('attSaveBtn').style.display='inline-flex';
  });
}
function renderAttendanceRoster(students){
  var rosterEl=document.getElementById('attRoster');
  var term=(CTX.config&&CTX.config.terminology)||{};
  if(!students.length){
    rosterEl.innerHTML='<div class="empty-hint" style="padding:16px;">No '+(term.entity_person_plural||'people').toLowerCase()+' found in this batch.</div>';
    return;
  }
  rosterEl.innerHTML=students.map(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    var status=ATT_ROSTER_STATE[p.id]||'present';
    return '<div class="att-row">'
      +'<div><div class="p-name">'+escapeHtml(p.full_name||'—')+'</div><div class="p-meta">Roll '+escapeHtml(ac.rollNo||'—')+'</div></div>'
      +'<div class="att-status-group">'
      +'<span class="att-chip p'+(status==='present'?' active':'')+'" onclick="setAttStatus(\''+p.id+'\',\'present\')">P</span>'
      +'<span class="att-chip a'+(status==='absent'?' active':'')+'" onclick="setAttStatus(\''+p.id+'\',\'absent\')">A</span>'
      +'<span class="att-chip l'+(status==='late'?' active':'')+'" onclick="setAttStatus(\''+p.id+'\',\'late\')">L</span>'
      +'</div></div>';
  }).join('');
  updateAttendanceStats(students);
}
function setAttStatus(personId,status){
  ATT_ROSTER_STATE[personId]=status;
  var students=PEOPLE_CACHE.filter(function(p){return (p.custom_fields&&p.custom_fields.academic&&p.custom_fields.academic.batch)===document.getElementById('attBatch').value;});
  renderAttendanceRoster(students);
}
function updateAttendanceStats(students){
  var present=0,absent=0,late=0;
  students.forEach(function(p){
    var s=ATT_ROSTER_STATE[p.id]||'present';
    if(s==='present')present++;else if(s==='absent')absent++;else if(s==='late')late++;
  });
  var stats=[{value:students.length,label:'Total'},{value:present,label:'Present'},{value:absent,label:'Absent'},{value:late,label:'Late'}];
  document.getElementById('attStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function saveAttendanceRoster(){
  var date=document.getElementById('attDate').value;
  var batch=document.getElementById('attBatch').value;
  var subject=document.getElementById('attSubject').value.trim()||null;
  var students=PEOPLE_CACHE.filter(function(p){return (p.custom_fields&&p.custom_fields.academic&&p.custom_fields.academic.batch)===batch;});
  var btn=document.getElementById('attSaveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  getTable('activities','type=eq.attendance&custom_fields->>date=eq.'+date,true).then(function(existing){
    var existingByPerson={};
    (existing||[]).forEach(function(a){existingByPerson[a.person_id]=a;});
    var ops=students.map(function(p){
      var status=ATT_ROSTER_STATE[p.id]||'present';
      var body={person_id:p.id,title:'Attendance',custom_fields:{date:date,batch:batch,subject:subject,status:status}};
      var ex=existingByPerson[p.id];
      if(ex){
        return patchTable('activities','id=eq.'+ex.id,body,true);
      }else{
        body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='attendance';
        return postTable('activities',body,true);
      }
    });
    return Promise.all(ops);
  }).then(function(){
    toast('✅ Attendance saved for '+students.length+' student(s)');
    loadAttendanceAnalytics();
  }).catch(function(err){
    toast(err.message||'Could not save attendance.',true);
  }).finally(function(){
    btn.disabled=false;btn.textContent='💾 Save Attendance';
  });
}
function loadAttendanceAnalytics(){
  var since=new Date();since.setDate(since.getDate()-30);
  getTable('activities','type=eq.attendance&order=created_at.desc',true).then(function(rows){
    ATTENDANCE_CACHE=rows||[];
    var byBatch={};
    ATTENDANCE_CACHE.forEach(function(a){
      var cf=a.custom_fields||{};
      if(!cf.batch)return;
      byBatch[cf.batch]=byBatch[cf.batch]||{present:0,total:0};
      byBatch[cf.batch].total++;
      if(cf.status==='present'||cf.status==='late')byBatch[cf.batch].present++;
    });
    var data=Object.keys(byBatch).map(function(b){return {label:b,value:Math.round((byBatch[b].present/byBatch[b].total)*100)};});
    document.getElementById('attBarChartHolder').innerHTML=data.length?svgBar(data,{suffix:'%',maxValue:100}):'<div class="empty-hint">No attendance data yet</div>';
    renderAttSessions();
  }).catch(function(){});
}
// ---- Recent Records: browsable/searchable list of past attendance sessions ----
function getAttendanceSessions(){
  var sessions={};
  (ATTENDANCE_CACHE||[]).forEach(function(a){
    var cf=a.custom_fields||{};
    if(!cf.date||!cf.batch)return;
    var key=cf.date+'|'+cf.batch+'|'+(cf.subject||'');
    sessions[key]=sessions[key]||{date:cf.date,batch:cf.batch,subject:cf.subject||'',present:0,total:0};
    sessions[key].total++;
    if(cf.status==='present'||cf.status==='late')sessions[key].present++;
  });
  return Object.values(sessions).sort(function(a,b){return a.date<b.date?1:-1;});
}
function renderAttSessions(){
  var q=(document.getElementById('attSessionSearch').value||'').trim().toLowerCase();
  var sessions=getAttendanceSessions().filter(function(s){
    if(!q)return true;
    return (s.batch+' '+s.date+' '+s.subject).toLowerCase().indexOf(q)>-1;
  });
  var listEl=document.getElementById('attSessionsList');
  if(!sessions.length){
    listEl.innerHTML='<div class="empty-hint" style="padding:16px 0;">No records found.</div>';
    return;
  }
  listEl.innerHTML=sessions.map(function(s){
    var pct=Math.round((s.present/s.total)*100);
    return '<div class="history-row" style="cursor:pointer;" onclick="reopenAttSession(\''+s.date+'\',\''+escapeHtml(s.batch)+'\')">'
      +'<span class="h-name">'+escapeHtml(s.batch)+(s.subject?' · '+escapeHtml(s.subject):'')+'</span>'
      +'<span class="h-stats"><span>'+s.date+'</span><span>'+s.present+'/'+s.total+' present ('+pct+'%)</span></span>'
      +'</div>';
  }).join('');
}
function reopenAttSession(date,batch){
  document.getElementById('attDate').value=date;
  document.getElementById('attBatch').value=batch;
  loadAttendanceRoster();
  document.getElementById('attRoster').scrollIntoView({behavior:'smooth',block:'start'});
}
function exportAttendanceCsv(){
  var rows=ATTENDANCE_CACHE||[];
  var header=['Name','Roll No','Batch','Date','Status'];
  var lines=[header.join(',')];
  rows.forEach(function(a){
    var p=findPersonById(a.person_id)||{};
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    var cf=a.custom_fields||{};
    lines.push([p.full_name,ac.rollNo,cf.batch,cf.date,cf.status].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a2=document.createElement('a');
  a2.href=URL.createObjectURL(blob);a2.download='attendance.csv';a2.click();
}

// ---- Student-wise attendance analysis ----
function renderAttStudentSearchResults(){
  var q=(document.getElementById('attStudentSearch').value||'').trim().toLowerCase();
  var resultsEl=document.getElementById('attStudentSearchResults');
  if(!q){resultsEl.innerHTML='';return;}
  var matches=PEOPLE_CACHE.filter(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    return (p.full_name||'').toLowerCase().indexOf(q)>-1 || (ac.rollNo||'').toLowerCase().indexOf(q)>-1;
  }).slice(0,6);
  resultsEl.innerHTML=matches.map(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    return '<div class="result-row" onclick="showAttStudentAnalysis(\''+p.id+'\')"><div><div class="p-name">'+escapeHtml(p.full_name||'—')+'</div><div class="p-meta">Roll '+escapeHtml(ac.rollNo||'—')+' · '+escapeHtml(ac.batch||'—')+'</div></div></div>';
  }).join('')||'<div class="empty-hint" style="padding:8px 0;">No match.</div>';
}
function showAttStudentAnalysis(personId){
  var p=findPersonById(personId);
  if(!p)return;
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  document.getElementById('attStudentSearchResults').innerHTML='';
  document.getElementById('attStudentSearch').value=p.full_name;
  var host=document.getElementById('attStudentAnalysis');
  host.innerHTML='<div class="empty-hint">Loading…</div>';
  getTable('activities','type=eq.attendance&person_id=eq.'+personId+'&order=custom_fields->>date.desc',true).then(function(rows){
    var counts={present:0,absent:0,late:0};
    rows.forEach(function(a){var s=(a.custom_fields||{}).status||'present';counts[s]=(counts[s]||0)+1;});
    var total=rows.length;
    var pct=total?Math.round(((counts.present+counts.late)/total)*100):0;
    var chartData=[{label:'Present',value:counts.present},{label:'Absent',value:counts.absent},{label:'Late',value:counts.late}];
    var html='<div class="rp-head"><div><div class="rp-name">'+escapeHtml(p.full_name)+'</div>'
      +'<div class="rp-meta">Roll '+escapeHtml(ac.rollNo||'—')+' · '+escapeHtml(ac.batch||'—')+'</div></div>'
      +'<span class="pf-badge '+(pct>=75?'pass':'fail')+'" style="margin-left:auto;">'+pct+'% overall</span></div>';
    html+='<div class="chart-label">Present / Absent / Late</div><div id="attStudentChartHolder"></div>';
    if(rows.length){
      html+='<div class="modal-section-head" style="border-top:none;padding-top:0;">History (most recent first)</div>'
        +'<table class="rp-table"><tr><th>Date</th><th>Status</th><th>Subject</th></tr>'
        +rows.slice(0,20).map(function(a){var cf=a.custom_fields||{};return '<tr><td>'+cf.date+'</td><td>'+capitalize(cf.status||'—')+'</td><td>'+escapeHtml(cf.subject||'—')+'</td></tr>';}).join('')
        +'</table>';
    }else{
      html+='<p class="empty-hint">No attendance records yet for this student.</p>';
    }
    html+='<div class="rp-actions">'
      +'<button class="btn btn-primary btn-sm" onclick="downloadAttendanceReport(\''+personId+'\')">⬇️ Download Report</button>'
      +'<button class="btn btn-ghost btn-sm" onclick="shareAttendanceWhatsApp(\''+personId+'\')">💬 WhatsApp</button>'
      +'</div>';
    host.innerHTML=html;
    document.getElementById('attStudentChartHolder').innerHTML=svgBar(chartData,{suffix:'',maxValue:Math.max.apply(null,chartData.map(function(d){return d.value;}).concat([1]))});
    ATT_STUDENT_ROWS_CACHE=rows;
  }).catch(function(){
    host.innerHTML='<div class="empty-hint">Could not load attendance history.</div>';
  });
}
var ATT_STUDENT_ROWS_CACHE=[];
function downloadAttendanceReport(personId){
  var p=findPersonById(personId);
  if(!p)return;
  var ac=(p.custom_fields&&p.custom_fields.academic)||{};
  var rows=ATT_STUDENT_ROWS_CACHE;
  var counts={present:0,absent:0,late:0};
  rows.forEach(function(a){var s=(a.custom_fields||{}).status||'present';counts[s]=(counts[s]||0)+1;});
  var total=rows.length;
  var pct=total?Math.round(((counts.present+counts.late)/total)*100):0;
  var brand=(CTX.config&&CTX.config.brand)||{};
  var logo=brand.logoUrl;
  var accent=brand.accentColor||'#2563eb';
  var html='<div style="font-family:\'Inter\',sans-serif;max-width:620px;margin:0 auto;">'
    +'<div style="text-align:center;margin-bottom:16px;border-bottom:3px solid '+accent+';padding-bottom:14px;">'
    +(logo?'<img src="'+logo+'" style="width:52px;height:52px;object-fit:contain;margin-bottom:8px;">':'')
    +'<div style="font-size:18px;font-weight:700;">'+escapeHtml(CTX.company_name)+'</div>'
    +'<div style="font-size:13px;font-weight:600;margin-top:4px;color:'+accent+';">ATTENDANCE REPORT</div></div>'
    +'<table style="width:100%;font-size:12.5px;margin-bottom:14px;">'
    +'<tr><td style="color:#666;">Student</td><td style="text-align:right;font-weight:600;">'+escapeHtml(p.full_name||'-')+'</td></tr>'
    +'<tr><td style="color:#666;">Roll No / Batch</td><td style="text-align:right;">'+escapeHtml(ac.rollNo||'-')+' / '+escapeHtml(ac.batch||'-')+'</td></tr>'
    +'<tr><td style="color:#666;">Overall Attendance</td><td style="text-align:right;font-weight:700;color:'+accent+';">'+pct+'%</td></tr>'
    +'</table>'
    +'<table style="width:100%;font-size:12.5px;border-collapse:collapse;">'
    +'<tr style="border-bottom:2px solid #333;"><th style="text-align:left;">Date</th><th style="text-align:right;">Status</th></tr>'
    +rows.map(function(a){var cf=a.custom_fields||{};return '<tr style="border-bottom:1px solid #ddd;"><td>'+cf.date+'</td><td style="text-align:right;">'+capitalize(cf.status||'')+'</td></tr>';}).join('')
    +'</table></div>';
  document.getElementById('printArea').innerHTML=html;
  setTimeout(function(){window.print();},80);
}
function shareAttendanceWhatsApp(personId){
  var p=findPersonById(personId);
  if(!p)return;
  var rows=ATT_STUDENT_ROWS_CACHE;
  var present=rows.filter(function(a){var s=(a.custom_fields||{}).status;return s==='present'||s==='late';}).length;
  var pct=rows.length?Math.round((present/rows.length)*100):0;
  var text=CTX.company_name+'\nAttendance Report — '+p.full_name+'\nOverall: '+pct+'% ('+rows.length+' days recorded)';
  window.open('https://wa.me/'+(p.phone||'').replace(/[^0-9]/g,'')+'?text='+encodeURIComponent(text),'_blank');
}

// ---- Excel bulk upload for attendance ----
function openAttendanceUploadModal(){
  var date=document.getElementById('attDate').value;
  if(!date){toast('Choose a date on the Attendance page first',true);return;}
  document.getElementById('attUploadProgress').innerHTML='';
  clearMsg('attUploadMsg');
  document.getElementById('attUploadInput').value='';
  openModal('attendanceUploadModal');
}
function handleAttendanceExcel(e){
  var f=e.target.files[0];
  if(!f)return;
  var progEl=document.getElementById('attUploadProgress');
  progEl.innerHTML='<div class="empty-hint">Reading file…</div>';
  var reader=new FileReader();
  reader.onload=function(evt){
    var wb;
    try{wb=XLSX.read(evt.target.result,{type:'binary'});}catch(err){showMsg('attUploadMsg','Could not read this file.',true);progEl.innerHTML='';return;}
    var sheet=wb.Sheets[wb.SheetNames[0]];
    var rows=XLSX.utils.sheet_to_json(sheet,{defval:'',header:1});
    if(!rows.length){showMsg('attUploadMsg','No data rows found.',true);progEl.innerHTML='';return;}
    processAttendanceExcelRows(rows.slice(1),progEl); // skip header row
  };
  reader.readAsBinaryString(f);
}
function processAttendanceExcelRows(rows,progEl){
  var date=document.getElementById('attDate').value;
  var byRoll={};
  PEOPLE_CACHE.forEach(function(p){
    var ac=(p.custom_fields&&p.custom_fields.academic)||{};
    if(ac.rollNo)byRoll[normRoll(ac.rollNo)]=p;
  });
  var STATUS_MAP={P:'present',A:'absent',L:'late'};
  var updated=0,skipped=0,failed=0;
  function next(i){
    if(i>=rows.length){
      var summary=updated+' marked, '+skipped+' skipped (roll not found), '+failed+' failed.';
      progEl.innerHTML='<div class="empty-hint">Done — '+summary+'</div>';
      showMsg('attUploadMsg',summary,failed>0);
      loadAttendanceAnalytics();
      return;
    }
    progEl.innerHTML='<div class="empty-hint">Processing '+(i+1)+' / '+rows.length+'…</div>';
    var row=rows[i];
    var roll=normRoll(row[0]);
    var statusRaw=(row[1]||'').toString().trim().toUpperCase();
    var status=STATUS_MAP[statusRaw]||'present';
    var person=byRoll[roll];
    if(!person){skipped++;return next(i+1);}
    getTable('activities','type=eq.attendance&custom_fields->>date=eq.'+date+'&person_id=eq.'+person.id,true).then(function(existing){
      var body={person_id:person.id,title:'Attendance',custom_fields:{date:date,batch:(person.custom_fields&&person.custom_fields.academic&&person.custom_fields.academic.batch)||null,status:status}};
      if(existing&&existing.length){
        return patchTable('activities','id=eq.'+existing[0].id,body,true);
      }else{
        body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='attendance';
        return postTable('activities',body,true);
      }
    }).then(function(){updated++;next(i+1);}).catch(function(){failed++;next(i+1);});
  }
  next(0);
}

// ------------------------------------------------------------
// HOSTEL MODULE (stored as activities.type='hostel_room'|'hostel_issue'|'hostel_mess'|'hostel_leave')
// ------------------------------------------------------------
var HOSTEL_ROOMS=[],HOSTEL_ISSUES=[],HOSTEL_MESS=[],HOSTEL_LEAVE=[];
var HOSTEL_TAB='rooms';
var HOSTEL_PASS_TYPE='day';
var HOSTEL_ISSUE_FILE=null,HOSTEL_LEAVE_FILE=null;

function setHostelTab(tab){
  HOSTEL_TAB=tab;
  ['Rooms','Issues','Mess','Leave'].forEach(function(t){
    var tKey=t.toLowerCase();
    document.getElementById('hTab'+t).classList.toggle('active',tKey===tab);
    document.getElementById('hPane'+t).style.display=(tKey===tab)?'block':'none';
  });
}
function setPassType(type){
  HOSTEL_PASS_TYPE=type;
  document.getElementById('hPassTypeDay').classList.toggle('active',type==='day');
  document.getElementById('hPassTypeNight').classList.toggle('active',type==='night');
}
function initHostelView(){
  Promise.resolve(PEOPLE_CACHE.length?PEOPLE_CACHE:getTable('people','order=full_name.asc',true).then(function(r){PEOPLE_CACHE=r||[];return PEOPLE_CACHE;})).then(function(){
    document.getElementById('hostelPeopleList').innerHTML=PEOPLE_CACHE.map(function(p){return '<option value="'+escapeHtml(p.full_name)+'">';}).join('');
    loadHostelData();
  });
}
function loadHostelData(){
  Promise.all([
    getTable('activities','type=eq.hostel_room&order=created_at.desc',true),
    getTable('activities','type=eq.hostel_issue&order=created_at.desc',true),
    getTable('activities','type=eq.hostel_mess&order=created_at.desc',true),
    getTable('activities','type=eq.hostel_leave&order=created_at.desc',true)
  ]).then(function(res){
    HOSTEL_ROOMS=res[0]||[];HOSTEL_ISSUES=res[1]||[];HOSTEL_MESS=res[2]||[];HOSTEL_LEAVE=res[3]||[];
    renderHostelStats();
    renderHostelRooms();renderHostelIssues();renderHostelMess();renderHostelLeave();
  }).catch(function(){});
}
function renderHostelStats(){
  var stats=[
    {value:HOSTEL_ROOMS.length,label:'Rooms Assigned'},
    {value:HOSTEL_ISSUES.length,label:'Room Issues'},
    {value:HOSTEL_MESS.length,label:'Mess Issues'},
    {value:HOSTEL_LEAVE.length,label:'Leave/Pass Records'}
  ];
  document.getElementById('hostelStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function findPersonByName(name){
  name=(name||'').trim().toLowerCase();
  return PEOPLE_CACHE.find(function(p){return (p.full_name||'').trim().toLowerCase()===name;});
}

// ---- Rooms ----
function saveHostelRoom(){
  var name=document.getElementById('hRoomPersonId').value.trim();
  var block=document.getElementById('hRoomBlock').value.trim();
  var floor=document.getElementById('hRoomFloor').value.trim();
  var roomNo=document.getElementById('hRoomNo').value.trim();
  if(!name||!roomNo){toast('Student name and room no are required.',true);return;}
  var person=findPersonByName(name);
  var body={person_id:person?person.id:null,title:'Room Assignment',custom_fields:{studentName:name,block:block,floor:floor,roomNo:roomNo}};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='hostel_room';
  postTable('activities',body,true).then(function(){
    toast('✅ Room assigned');
    document.getElementById('hRoomPersonId').value='';document.getElementById('hRoomFloor').value='';document.getElementById('hRoomNo').value='';
    loadHostelData();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderHostelRooms(){
  var q=(document.getElementById('hRoomSearch').value||'').trim().toLowerCase();
  var rows=HOSTEL_ROOMS.filter(function(r){
    var cf=r.custom_fields||{};
    if(!q)return true;
    return (cf.studentName+' '+cf.roomNo).toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('hRoomsList');
  el.innerHTML=rows.length?rows.map(function(r){
    var cf=r.custom_fields||{};
    return '<div class="history-row"><span class="h-name">'+escapeHtml(cf.studentName)+'</span><span class="h-stats"><span>'+escapeHtml(cf.block||'')+' · Floor '+escapeHtml(cf.floor||'—')+' · Room '+escapeHtml(cf.roomNo)+'</span>'
      +'<span class="mr-remove" style="cursor:pointer;" onclick="deleteHostelRecord(\''+r.id+'\',\'room\')">✕</span></span></div>';
  }).join(''):'<div class="empty-hint">No room assignments yet.</div>';
}

// ---- Issues ----
function handleHostelIssueFile(e){
  var f=e.target.files[0];
  if(!f)return;
  compressImage(f,700,0.8).then(function(dataUrl){
    HOSTEL_ISSUE_FILE=dataUrl;
    document.getElementById('hIssueFileTxt').textContent='✓ '+f.name;
  }).catch(function(){toast('Could not attach file',true);});
}
function saveHostelIssue(){
  var name=document.getElementById('hIssuePersonName').value.trim();
  var room=document.getElementById('hIssueRoom').value.trim();
  var details=document.getElementById('hIssueDetails').value.trim();
  if(!details){toast('Describe the issue.',true);return;}
  var person=findPersonByName(name);
  var body={person_id:person?person.id:null,title:'Room Issue',custom_fields:{studentName:name,roomNo:room,details:details,attachment:HOSTEL_ISSUE_FILE,status:'open'}};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='hostel_issue';
  postTable('activities',body,true).then(function(){
    toast('✅ Issue logged');
    document.getElementById('hIssuePersonName').value='';document.getElementById('hIssueRoom').value='';document.getElementById('hIssueDetails').value='';
    HOSTEL_ISSUE_FILE=null;document.getElementById('hIssueFileTxt').textContent='No file attached';
    loadHostelData();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderHostelIssues(){
  var q=(document.getElementById('hIssueSearch').value||'').trim().toLowerCase();
  var rows=HOSTEL_ISSUES.filter(function(r){
    var cf=r.custom_fields||{};
    if(!q)return true;
    return ((cf.studentName||'')+' '+(cf.roomNo||'')).toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('hIssuesList');
  el.innerHTML=rows.length?rows.map(function(r){
    var cf=r.custom_fields||{};
    return '<div class="history-row"><span class="h-name">'+escapeHtml(cf.studentName||'Unnamed')+' — '+escapeHtml(cf.roomNo||'—')+'</span>'
      +'<span class="h-stats"><span>'+escapeHtml((cf.details||'').slice(0,40))+'</span>'
      +(cf.attachment?'<span>📎</span>':'')
      +'<span class="mr-remove" style="cursor:pointer;" onclick="deleteHostelRecord(\''+r.id+'\',\'issue\')">✕</span></span></div>';
  }).join(''):'<div class="empty-hint">No entries yet.</div>';
}

// ---- Mess ----
function saveHostelMess(){
  var name=document.getElementById('hMessPersonName').value.trim();
  var details=document.getElementById('hMessDetails').value.trim();
  if(!details){toast('Describe the issue.',true);return;}
  var person=findPersonByName(name);
  var body={person_id:person?person.id:null,title:'Mess Issue',custom_fields:{studentName:name,details:details}};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='hostel_mess';
  postTable('activities',body,true).then(function(){
    toast('✅ Mess issue logged');
    document.getElementById('hMessPersonName').value='';document.getElementById('hMessDetails').value='';
    loadHostelData();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderHostelMess(){
  var q=(document.getElementById('hMessSearch').value||'').trim().toLowerCase();
  var rows=HOSTEL_MESS.filter(function(r){
    var cf=r.custom_fields||{};
    if(!q)return true;
    return (cf.studentName||'').toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('hMessList');
  el.innerHTML=rows.length?rows.map(function(r){
    var cf=r.custom_fields||{};
    return '<div class="history-row"><span class="h-name">'+escapeHtml(cf.studentName||'Anonymous')+'</span>'
      +'<span class="h-stats"><span>'+escapeHtml((cf.details||'').slice(0,50))+'</span>'
      +'<span class="mr-remove" style="cursor:pointer;" onclick="deleteHostelRecord(\''+r.id+'\',\'mess\')">✕</span></span></div>';
  }).join(''):'<div class="empty-hint">No entries yet.</div>';
}

// ---- Leave/Pass ----
function handleHostelLeaveFile(e){
  var f=e.target.files[0];
  if(!f)return;
  if(f.type.indexOf('image/')===0){
    compressImage(f,900,0.8).then(function(dataUrl){
      HOSTEL_LEAVE_FILE={dataUrl:dataUrl,name:f.name};
      document.getElementById('hLeaveFileTxt').textContent='✓ '+f.name;
    }).catch(function(){toast('Could not attach file',true);});
  }else{
    var reader=new FileReader();
    reader.onload=function(){
      HOSTEL_LEAVE_FILE={dataUrl:reader.result,name:f.name};
      document.getElementById('hLeaveFileTxt').textContent='✓ '+f.name;
    };
    reader.readAsDataURL(f);
  }
}
function saveHostelLeave(){
  var name=document.getElementById('hLeavePersonName').value.trim();
  var out=document.getElementById('hLeaveOut').value;
  var ret=document.getElementById('hLeaveReturn').value;
  var reason=document.getElementById('hLeaveReason').value.trim();
  if(!name||!out){toast('Student name and out date/time are required.',true);return;}
  var person=findPersonByName(name);
  var body={person_id:person?person.id:null,title:'Leave/Pass',custom_fields:{
    studentName:name,passType:HOSTEL_PASS_TYPE,outDateTime:out,returnDateTime:ret,reason:reason,
    attachmentDataUrl:HOSTEL_LEAVE_FILE?HOSTEL_LEAVE_FILE.dataUrl:null,attachmentName:HOSTEL_LEAVE_FILE?HOSTEL_LEAVE_FILE.name:null
  }};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='hostel_leave';
  postTable('activities',body,true).then(function(){
    toast('✅ Pass saved');
    document.getElementById('hLeavePersonName').value='';document.getElementById('hLeaveOut').value='';document.getElementById('hLeaveReturn').value='';document.getElementById('hLeaveReason').value='';
    HOSTEL_LEAVE_FILE=null;document.getElementById('hLeaveFileTxt').textContent='No file attached';
    loadHostelData();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderHostelLeave(){
  var q=(document.getElementById('hLeaveSearch').value||'').trim().toLowerCase();
  var rows=HOSTEL_LEAVE.filter(function(r){
    var cf=r.custom_fields||{};
    if(!q)return true;
    return (cf.studentName||'').toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('hLeaveList');
  el.innerHTML=rows.length?rows.map(function(r){
    var cf=r.custom_fields||{};
    return '<div class="history-row"><span class="h-name">'+escapeHtml(cf.studentName||'—')+' · '+(cf.passType==='night'?'🌙 Night':'☀️ Day')+'</span>'
      +'<span class="h-stats"><span>Out: '+(cf.outDateTime||'—')+'</span><span>Return: '+(cf.returnDateTime||'—')+'</span>'
      +(cf.attachmentDataUrl?'<a href="'+cf.attachmentDataUrl+'" download="'+escapeHtml(cf.attachmentName||'application')+'" onclick="event.stopPropagation();">📎 View</a>':'')
      +'<span class="mr-remove" style="cursor:pointer;" onclick="deleteHostelRecord(\''+r.id+'\',\'leave\')">✕</span></span></div>';
  }).join(''):'<div class="empty-hint">No entries yet.</div>';
}

function deleteHostelRecord(id,kind){
  if(!confirm('Delete this record?'))return;
  deleteTable('activities','id=eq.'+id,true).then(function(){
    toast('Removed');
    loadHostelData();
  }).catch(function(err){toast(err.message||'Could not delete.',true);});
}

// ------------------------------------------------------------
// STUDENT CARE MODULE (stored as activities.type='care_dispute'|'care_complaint'|'care_mentor')
// ------------------------------------------------------------
var CARE_DISPUTES=[],CARE_COMPLAINTS=[],CARE_MENTOR=[];
var CARE_TAB='disputes';
var CARE_TYPE_MAP={dispute:{table:'care_dispute',cache:'CARE_DISPUTES',title:'Dispute'},complaint:{table:'care_complaint',cache:'CARE_COMPLAINTS',title:'Complaint'},mentor:{table:'care_mentor',cache:'CARE_MENTOR',title:'Mentor Session'}};

function setCareTab(tab){
  CARE_TAB=tab;
  ['Disputes','Complaints','Mentor'].forEach(function(t){
    var tKey=t.toLowerCase();
    document.getElementById('scTab'+t).classList.toggle('active',tKey===tab);
    document.getElementById('scPane'+t).style.display=(tKey===tab)?'block':'none';
  });
}
function initCareView(){
  Promise.all([
    getTable('activities','type=eq.care_dispute&order=created_at.desc',true),
    getTable('activities','type=eq.care_complaint&order=created_at.desc',true),
    getTable('activities','type=eq.care_mentor&order=created_at.desc',true)
  ]).then(function(res){
    CARE_DISPUTES=res[0]||[];CARE_COMPLAINTS=res[1]||[];CARE_MENTOR=res[2]||[];
    renderCareStats();
    renderCareList('dispute');renderCareList('complaint');renderCareList('mentor');
  }).catch(function(){});
}
function renderCareStats(){
  var openDisputes=CARE_DISPUTES.filter(function(r){return (r.custom_fields||{}).status!=='resolved';}).length;
  var openComplaints=CARE_COMPLAINTS.filter(function(r){return (r.custom_fields||{}).status!=='resolved';}).length;
  var stats=[
    {value:CARE_DISPUTES.length,label:'Disputes ('+openDisputes+' open)'},
    {value:CARE_COMPLAINTS.length,label:'Complaints ('+openComplaints+' open)'},
    {value:CARE_MENTOR.length,label:'Mentor Sessions'}
  ];
  document.getElementById('careStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function saveCareRecord(kind){
  var meta=CARE_TYPE_MAP[kind];
  var name,details,customFields;
  if(kind==='dispute'){
    name=document.getElementById('scDisputeName').value.trim();
    details=document.getElementById('scDisputeDetails').value.trim();
    customFields={studentName:name,details:details,status:'open'};
  }else if(kind==='complaint'){
    name=document.getElementById('scComplaintName').value.trim();
    details=document.getElementById('scComplaintDetails').value.trim();
    customFields={studentName:name,details:details,status:'open'};
  }else{
    name=document.getElementById('scMentorName').value.trim();
    var date=document.getElementById('scMentorDate').value;
    var duration=document.getElementById('scMentorDuration').value;
    details=document.getElementById('scMentorNotes').value.trim();
    customFields={studentName:name,date:date,duration:duration,details:details};
  }
  if(!name||!details){toast('Student name and details are required.',true);return;}
  var person=findPersonByName(name);
  var body={person_id:person?person.id:null,title:meta.title,custom_fields:customFields};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='care_'+kind;
  postTable('activities',body,true).then(function(){
    toast('✅ '+meta.title+' logged');
    if(kind==='dispute'){document.getElementById('scDisputeName').value='';document.getElementById('scDisputeDetails').value='';}
    else if(kind==='complaint'){document.getElementById('scComplaintName').value='';document.getElementById('scComplaintDetails').value='';}
    else{document.getElementById('scMentorName').value='';document.getElementById('scMentorDate').value='';document.getElementById('scMentorDuration').value='';document.getElementById('scMentorNotes').value='';}
    initCareView();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderCareList(kind){
  var meta=CARE_TYPE_MAP[kind];
  var cache=window[meta.cache];
  var searchId={dispute:'scDisputeSearch',complaint:'scComplaintSearch',mentor:'scMentorSearch'}[kind];
  var listId={dispute:'scDisputesList',complaint:'scComplaintsList',mentor:'scMentorList'}[kind];
  var q=(document.getElementById(searchId).value||'').trim().toLowerCase();
  var rows=cache.filter(function(r){
    var cf=r.custom_fields||{};
    if(!q)return true;
    return (cf.studentName||'').toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById(listId);
  if(!rows.length){el.innerHTML='<div class="empty-hint">No entries yet.</div>';return;}
  el.innerHTML=rows.map(function(r){
    var cf=r.custom_fields||{};
    var statusBadge=kind!=='mentor'?('<span class="pf-badge '+(cf.status==='resolved'?'pass':'fail')+'">'+(cf.status||'open')+'</span>'):'';
    var subline=kind==='mentor'?((cf.date||'—')+' · '+(cf.duration||'—')+' min'):(cf.details||'').slice(0,40);
    return '<div class="history-row" style="cursor:pointer;" onclick="showCareDetail(\''+kind+'\',\''+r.id+'\')">'
      +'<span class="h-name">'+escapeHtml(cf.studentName||'—')+'</span>'
      +'<span class="h-stats"><span>'+escapeHtml(subline)+'</span>'+statusBadge+'</span></div>';
  }).join('');
}
function showCareDetail(kind,id){
  var meta=CARE_TYPE_MAP[kind];
  var cache=window[meta.cache];
  var r=cache.find(function(x){return x.id===id;});
  if(!r)return;
  var cf=r.custom_fields||{};
  document.getElementById('careDetailTitle').textContent=meta.title;
  var html='<div class="rp-meta" style="margin-bottom:10px;">'+escapeHtml(cf.studentName||'—')+(cf.date?' · '+cf.date:'')+(cf.duration?' · '+cf.duration+' min':'')+'</div>'
    +'<div style="font-size:13px;white-space:pre-wrap;margin-bottom:14px;">'+escapeHtml(cf.details||'')+'</div>';
  if(kind!=='mentor'){
    html+='<div style="margin-bottom:14px;"><span class="pf-badge '+(cf.status==='resolved'?'pass':'fail')+'">'+(cf.status||'open')+'</span></div>';
  }
  html+='<div id="careAiSuggestWrap" style="display:none;margin-bottom:14px;"><div class="ai-output-label">AI Suggestion</div><div id="careAiSuggestOutput" class="ai-output"></div></div>';
  html+='<div class="rp-actions">';
  if(kind!=='mentor' && cf.status!=='resolved'){
    html+='<button class="btn btn-primary btn-sm" onclick="resolveCareRecord(\''+kind+'\',\''+id+'\')">✅ Mark Resolved</button>';
  }
  if(kind!=='mentor'){
    html+='<button class="btn btn-ghost btn-sm" onclick="suggestCareResolution(\''+kind+'\',\''+id+'\')">✨ AI Suggest Resolution</button>';
  }
  html+='<button class="btn btn-danger btn-sm" onclick="deleteCareRecord(\''+kind+'\',\''+id+'\')">Delete</button>'
    +'</div>';
  document.getElementById('careDetailBody').innerHTML=html;
  openModal('careDetailModal');
}
function resolveCareRecord(kind,id){
  var meta=CARE_TYPE_MAP[kind];
  var cache=window[meta.cache];
  var r=cache.find(function(x){return x.id===id;});
  if(!r)return;
  var cf=Object.assign({},r.custom_fields,{status:'resolved'});
  patchTable('activities','id=eq.'+id,{custom_fields:cf},true).then(function(){
    toast('✅ Marked resolved');
    closeModal('careDetailModal');
    initCareView();
  }).catch(function(err){toast(err.message||'Could not update.',true);});
}
function suggestCareResolution(kind,id){
  var meta=CARE_TYPE_MAP[kind];
  var cache=window[meta.cache];
  var r=cache.find(function(x){return x.id===id;});
  if(!r)return;
  var cf=r.custom_fields||{};
  var wrap=document.getElementById('careAiSuggestWrap');
  wrap.style.display='block';
  document.getElementById('careAiSuggestOutput').textContent='Thinking…';
  var prompt='A student '+(kind==='dispute'?'dispute':'complaint')+' was raised. Details: "'+cf.details+'". '
    +'Suggest a fair, practical resolution approach in 2-3 sentences, appropriate for a '+humanizeVertical(CTX.vertical)+' setting.';
  callGeminiAssist(prompt).then(function(text){
    document.getElementById('careAiSuggestOutput').textContent=text;
  }).catch(function(err){
    document.getElementById('careAiSuggestOutput').textContent='';
    wrap.style.display='none';
    toast(err.message||'AI suggestion unavailable.',true);
  });
}
function deleteCareRecord(kind,id){
  if(!confirm('Delete this record?'))return;
  deleteTable('activities','id=eq.'+id,true).then(function(){
    toast('Removed');
    closeModal('careDetailModal');
    initCareView();
  }).catch(function(err){toast(err.message||'Could not delete.',true);});
}

// ------------------------------------------------------------
// EXPENSES MODULE (stored as transactions.type='expense' — same table Fees uses,
// since only 'transactions' has native amount/currency columns; 'activities' does not)
// ------------------------------------------------------------
var EXPENSES_CACHE=[];
var EXPENSE_CATEGORY_FILTER='';
var EXPENSE_PAY_METHOD='Cash';
var EXPENSE_RECEIPT=null;
var EXPENSES_BULK_SELECTED={};

function loadExpenses(){
  var listEl=document.getElementById('expensesList');
  listEl.innerHTML='<div class="empty-hint" style="padding:16px;">Loading…</div>';
  getTable('transactions','type=eq.expense&order=created_at.desc',true).then(function(rows){
    EXPENSES_CACHE=rows||[];
    renderExpensesList();
  }).catch(function(err){
    listEl.innerHTML='<div class="empty-hint" style="padding:16px;">Could not load: '+(err.message||'')+'</div>';
  });
}
function setExpenseCategory(cat){
  EXPENSE_CATEGORY_FILTER=cat;
  document.querySelectorAll('#expenseCategoryTabs .tab').forEach(function(el){
    el.classList.toggle('active',el.getAttribute('data-cat')===cat);
  });
  renderExpensesList();
}
function getFilteredExpenses(){
  var q=(document.getElementById('expenseSearch').value||'').trim().toLowerCase();
  return EXPENSES_CACHE.filter(function(e){
    var cf=e.custom_fields||{};
    if(EXPENSE_CATEGORY_FILTER && e.category!==EXPENSE_CATEGORY_FILTER)return false;
    if(!q)return true;
    var hay=[cf.purpose,e.category,e.amount].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
function renderExpenseStats(){
  var rows=getFilteredExpenses();
  var byCurrency={};
  rows.forEach(function(e){
    var cur=e.currency||'NPR';
    byCurrency[cur]=(byCurrency[cur]||0)+(parseFloat(e.amount)||0);
  });
  var stats=Object.keys(byCurrency).map(function(cur){return {value:currencySymbol(cur)+byCurrency[cur].toLocaleString(),label:'Total ('+cur+')'};});
  if(!stats.length)stats.push({value:'₨0',label:'Total (NPR)'});
  stats.push({value:rows.length,label:'Entries'});
  document.getElementById('expenseStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function renderExpensesList(){
  var rows=getFilteredExpenses();
  var listEl=document.getElementById('expensesList');
  if(!rows.length){
    listEl.innerHTML='<div class="empty-hint" style="padding:16px;">No expenses found. Tap "+ Add Expense" to create one.</div>';
  }else{
    listEl.innerHTML=rows.map(function(e){
      var cf=e.custom_fields||{};
      var checked=EXPENSES_BULK_SELECTED[e.id]?'checked':'';
      return '<div class="result-row">'
        +'<input type="checkbox" onclick="event.stopPropagation();toggleExpenseSelect(\''+e.id+'\')" '+checked+' style="width:auto;margin-right:8px;">'
        +'<div style="flex:1;cursor:pointer;" onclick="openExpenseModal(\''+e.id+'\')"><div class="p-name">'+escapeHtml(cf.purpose||e.category||'Expense')+'</div>'
        +'<div class="p-meta">'+escapeHtml(e.category||'')+' · '+(cf.dateFrom||'—')+(cf.dateTo&&cf.dateTo!==cf.dateFrom?' → '+cf.dateTo:'')+' · '+escapeHtml(cf.paymentMethod||'')+'</div></div>'
        +'<span class="pf-badge fail" style="margin-left:auto;">'+currencySymbol(e.currency)+(parseFloat(e.amount)||0).toLocaleString()+'</span>'
        +'</div>';
    }).join('');
  }
  renderExpenseStats();
  renderExpenseAnalysis();
  updateExpensesBulkBar();
}
function renderExpenseAnalysis(){
  var rows=getFilteredExpenses();
  var byCat={};
  rows.forEach(function(e){byCat[e.category||'Other']=(byCat[e.category||'Other']||0)+(parseFloat(e.amount)||0);});
  var data=Object.keys(byCat).map(function(c){return {label:c,value:Math.round(byCat[c])};});
  document.getElementById('expenseChartHolder').innerHTML=data.length?svgBar(data,{suffix:''}):'<div class="empty-hint">No data yet</div>';
}
function setExpensePayMethod(method){
  EXPENSE_PAY_METHOD=method;
  var idMap={Cash:'exPayCash',UPI:'exPayUpi',Card:'exPayCard',eSewa:'exPayEsewa'};
  Object.keys(idMap).forEach(function(m){
    document.getElementById(idMap[m]).classList.toggle('active',m===method);
  });
}
function handleExpenseReceipt(e){
  var f=e.target.files[0];
  if(!f)return;
  compressImage(f,800,0.8).then(function(dataUrl){
    EXPENSE_RECEIPT=dataUrl;
    var prev=document.getElementById('exReceiptPreview');
    prev.src=dataUrl;prev.style.display='block';
  }).catch(function(){toast('Could not attach receipt',true);});
}
function openExpenseModal(id){
  clearMsg('expenseMsg');
  EXPENSE_RECEIPT=null;
  var e=id?EXPENSES_CACHE.find(function(x){return x.id===id;}):null;
  var cf=(e&&e.custom_fields)||{};
  document.getElementById('expenseModalTitle').textContent=e?'💰 Edit Expense':'💰 Add Expense';
  document.getElementById('exId').value=e?e.id:'';
  var today=new Date().toISOString().slice(0,10);
  document.getElementById('exDateFrom').value=cf.dateFrom||today;
  document.getElementById('exDateTo').value=cf.dateTo||today;
  document.getElementById('exCategory').value=e?(e.category||'Travel'):'Travel';
  document.getElementById('exAmount').value=e?e.amount:'';
  document.getElementById('exCurrency').value=e?(e.currency||'NPR'):'NPR';
  document.getElementById('exPurpose').value=cf.purpose||'';
  document.getElementById('exVisitor').value=cf.relatedVisitor||'';
  setExpensePayMethod(cf.paymentMethod||'Cash');
  var prev=document.getElementById('exReceiptPreview');
  if(cf.receiptDataUrl){prev.src=cf.receiptDataUrl;prev.style.display='block';}else{prev.style.display='none';}
  document.getElementById('exDeleteBtn').style.display=e?'inline-flex':'none';
  document.getElementById('exDupBtn').style.display=e?'inline-flex':'none';
  openModal('expenseModal');
}
function saveExpense(){
  var id=document.getElementById('exId').value;
  var amount=parseFloat(document.getElementById('exAmount').value);
  if(!amount||amount<=0){showMsg('expenseMsg','Enter a valid amount.',true);return;}
  var existing=id?EXPENSES_CACHE.find(function(x){return x.id===id;}):null;
  var cf=Object.assign({},existing?existing.custom_fields:{});
  cf.dateFrom=document.getElementById('exDateFrom').value||null;
  cf.dateTo=document.getElementById('exDateTo').value||null;
  cf.paymentMethod=EXPENSE_PAY_METHOD;
  cf.purpose=document.getElementById('exPurpose').value.trim()||null;
  cf.relatedVisitor=document.getElementById('exVisitor').value.trim()||null;
  if(EXPENSE_RECEIPT)cf.receiptDataUrl=EXPENSE_RECEIPT;
  var body={category:document.getElementById('exCategory').value,amount:amount,currency:document.getElementById('exCurrency').value,custom_fields:cf};
  var req;
  if(id){
    req=patchTable('transactions','id=eq.'+id,body,true);
  }else{
    body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='expense';body.status='recorded';
    req=postTable('transactions',body,true);
  }
  req.then(function(){closeModal('expenseModal');toast('✅ Expense saved');loadExpenses();})
    .catch(function(err){showMsg('expenseMsg',err.message||'Could not save.',true);});
}
function deleteExpenseConfirm(){
  var id=document.getElementById('exId').value;
  var record=EXPENSES_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('expenseModal');
  deleteWithUndo('transactions',record,loadExpenses,'Expense removed');
}
function duplicateExpense(){
  var id=document.getElementById('exId').value;
  var record=EXPENSES_CACHE.find(function(x){return x.id===id;});
  if(!record)return;
  closeModal('expenseModal');
  duplicateRecord('transactions',record,{},loadExpenses);
}
function toggleExpenseSelect(id){
  if(EXPENSES_BULK_SELECTED[id])delete EXPENSES_BULK_SELECTED[id];else EXPENSES_BULK_SELECTED[id]=true;
  updateExpensesBulkBar();
}
function clearExpenseSelection(){EXPENSES_BULK_SELECTED={};renderExpensesList();}
function updateExpensesBulkBar(){
  var bar=document.getElementById('expensesBulkBar');
  if(!bar)return;
  var count=Object.keys(EXPENSES_BULK_SELECTED).length;
  bar.style.display=count?'block':'none';
  if(count)document.getElementById('expensesBulkCount').textContent=count+' selected';
}
function bulkDeleteSelectedExpenses(){
  var ids=Object.keys(EXPENSES_BULK_SELECTED);
  if(!ids.length)return;
  if(!confirm('Delete '+ids.length+' selected expense(s)? This cannot be undone.'))return;
  Promise.all(ids.map(function(id){return deleteTable('transactions','id=eq.'+id,true);}))
    .then(function(){toast('✅ '+ids.length+' expense(s) deleted');EXPENSES_BULK_SELECTED={};loadExpenses();})
    .catch(function(err){toast(err.message||'Some deletions failed',true);loadExpenses();});
}
function exportExpensesRowsCsv(rows){
  var header=['Category','Amount','Currency','Payment Method','Purpose','Related Visitor','Date From','Date To'];
  var lines=[header.join(',')];
  rows.forEach(function(e){
    var cf=e.custom_fields||{};
    lines.push([e.category,e.amount,e.currency,cf.paymentMethod,cf.purpose,cf.relatedVisitor,cf.dateFrom,cf.dateTo].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='expenses.csv';a.click();
}
function exportExpensesCsv(){exportExpensesRowsCsv(getFilteredExpenses());}
function bulkExportSelectedExpenses(){
  var ids=Object.keys(EXPENSES_BULK_SELECTED);
  var rows=ids.length?EXPENSES_CACHE.filter(function(e){return EXPENSES_BULK_SELECTED[e.id];}):getFilteredExpenses();
  exportExpensesRowsCsv(rows);
}

// ------------------------------------------------------------
// COLD CALLING MODULE
// activities.type='cold_contact' (the contact) and 'cold_call_log' (each call)
// ------------------------------------------------------------
var CC_CONTACTS=[],CC_CALL_LOGS=[];
var CC_ACTIVE_CONTACT=null;
var CC_TIMER_INTERVAL=null,CC_TIMER_START=null,CC_TIMER_SECONDS=0;
var CC_GOOGLE_CONTACTS_TOKEN=null;

function setCcTab(tab){
  document.getElementById('ccTabManual').classList.toggle('active',tab==='manual');
  document.getElementById('ccTabImport').classList.toggle('active',tab==='import');
  document.getElementById('ccPaneManual').style.display=tab==='manual'?'block':'none';
  document.getElementById('ccPaneImport').style.display=tab==='import'?'block':'none';
}
function initColdCallingView(){
  Promise.all([
    getTable('activities','type=eq.cold_contact&order=created_at.desc',true),
    getTable('activities','type=eq.cold_call_log&order=created_at.desc',true)
  ]).then(function(res){
    CC_CONTACTS=res[0]||[];CC_CALL_LOGS=res[1]||[];
    renderCcStats();
    renderColdContacts();
    renderCallLogs();
  }).catch(function(){});
}
function renderCcStats(){
  var stats=[
    {value:CC_CONTACTS.length,label:'Total Contacts'},
    {value:CC_CALL_LOGS.length,label:'Calls Logged'},
    {value:CC_CALL_LOGS.filter(function(l){return (l.custom_fields||{}).outcome==='Interested';}).length,label:'Interested'}
  ];
  document.getElementById('ccStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function addColdContact(){
  var name=document.getElementById('ccName').value.trim();
  var category=document.getElementById('ccCategory').value;
  var phone=document.getElementById('ccPhone').value.trim();
  if(!name||!phone){toast('Name and phone are required.',true);return;}
  var body={title:'Cold Contact',custom_fields:{name:name,category:category,phone:phone,source:'manual'}};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='cold_contact';
  postTable('activities',body,true).then(function(){
    toast('✅ Contact added');
    document.getElementById('ccName').value='';document.getElementById('ccPhone').value='';
    initColdCallingView();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderColdContacts(){
  var q=(document.getElementById('ccSearch').value||'').trim().toLowerCase();
  var rows=CC_CONTACTS.filter(function(c){
    var cf=c.custom_fields||{};
    if(!q)return true;
    return ((cf.name||'')+' '+(cf.phone||'')).toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('ccContactsList');
  if(!rows.length){el.innerHTML='<div class="empty-hint">No contacts yet — add manually or import.</div>';return;}
  var today=new Date().toISOString().slice(0,10);
  el.innerHTML=rows.map(function(c){
    var cf=c.custom_fields||{};
    var overdue=cf.nextFollowUp && cf.nextFollowUp<today;
    return '<div class="att-row">'
      +'<div><div class="p-name">'+escapeHtml(cf.name||'—')
        +(cf.leadStatus?'<span class="p-roll">'+cf.leadStatus+'</span>':'')
        +(cf.source?'<span class="p-roll">'+cf.source+'</span>':'')+'</div>'
      +'<div class="p-meta">'+escapeHtml(cf.phone||'')+' · '+escapeHtml(cf.category||'')
        +(cf.nextFollowUp?(' · <span style="color:'+(overdue?'var(--err)':'var(--ink-3)')+';">Follow-up: '+cf.nextFollowUp+'</span>'):'')+'</div></div>'
      +'<div class="att-status-group">'
      +'<button class="btn btn-ghost btn-sm" style="width:auto;" onclick="openContactEditModal(\''+c.id+'\')">📋 Dashboard</button>'
      +'<a class="btn btn-ghost btn-sm" href="https://wa.me/'+(cf.phone||'').replace(/[^0-9]/g,'')+'" target="_blank" style="text-decoration:none;width:auto;">💬</a>'
      +'<button class="btn btn-primary btn-sm" style="width:auto;" onclick="openCallSession(\''+c.id+'\')">📞 Call</button>'
      +'</div></div>';
  }).join('');
}
var CC_ACTIVE_LEAD_STATUS='';
var CC_GALLERY_ITEMS=[];
function setLeadStatus(status){
  CC_ACTIVE_LEAD_STATUS=status;
  document.querySelectorAll('#ccLeadStatusTabs .tab').forEach(function(el){
    el.classList.toggle('active',el.getAttribute('data-status')===status);
  });
}
function openContactEditModal(id){
  var c=CC_CONTACTS.find(function(x){return x.id===id;});
  if(!c)return;
  var cf=c.custom_fields||{};
  clearMsg('ccEditMsg');
  document.getElementById('ccDashName').textContent='📋 '+(cf.name||'Contact')+' — Dashboard';
  document.getElementById('ccEditId').value=c.id;
  document.getElementById('ccEditName').value=cf.name||'';
  document.getElementById('ccEditCategory').value=cf.category||'Students/Parents';
  document.getElementById('ccEditPhone').value=cf.phone||'';
  setLeadStatus(cf.leadStatus||'');
  document.getElementById('ccFollowUpDate').value=cf.nextFollowUp||'';
  document.getElementById('ccDashNotes').value=cf.notes||'';
  document.getElementById('ccSocialLink').value=cf.socialLink||'';
  document.getElementById('ccMeetingLink').value=cf.meetingLink||'';
  document.getElementById('ccWaMessage').value='';
  CC_GALLERY_ITEMS=(cf.gallery||[]).slice();
  renderContactGallery();
  openModal('ccEditModal');
}
function renderContactGallery(){
  var el=document.getElementById('ccGalleryGrid');
  if(!CC_GALLERY_ITEMS.length){el.innerHTML='<div class="empty-hint">No files yet.</div>';return;}
  el.innerHTML=CC_GALLERY_ITEMS.map(function(item,i){
    var inner;
    if(item.kind==='image')inner='<img src="'+item.dataUrl+'">';
    else if(item.kind==='video')inner='<video src="'+item.dataUrl+'" muted></video>';
    else if(item.kind==='audio')inner='🎙️';
    else inner='📄';
    return '<div class="gallery-item" title="'+escapeHtml(item.name||'')+'">'+inner+'<span class="gi-remove" onclick="removeGalleryItem('+i+')">✕</span></div>';
  }).join('');
}
function removeGalleryItem(idx){
  CC_GALLERY_ITEMS.splice(idx,1);
  renderContactGallery();
}
function handleContactGalleryUpload(e){
  var f=e.target.files[0];
  if(!f)return;
  var kind=f.type.indexOf('image/')===0?'image':(f.type.indexOf('video/')===0?'video':'file');
  var reader=new FileReader();
  reader.onload=function(){
    CC_GALLERY_ITEMS.push({kind:kind,name:f.name,dataUrl:reader.result});
    renderContactGallery();
  };
  reader.readAsDataURL(f);
}
// ---- Voice note recording (MediaRecorder API) ----
var CC_MEDIA_RECORDER=null,CC_AUDIO_CHUNKS=[];
function toggleVoiceNoteRecording(){
  if(CC_MEDIA_RECORDER && CC_MEDIA_RECORDER.state==='recording'){
    CC_MEDIA_RECORDER.stop();
    return;
  }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('Voice recording not supported in this browser.',true);return;}
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    CC_AUDIO_CHUNKS=[];
    CC_MEDIA_RECORDER=new MediaRecorder(stream);
    CC_MEDIA_RECORDER.ondataavailable=function(e){CC_AUDIO_CHUNKS.push(e.data);};
    CC_MEDIA_RECORDER.onstop=function(){
      var blob=new Blob(CC_AUDIO_CHUNKS,{type:'audio/webm'});
      var reader=new FileReader();
      reader.onload=function(){
        CC_GALLERY_ITEMS.push({kind:'audio',name:'Voice note '+new Date().toLocaleTimeString(),dataUrl:reader.result});
        renderContactGallery();
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(function(t){t.stop();});
      document.getElementById('ccVoiceRecordBtn').textContent='🎙️ Record Voice Note';
    };
    CC_MEDIA_RECORDER.start();
    document.getElementById('ccVoiceRecordBtn').textContent='⏹️ Stop Recording';
    toast('🔴 Recording…');
  }).catch(function(){toast('Microphone access denied.',true);});
}
function prefillWaMessage(){
  var name=document.getElementById('ccEditName').value.trim();
  var notes=document.getElementById('ccDashNotes').value.trim();
  var social=document.getElementById('ccSocialLink').value.trim();
  var meeting=document.getElementById('ccMeetingLink').value.trim();
  var lines=['Hi '+name+',',''];
  if(notes)lines.push(notes,'');
  if(meeting)lines.push('Meeting link: '+meeting);
  if(social)lines.push('Reference: '+social);
  lines.push('','— '+CTX.company_name);
  document.getElementById('ccWaMessage').value=lines.join('\n');
}
function sendContactWhatsApp(){
  var phone=document.getElementById('ccEditPhone').value.trim();
  var text=document.getElementById('ccWaMessage').value.trim();
  if(!text){toast('Type a message or tap "Pull in notes + links" first.',true);return;}
  window.open('https://wa.me/'+phone.replace(/[^0-9]/g,'')+'?text='+encodeURIComponent(text),'_blank');
  if(CC_GALLERY_ITEMS.length)toast('Opened WhatsApp — attach gallery files manually inside the chat.');
}
function saveColdContactEdit(){
  var id=document.getElementById('ccEditId').value;
  var c=CC_CONTACTS.find(function(x){return x.id===id;});
  if(!c)return;
  var name=document.getElementById('ccEditName').value.trim();
  var phone=document.getElementById('ccEditPhone').value.trim();
  if(!name||!phone){showMsg('ccEditMsg','Name and phone are required.',true);return;}
  var cf=Object.assign({},c.custom_fields,{
    name:name,phone:phone,category:document.getElementById('ccEditCategory').value,
    leadStatus:CC_ACTIVE_LEAD_STATUS||null,
    nextFollowUp:document.getElementById('ccFollowUpDate').value||null,
    notes:document.getElementById('ccDashNotes').value.trim()||null,
    socialLink:document.getElementById('ccSocialLink').value.trim()||null,
    meetingLink:document.getElementById('ccMeetingLink').value.trim()||null,
    gallery:CC_GALLERY_ITEMS
  });
  patchTable('activities','id=eq.'+id,{custom_fields:cf},true).then(function(){
    toast('✅ Dashboard saved');
    closeModal('ccEditModal');
    initColdCallingView();
  }).catch(function(err){showMsg('ccEditMsg',err.message||'Could not save.',true);});
}
function deleteColdContact(){
  var id=document.getElementById('ccEditId').value;
  if(!confirm('Delete this contact? Its call logs will remain but become unlinked.'))return;
  deleteTable('activities','id=eq.'+id,true).then(function(){
    toast('Removed');
    closeModal('ccEditModal');
    initColdCallingView();
  }).catch(function(err){showMsg('ccEditMsg',err.message||'Could not delete.',true);});
}
function renderCallLogs(){
  var el=document.getElementById('ccCallLogsList');
  if(!CC_CALL_LOGS.length){el.innerHTML='<div class="empty-hint">No calls logged yet.</div>';return;}
  el.innerHTML=CC_CALL_LOGS.slice(0,15).map(function(l){
    var cf=l.custom_fields||{};
    var contact=CC_CONTACTS.find(function(c){return c.id===cf.contactId;});
    var cname=contact?(contact.custom_fields||{}).name:'Unknown';
    return '<div class="history-row"><span class="h-name">'+escapeHtml(cname)+' — '+escapeHtml(cf.outcome||'')+'</span>'
      +'<span class="h-stats"><span>'+(cf.durationLabel||'—')+'</span><span>'+escapeHtml((cf.notes||'').slice(0,30))+'</span></span></div>';
  }).join('');
}

// ---- Excel import ----
function handleCcExcelImport(e){
  var f=e.target.files[0];
  if(!f)return;
  var progEl=document.getElementById('ccImportProgress');
  progEl.innerHTML='<div class="empty-hint">Reading file…</div>';
  var reader=new FileReader();
  reader.onload=function(evt){
    var wb;
    try{wb=XLSX.read(evt.target.result,{type:'binary'});}catch(err){progEl.innerHTML='<div class="empty-hint">Could not read file.</div>';return;}
    var sheet=wb.Sheets[wb.SheetNames[0]];
    var rows=XLSX.utils.sheet_to_json(sheet,{defval:''});
    if(!rows.length){progEl.innerHTML='<div class="empty-hint">No rows found.</div>';return;}
    importContactRows(rows.map(function(r){
      var keys=Object.keys(r);
      function get(names){var k=keys.find(function(kk){return names.indexOf(kk.toLowerCase().trim())>-1;});return k?r[k]:'';}
      return {name:get(['name']),phone:get(['phone','mobile']),category:get(['category'])||'Students/Parents'};
    }),progEl);
  };
  reader.readAsBinaryString(f);
}
function importContactRows(rows,progEl){
  var valid=rows.filter(function(r){return r.name&&r.phone;});
  var skipped=rows.length-valid.length;
  if(!valid.length){
    progEl.innerHTML='<div class="empty-hint">Done — 0 imported, '+skipped+' skipped (missing name/phone).</div>';
    return;
  }
  var BATCH_SIZE=300;
  var batches=[];
  for(var i=0;i<valid.length;i+=BATCH_SIZE){
    batches.push(valid.slice(i,i+BATCH_SIZE).map(function(row){
      return {tenant_id:CTX.tenant_id,created_by:CTX.user_id,type:'cold_contact',title:'Cold Contact',
        custom_fields:{name:row.name,phone:row.phone,category:row.category||'Students/Parents',source:'imported'}};
    }));
  }
  var created=0,failedBatches=0;
  function nextBatch(i){
    if(i>=batches.length){
      var summary='Done — '+created+' imported, '+skipped+' skipped'+(failedBatches?', '+failedBatches+' batch(es) failed':'')+'.';
      progEl.innerHTML='<div class="empty-hint">'+summary+'</div>';
      initColdCallingView();
      return;
    }
    progEl.innerHTML='<div class="empty-hint">Importing batch '+(i+1)+' / '+batches.length+' ('+created+' done so far)…</div>';
    postTable('activities',batches[i],true).then(function(){
      created+=batches[i].length;
      nextBatch(i+1);
    }).catch(function(){
      failedBatches++;
      nextBatch(i+1);
    });
  }
  nextBatch(0);
}

// ---- Google Contacts import ----
function importGoogleContacts(){
  if(!window.google||!google.accounts||!google.accounts.oauth2){toast('Google sign-in still loading, try again.',true);return;}
  var tokenClient=google.accounts.oauth2.initTokenClient({
    client_id:GOOGLE_CLIENT_ID,
    scope:'https://www.googleapis.com/auth/contacts.readonly',
    callback:function(resp){
      if(resp.error){toast('Could not access contacts — '+resp.error,true);return;}
      CC_GOOGLE_CONTACTS_TOKEN=resp.access_token;
      fetchGoogleContactsList();
    }
  });
  tokenClient.requestAccessToken();
}
function fetchGoogleContactsList(){
  var progEl=document.getElementById('ccImportProgress');
  progEl.innerHTML='<div class="empty-hint">Fetching your Google Contacts…</div>';
  fetch('https://people.googleapis.com/v1/people/me/connections?personFields=names,phoneNumbers&pageSize=200',{
    headers:{'Authorization':'Bearer '+CC_GOOGLE_CONTACTS_TOKEN}
  }).then(function(r){return r.json();}).then(function(data){
    var connections=data.connections||[];
    var rows=connections.map(function(p){
      var name=(p.names&&p.names[0]&&p.names[0].displayName)||'';
      var phone=(p.phoneNumbers&&p.phoneNumbers[0]&&p.phoneNumbers[0].value)||'';
      return {name:name,phone:phone,category:'Friends/Relatives/Anonymous'};
    }).filter(function(r){return r.name&&r.phone;});
    if(!rows.length){progEl.innerHTML='<div class="empty-hint">No contacts with phone numbers found.</div>';return;}
    importContactRows(rows,progEl);
  }).catch(function(){progEl.innerHTML='<div class="empty-hint">Could not fetch Google Contacts.</div>';});
}

// ---- Call session (timer + log) ----
function openCallSession(contactId){
  CC_ACTIVE_CONTACT=CC_CONTACTS.find(function(c){return c.id===contactId;});
  if(!CC_ACTIVE_CONTACT)return;
  var cf=CC_ACTIVE_CONTACT.custom_fields||{};
  document.getElementById('ccModalContactName').textContent='📞 '+(cf.name||'Contact');
  document.getElementById('ccDialLink').href='tel:'+(cf.phone||'');
  document.getElementById('ccTimerDisplay').textContent='00:00';
  document.getElementById('ccStartBtn').style.display='inline-flex';
  document.getElementById('ccEndBtn').style.display='none';
  document.getElementById('ccLogFormWrap').style.display='none';
  document.getElementById('ccOutcome').value='Interested';
  document.getElementById('ccNotes').value='';
  CC_TIMER_SECONDS=0;
  clearInterval(CC_TIMER_INTERVAL);
  openModal('callSessionModal');
}
function closeCallSessionModal(){
  clearInterval(CC_TIMER_INTERVAL);
  stopVoiceToText();
  closeModal('callSessionModal');
}
function startCallTimer(){
  CC_TIMER_START=Date.now();
  document.getElementById('ccStartBtn').style.display='none';
  document.getElementById('ccEndBtn').style.display='inline-flex';
  CC_TIMER_INTERVAL=setInterval(function(){
    var elapsed=Math.floor((Date.now()-CC_TIMER_START)/1000);
    var m=Math.floor(elapsed/60),s=elapsed%60;
    document.getElementById('ccTimerDisplay').textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
  },1000);
}
function endCallTimer(){
  clearInterval(CC_TIMER_INTERVAL);
  CC_TIMER_SECONDS=Math.floor((Date.now()-CC_TIMER_START)/1000);
  var m=Math.floor(CC_TIMER_SECONDS/60),s=CC_TIMER_SECONDS%60;
  var label=m+'m '+s+'s';
  document.getElementById('ccDurationDisplay').value=label;
  document.getElementById('ccEndBtn').style.display='none';
  document.getElementById('ccLogFormWrap').style.display='block';
}
function saveCallLog(){
  if(!CC_ACTIVE_CONTACT)return;
  var m=Math.floor(CC_TIMER_SECONDS/60),s=CC_TIMER_SECONDS%60;
  var body={person_id:null,title:'Call Log',custom_fields:{
    contactId:CC_ACTIVE_CONTACT.id,date:new Date().toISOString().slice(0,10),
    durationSeconds:CC_TIMER_SECONDS,durationLabel:m+'m '+s+'s',
    outcome:document.getElementById('ccOutcome').value,notes:document.getElementById('ccNotes').value.trim()
  }};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='cold_call_log';
  postTable('activities',body,true).then(function(){
    toast('✅ Call logged');
    closeCallSessionModal();
    initColdCallingView();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}

// ---- Voice-to-text (Web Speech API) ----
var CC_RECOGNITION=null,CC_RECOGNITION_TARGET=null;
function toggleVoiceToText(targetId){
  var SpeechRec=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRec){toast('Voice input is not supported in this browser.',true);return;}
  if(CC_RECOGNITION){stopVoiceToText();return;}
  CC_RECOGNITION_TARGET=targetId;
  CC_RECOGNITION=new SpeechRec();
  CC_RECOGNITION.continuous=true;
  CC_RECOGNITION.interimResults=false;
  CC_RECOGNITION.onresult=function(event){
    var textarea=document.getElementById(targetId);
    var transcript='';
    for(var i=event.resultIndex;i<event.results.length;i++){
      if(event.results[i].isFinal)transcript+=event.results[i][0].transcript;
    }
    if(transcript)textarea.value=(textarea.value?textarea.value+' ':'')+transcript.trim();
  };
  CC_RECOGNITION.onerror=function(){stopVoiceToText();};
  CC_RECOGNITION.onend=function(){
    if(CC_RECOGNITION)CC_RECOGNITION.start(); // keep listening until user taps stop
  };
  CC_RECOGNITION.start();
  var micBtn=document.getElementById('ccMicBtn');
  if(micBtn){micBtn.textContent='🔴';micBtn.title='Tap to stop';}
}
function stopVoiceToText(){
  if(CC_RECOGNITION){
    CC_RECOGNITION.onend=null;
    CC_RECOGNITION.stop();
    CC_RECOGNITION=null;
  }
  var micBtn=document.getElementById('ccMicBtn');
  if(micBtn)micBtn.textContent='🎤';
}

// ---- Customizable combined Call Report (Manual + Imported, selection-based) ----
var CR_SELECTED={};
function openCallReportBuilder(){
  CR_SELECTED={};
  CC_CONTACTS.forEach(function(c){CR_SELECTED[c.id]=true;}); // default: all selected
  document.getElementById('crSourceFilter').value='';
  document.getElementById('crOnlyCalledFilter').value='';
  renderCallReportSelection();
  openModal('callReportModal');
}
function getCallReportCandidates(){
  var source=document.getElementById('crSourceFilter').value;
  var onlyCalled=document.getElementById('crOnlyCalledFilter').value==='yes';
  return CC_CONTACTS.filter(function(c){
    var cf=c.custom_fields||{};
    if(source && cf.source!==source)return false;
    if(onlyCalled && !CC_CALL_LOGS.some(function(l){return (l.custom_fields||{}).contactId===c.id;}))return false;
    return true;
  });
}
function renderCallReportSelection(){
  var rows=getCallReportCandidates();
  var el=document.getElementById('crSelectionList');
  if(!rows.length){el.innerHTML='<div class="empty-hint">No contacts match this filter.</div>';return;}
  el.innerHTML=rows.map(function(c){
    var cf=c.custom_fields||{};
    var calls=CC_CALL_LOGS.filter(function(l){return (l.custom_fields||{}).contactId===c.id;});
    var checked=CR_SELECTED[c.id]?'checked':'';
    return '<label class="rb-check-row"><input type="checkbox" '+checked+' onchange="toggleCrSelect(\''+c.id+'\')"> '
      +escapeHtml(cf.name||'—')+' <span style="color:var(--ink-3);">('+escapeHtml(cf.category||'')+(cf.source?' · '+cf.source:'')+' · '+calls.length+' call'+(calls.length!==1?'s':'')+')</span></label>';
  }).join('');
}
function toggleCrSelect(id){
  CR_SELECTED[id]=!CR_SELECTED[id];
}
function toggleSelectAllCallReport(){
  var rows=getCallReportCandidates();
  var allSelected=rows.every(function(c){return CR_SELECTED[c.id];});
  rows.forEach(function(c){CR_SELECTED[c.id]=!allSelected;});
  renderCallReportSelection();
}
function buildCallReportData(){
  var selectedIds=Object.keys(CR_SELECTED).filter(function(id){return CR_SELECTED[id];});
  return selectedIds.map(function(id){
    var c=CC_CONTACTS.find(function(x){return x.id===id;});
    if(!c)return null;
    var cf=c.custom_fields||{};
    var calls=CC_CALL_LOGS.filter(function(l){return (l.custom_fields||{}).contactId===id;});
    return {contact:c,cf:cf,calls:calls};
  }).filter(Boolean);
}
function downloadCallReport(){
  var data=buildCallReportData();
  if(!data.length){toast('Select at least one contact.',true);return;}
  var brand=(CTX.config&&CTX.config.brand)||{};
  var accent=brand.accentColor||'#2563eb';
  var logo=brand.logoUrl;
  var html='<div style="font-family:\'Inter\',sans-serif;max-width:680px;margin:0 auto;">'
    +'<div style="text-align:center;margin-bottom:18px;border-bottom:3px solid '+accent+';padding-bottom:14px;">'
    +(logo?'<img src="'+logo+'" style="width:52px;height:52px;object-fit:contain;margin-bottom:8px;">':'')
    +'<div style="font-size:18px;font-weight:700;">'+escapeHtml(CTX.company_name)+'</div>'
    +'<div style="font-size:13px;font-weight:600;margin-top:4px;color:'+accent+';">COLD CALLING REPORT</div>'
    +'<div style="font-size:11px;color:#888;margin-top:4px;">'+new Date().toLocaleDateString()+' · '+data.length+' contact(s)</div></div>';
  data.forEach(function(d){
    html+='<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ddd;">'
      +'<div style="font-size:14px;font-weight:700;">'+escapeHtml(d.cf.name||'—')+' <span style="font-weight:400;font-size:11px;color:#888;">('+escapeHtml(d.cf.category||'')+' · '+escapeHtml(d.cf.phone||'')+')</span></div>'
      +(d.cf.leadStatus||d.cf.nextFollowUp?'<div style="font-size:11px;color:'+accent+';margin-top:2px;">'+(d.cf.leadStatus?'Status: '+escapeHtml(d.cf.leadStatus):'')+(d.cf.nextFollowUp?' · Next follow-up: '+d.cf.nextFollowUp:'')+'</div>':'');
    if(d.calls.length){
      html+='<table style="width:100%;font-size:12px;margin-top:6px;border-collapse:collapse;">'
        +'<tr style="color:#666;"><th style="text-align:left;">Date</th><th style="text-align:left;">Duration</th><th style="text-align:left;">Outcome</th><th style="text-align:left;">Notes</th></tr>'
        +d.calls.map(function(l){var c=l.custom_fields||{};return '<tr><td>'+(c.date||'')+'</td><td>'+(c.durationLabel||'')+'</td><td>'+escapeHtml(c.outcome||'')+'</td><td>'+escapeHtml(c.notes||'')+'</td></tr>';}).join('')
        +'</table>';
    }else{
      html+='<div style="font-size:11.5px;color:#888;margin-top:4px;">No calls logged yet.</div>';
    }
    html+='</div>';
  });
  html+='</div>';
  document.getElementById('printArea').innerHTML=html;
  setTimeout(function(){window.print();},80);
}
function shareCallReportWhatsApp(){
  var data=buildCallReportData();
  if(!data.length){toast('Select at least one contact.',true);return;}
  var lines=[CTX.company_name,'Cold Calling Report — '+data.length+' contact(s)',''];
  data.forEach(function(d){
    var lastCall=d.calls[0];
    lines.push('• '+d.cf.name+' — '+(lastCall?((lastCall.custom_fields||{}).outcome||'called'):'not called yet'));
  });
  window.open('https://wa.me/?text='+encodeURIComponent(lines.join('\n')),'_blank');
}

// ------------------------------------------------------------
// COORDINATOR SHIFTS MODULE (stored as activities.type='coordinator_shift')
// ------------------------------------------------------------
var COORD_SHIFTS=[];
function loadCoordinatorShifts(){
  var listEl=document.getElementById('coordShiftsList');
  listEl.innerHTML='<div class="empty-hint">Loading…</div>';
  if(!document.getElementById('coordDate').value)document.getElementById('coordDate').value=new Date().toISOString().slice(0,10);
  getTable('activities','type=eq.coordinator_shift&order=created_at.desc',true).then(function(rows){
    COORD_SHIFTS=rows||[];
    renderCoordinatorStats();
    renderCoordinatorShifts();
  }).catch(function(err){
    listEl.innerHTML='<div class="empty-hint">Could not load: '+(err.message||'')+'</div>';
  });
}
function computeShiftDuration(checkIn,checkOut){
  if(!checkIn||!checkOut)return '—';
  var a=checkIn.split(':'),b=checkOut.split(':');
  var mins=(parseInt(b[0])*60+parseInt(b[1]))-(parseInt(a[0])*60+parseInt(a[1]));
  if(mins<0)mins+=24*60;
  return Math.floor(mins/60)+'h '+(mins%60)+'m';
}
function renderCoordinatorStats(){
  var today=new Date().toISOString().slice(0,10);
  var todayCount=COORD_SHIFTS.filter(function(s){return (s.custom_fields||{}).date===today;}).length;
  var uniqueCoords={};
  COORD_SHIFTS.forEach(function(s){var n=(s.custom_fields||{}).name;if(n)uniqueCoords[n]=true;});
  var stats=[
    {value:COORD_SHIFTS.length,label:'Total Shift Entries'},
    {value:todayCount,label:'Today'},
    {value:Object.keys(uniqueCoords).length,label:'Coordinators'}
  ];
  document.getElementById('coordStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function saveCoordinatorShift(){
  var name=document.getElementById('coordName').value.trim();
  var date=document.getElementById('coordDate').value;
  if(!name||!date){toast('Coordinator name and date are required.',true);return;}
  var body={title:'Coordinator Shift',custom_fields:{
    name:name,date:date,shift:document.getElementById('coordShift').value,
    checkIn:document.getElementById('coordCheckIn').value||null,
    checkOut:document.getElementById('coordCheckOut').value||null,
    notes:document.getElementById('coordNotes').value.trim()||null
  }};
  body.tenant_id=CTX.tenant_id;body.created_by=CTX.user_id;body.type='coordinator_shift';
  postTable('activities',body,true).then(function(){
    toast('✅ Shift logged');
    document.getElementById('coordName').value='';document.getElementById('coordCheckIn').value='';document.getElementById('coordCheckOut').value='';document.getElementById('coordNotes').value='';
    loadCoordinatorShifts();
  }).catch(function(err){toast(err.message||'Could not save.',true);});
}
function renderCoordinatorShifts(){
  var q=(document.getElementById('coordSearch').value||'').trim().toLowerCase();
  var rows=COORD_SHIFTS.filter(function(s){
    var cf=s.custom_fields||{};
    if(!q)return true;
    return (cf.name||'').toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('coordShiftsList');
  if(!rows.length){el.innerHTML='<div class="empty-hint">No shift entries yet.</div>';return;}
  el.innerHTML=rows.map(function(s){
    var cf=s.custom_fields||{};
    return '<div class="history-row"><span class="h-name">'+escapeHtml(cf.name||'—')+' · '+escapeHtml(cf.shift||'')+'</span>'
      +'<span class="h-stats"><span>'+cf.date+'</span><span>'+(cf.checkIn||'—')+' → '+(cf.checkOut||'—')+'</span><span>'+computeShiftDuration(cf.checkIn,cf.checkOut)+'</span>'
      +'<span class="mr-remove" style="cursor:pointer;" onclick="deleteCoordinatorShift(\''+s.id+'\')">✕</span></span></div>';
  }).join('');
}
function deleteCoordinatorShift(id){
  if(!confirm('Delete this shift entry?'))return;
  deleteTable('activities','id=eq.'+id,true).then(function(){
    toast('Removed');
    loadCoordinatorShifts();
  }).catch(function(err){toast(err.message||'Could not delete.',true);});
}
function exportCoordinatorCsv(){
  var header=['Name','Date','Shift','Check-in','Check-out','Duration','Notes'];
  var lines=[header.join(',')];
  COORD_SHIFTS.forEach(function(s){
    var cf=s.custom_fields||{};
    lines.push([cf.name,cf.date,cf.shift,cf.checkIn,cf.checkOut,computeShiftDuration(cf.checkIn,cf.checkOut),cf.notes].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='coordinator_shifts.csv';a.click();
}

// ------------------------------------------------------------
// GLOBAL SEARCH (command palette — searches everything already
// loaded this session, across every module, with keyboard nav)
// ------------------------------------------------------------
var GS_ACTIVE_INDEX=-1;
var GS_FLAT_RESULTS=[];

document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){
    e.preventDefault();
    openGlobalSearch();
  }
});
function openGlobalSearch(){
  if(!CTX)return; // not logged in yet
  document.getElementById('gsearchOverlay').classList.add('show');
  var input=document.getElementById('gsearchInput');
  input.value='';
  input.focus();
  runGlobalSearch(); // instant results from whatever's already cached
  // Then refresh EVERY module's data in the background — previously only
  // People was ever refreshed here, so anything saved in a module that
  // hadn't been opened yet this session (or opened before the save) was
  // invisible to search even though it existed in the database. Re-run
  // search once fresh data arrives so results update in place.
  ensureAllDataLoaded().then(function(){
    if(document.getElementById('gsearchOverlay').classList.contains('show'))runGlobalSearch();
  });
}
function closeGlobalSearch(){
  document.getElementById('gsearchOverlay').classList.remove('show');
}
function gsHighlight(text,q){
  text=escapeHtml(text||'');
  if(!q)return text;
  var idx=text.toLowerCase().indexOf(q.toLowerCase());
  if(idx<0)return text;
  return text.slice(0,idx)+'<mark>'+text.slice(idx,idx+q.length)+'</mark>'+text.slice(idx+q.length);
}
function runGlobalSearch(){
  var q=(document.getElementById('gsearchInput').value||'').trim().toLowerCase();
  var groups=[];

  function addGroup(label,icon,items){
    if(items.length)groups.push({label:label,icon:icon,items:items});
  }
  function match(hay){return !q || hay.toLowerCase().indexOf(q)>-1;}

  if(q){
    addGroup('People',(CTX.config&&CTX.config.terminology&&CTX.config.terminology.entity_person)||'👤',
      PEOPLE_CACHE.filter(function(p){var ac=(p.custom_fields&&p.custom_fields.academic)||{};return match((p.full_name||'')+' '+(ac.rollNo||'')+' '+(p.phone||''));})
        .slice(0,6).map(function(p){return {title:p.full_name,sub:(p.phone||p.email||''),action:function(){switchView('people');setTimeout(function(){openPersonModal(p.id);},150);}};}));

    addGroup('Results',(CTX.config&&CTX.config.terminology&&CTX.config.terminology.entity_person)||'🎓',
      PEOPLE_CACHE.filter(function(p){return computeResult(p.custom_fields) && match(p.full_name||'');})
        .slice(0,4).map(function(p){var r=computeResult(p.custom_fields);return {title:p.full_name,sub:r.pct+'% · '+(r.pass?'Pass':'Fail'),action:function(){switchView('results');setTimeout(function(){showResultProfile(p.id);},150);}};}));

    addGroup('Activities','📋',ACTIVITIES_CACHE.filter(function(a){return match(a.title||'');})
      .slice(0,5).map(function(a){return {title:a.title,sub:a.stage||'',action:function(){switchView('activities');setTimeout(function(){openActivityModal(a.id);},150);}};}));

    addGroup('Fees','💳',FEES_CACHE.filter(function(f){var p=findPersonById(f.person_id)||{};return match((p.full_name||'')+' '+(f.category||''));})
      .slice(0,5).map(function(f){var p=findPersonById(f.person_id)||{};var r=computeFeeStatus(f);return {title:(p.full_name||'—')+' — '+f.category,sub:currencySymbol(f.currency)+r.pending+' pending',action:function(){switchView('fees');setTimeout(function(){showFeeProfile(f.id);},150);}};}));

    addGroup('Expenses','💸',(EXPENSES_CACHE||[]).filter(function(e){var cf=e.custom_fields||{};return match((cf.purpose||'')+' '+(e.category||''));})
      .slice(0,4).map(function(e){var cf=e.custom_fields||{};return {title:cf.purpose||e.category,sub:currencySymbol(e.currency)+e.amount,action:function(){switchView('expenses');setTimeout(function(){openExpenseModal(e.id);},150);}};}));

    addGroup('Hostel','🏠',(HOSTEL_ROOMS||[]).filter(function(r){var cf=r.custom_fields||{};return match((cf.studentName||'')+' '+(cf.roomNo||''));})
      .slice(0,4).map(function(r){var cf=r.custom_fields||{};return {title:cf.studentName,sub:'Room '+cf.roomNo,action:function(){switchView('hostel');setTimeout(function(){setHostelTab('rooms');},150);}};}));

    addGroup('Student Care','🧑‍⚕️',(CARE_DISPUTES||[]).concat(CARE_COMPLAINTS||[]).filter(function(r){var cf=r.custom_fields||{};return match(cf.studentName||'');})
      .slice(0,4).map(function(r){var cf=r.custom_fields||{};var kind=r.type==='care_dispute'?'dispute':'complaint';return {title:cf.studentName,sub:capitalize(kind),action:function(){switchView('studentcare');setTimeout(function(){setCareTab(kind+'s');},150);}};}));

    addGroup('Library','📚',(LIBRARY_CACHE||[]).filter(function(l){var cf=l.custom_fields||{};var p=findPersonById(l.person_id)||{};return match((p.full_name||'')+' '+(cf.serialNo||''));})
      .slice(0,4).map(function(l){var p=findPersonById(l.person_id)||{};var cf=l.custom_fields||{};return {title:p.full_name||'Serial '+cf.serialNo,sub:cf.date||'',action:function(){switchView('library');}};}));

    addGroup('Marketing','📣',(MARKETING_CACHE||[]).filter(function(m){var cf=m.custom_fields||{};return match((cf.caption||'')+' '+(cf.campaign||''));})
      .slice(0,4).map(function(m){var cf=m.custom_fields||{};return {title:cf.caption||cf.campaign||'Asset',sub:cf.platform||'',action:function(){switchView('marketing');setTimeout(function(){showMarketingDetail(m.id);},150);}};}));

    addGroup('Cold Calling','📞',(CC_CONTACTS||[]).filter(function(c){var cf=c.custom_fields||{};return match((cf.name||'')+' '+(cf.phone||''));})
      .slice(0,4).map(function(c){var cf=c.custom_fields||{};return {title:cf.name,sub:cf.phone,action:function(){switchView('coldcalling');setTimeout(function(){openContactEditModal(c.id);},150);}};}));

    addGroup('Coordinator','🧑‍💼',(COORD_SHIFTS||[]).filter(function(s){var cf=s.custom_fields||{};return match(cf.name||'');})
      .slice(0,4).map(function(s){var cf=s.custom_fields||{};return {title:cf.name,sub:cf.date+' · '+cf.shift,action:function(){switchView('coordinator');}};}));
  }

  renderGlobalSearchResults(groups,q);
}
function renderGlobalSearchResults(groups,q){
  GS_FLAT_RESULTS=[];
  var el=document.getElementById('gsearchResults');
  if(!q){
    el.innerHTML='<div class="gsearch-empty">Start typing to search across People, Fees, Results, Activities, Hostel, Cold Calling and more…</div>';
    GS_ACTIVE_INDEX=-1;
    return;
  }
  if(!groups.length){
    el.innerHTML='<div class="gsearch-empty">No results for "'+escapeHtml(q)+'"</div>';
    GS_ACTIVE_INDEX=-1;
    return;
  }
  var html='';
  groups.forEach(function(g){
    html+='<div class="gsearch-group-label">'+g.icon+' '+g.label+'</div>';
    g.items.forEach(function(item){
      var idx=GS_FLAT_RESULTS.length;
      GS_FLAT_RESULTS.push(item);
      html+='<div class="gsearch-item" data-idx="'+idx+'" onclick="runGsAction('+idx+')">'
        +'<div class="gi-icon">'+g.icon+'</div>'
        +'<div class="gi-text"><div class="gi-title">'+gsHighlight(item.title,q)+'</div><div class="gi-sub">'+escapeHtml(item.sub||'')+'</div></div>'
        +'</div>';
    });
  });
  el.innerHTML=html;
  GS_ACTIVE_INDEX=-1;
}
function runGsAction(idx){
  var item=GS_FLAT_RESULTS[idx];
  if(!item)return;
  closeGlobalSearch();
  item.action();
}
function handleGlobalSearchKey(e){
  var items=document.querySelectorAll('.gsearch-item');
  if(e.key==='Escape'){closeGlobalSearch();return;}
  if(e.key==='ArrowDown'){e.preventDefault();GS_ACTIVE_INDEX=Math.min(GS_ACTIVE_INDEX+1,items.length-1);updateGsActiveHighlight(items);}
  if(e.key==='ArrowUp'){e.preventDefault();GS_ACTIVE_INDEX=Math.max(GS_ACTIVE_INDEX-1,0);updateGsActiveHighlight(items);}
  if(e.key==='Enter' && GS_ACTIVE_INDEX>=0 && items[GS_ACTIVE_INDEX]){
    runGsAction(parseInt(items[GS_ACTIVE_INDEX].getAttribute('data-idx')));
  }
}
function updateGsActiveHighlight(items){
  items.forEach(function(el,i){el.classList.toggle('active',i===GS_ACTIVE_INDEX);});
  if(items[GS_ACTIVE_INDEX])items[GS_ACTIVE_INDEX].scrollIntoView({block:'nearest'});
}

// ------------------------------------------------------------
// ADMIN PANEL — Team invites, Role Permissions, Notices
// ------------------------------------------------------------
var ADMIN_TAB='team';
var ALL_MODULES=[
  {key:'people',label:'People'},{key:'activities',label:'Activities'},{key:'results',label:'Results'},
  {key:'attendance',label:'Attendance'},{key:'fees',label:'Fees'},{key:'expenses',label:'Expenses'},
  {key:'hostel',label:'Hostel'},{key:'studentcare',label:'Student Care'},{key:'library',label:'Library'},
  {key:'marketing',label:'Marketing'},{key:'coldcalling',label:'Cold Calling'},{key:'coordinator',label:'Coordinator'},
  {key:'reportbuilder',label:'Reports'},{key:'adminpanel',label:'Admin Panel'}
];
var ALL_ROLES=['admin','manager','staff','viewer'];

function setAdminTab(tab){
  ADMIN_TAB=tab;
  ['Team','Permissions','Notices'].forEach(function(t){
    var tKey=t.toLowerCase();
    document.getElementById('apTab'+t).classList.toggle('active',tKey===tab);
    document.getElementById('apPane'+t).style.display=(tKey===tab)?'block':'none';
  });
  if(tab==='permissions')renderPermGrid();
  if(tab==='notices')loadNotices();
}
function initAdminPanel(){
  if(CTX.role!=='owner' && CTX.role!=='admin'){
    document.getElementById('viewAdminpanel').innerHTML='<div class="empty-hint" style="padding:30px;">Only Admins and the Owner can access this panel.</div>';
    return;
  }
  setAdminTab('team');
  loadTeamMembers();
}

// ---- Team ----
function loadTeamMembers(){
  var el=document.getElementById('apTeamList');
  el.innerHTML='<div class="empty-hint">Loading…</div>';
  rpc('list_team_members',{},true).then(function(rows){
    renderTeamList(rows||[]);
  }).catch(function(err){
    el.innerHTML='<div class="empty-hint">'+friendlyErrorMessage(err)+'</div>';
  });
}
function renderTeamList(rows){
  var el=document.getElementById('apTeamList');
  if(!rows.length){el.innerHTML='<div class="empty-hint">No team members yet.</div>';return;}
  el.innerHTML=rows.map(function(u){
    var roleOptions=['owner','admin','manager','staff','viewer'].map(function(r){return '<option value="'+r+'"'+(r===u.role?' selected':'')+'>'+capitalize(r)+'</option>';}).join('');
    return '<div class="att-row">'
      +'<div><div class="p-name">'+escapeHtml(u.name||u.email||'—')+(u.is_pending?'<span class="p-roll" style="background:var(--warn);color:#fff;">pending</span>':'')+(!u.is_active?'<span class="p-roll" style="background:var(--err);color:#fff;">inactive</span>':'')+'</div>'
      +'<div class="p-meta">'+escapeHtml(u.email||'')+'</div></div>'
      +'<div class="att-status-group">'
      +(u.role==='owner'?'<span class="pf-badge pass">Owner</span>':
        '<select style="width:auto;padding:4px 8px;font-size:12px;" onchange="changeTeamMemberRole(\''+u.id+'\',this.value)">'+roleOptions+'</select>'
        +'<button class="btn btn-ghost btn-sm" style="width:auto;" onclick="toggleTeamMemberActive(\''+u.id+'\','+(!u.is_active)+')">'+(u.is_active?'Deactivate':'Activate')+'</button>'
        +'<button class="btn btn-danger btn-sm" style="width:auto;" onclick="removeTeamMemberConfirm(\''+u.id+'\')">✕</button>')
      +'</div></div>';
  }).join('');
}
function sendTeamInvite(){
  var name=document.getElementById('apInviteName').value.trim();
  var email=document.getElementById('apInviteEmail').value.trim();
  var role=document.getElementById('apInviteRole').value;
  if(!name||!email){showMsg('apInviteMsg','Name and email are required.',true);return;}
  rpc('invite_team_member',{p_email:email,p_name:name,p_role:role},true).then(function(){
    showMsg('apInviteMsg','✅ Invite created — '+email+' can now sign up or sign in to join automatically.',false);
    document.getElementById('apInviteName').value='';document.getElementById('apInviteEmail').value='';
    loadTeamMembers();
  }).catch(function(err){
    showMsg('apInviteMsg',friendlyErrorMessage(err)||'Could not send invite.',true);
  });
}
function changeTeamMemberRole(userId,role){
  rpc('update_team_member',{p_user_id:userId,p_role:role},true).then(function(){
    toast('✅ Role updated');
    loadTeamMembers();
  }).catch(function(err){toast(err.message||'Could not update role.',true);loadTeamMembers();});
}
function toggleTeamMemberActive(userId,newState){
  rpc('update_team_member',{p_user_id:userId,p_is_active:newState},true).then(function(){
    toast(newState?'✅ Activated':'Deactivated');
    loadTeamMembers();
  }).catch(function(err){toast(err.message||'Could not update.',true);});
}
function removeTeamMemberConfirm(userId){
  if(!confirm('Remove this team member? This cannot be undone.'))return;
  rpc('remove_team_member',{p_user_id:userId},true).then(function(){
    toast('Removed');
    loadTeamMembers();
  }).catch(function(err){toast(err.message||'Could not remove.',true);});
}

// ---- Permissions ----
function renderPermGrid(){
  var perms=(CTX.config&&CTX.config.permissions)||{};
  var html='<table class="rp-table" style="min-width:640px;"><tr><th style="text-align:left;">Module</th>'+ALL_ROLES.map(function(r){return '<th>'+capitalize(r)+'</th>';}).join('')+'</tr>';
  ALL_MODULES.forEach(function(m){
    html+='<tr><td>'+m.label+'</td>'+ALL_ROLES.map(function(r){
      var allowed=(perms[r]||[]).indexOf('*')>-1 || (perms[r]||[]).indexOf(m.key)>-1;
      return '<td style="text-align:center;"><input type="checkbox" data-role="'+r+'" data-module="'+m.key+'" '+(allowed?'checked':'')+'></td>';
    }).join('')+'</tr>';
  });
  html+='</table>';
  document.getElementById('apPermGrid').innerHTML=html;
}
function savePermissions(){
  var perms={};
  ALL_ROLES.forEach(function(r){perms[r]=[];});
  document.querySelectorAll('#apPermGrid input[type=checkbox]').forEach(function(cb){
    if(cb.checked)perms[cb.getAttribute('data-role')].push(cb.getAttribute('data-module'));
  });
  perms.owner=['*'];
  var cfg=JSON.parse(JSON.stringify(CTX.config||{}));
  cfg.permissions=perms;
  patchTable('tenant_config','tenant_id=eq.'+CTX.tenant_id,{config:cfg},true).then(function(){
    CTX.config=cfg;
    showMsg('apPermMsg','✅ Permissions saved.',false);
    toast('✅ Permissions updated');
  }).catch(function(err){
    showMsg('apPermMsg',err.message||'Could not save.',true);
  });
}

// ---- Notices ----
var NOTICE_AUDIO=null,NOTICE_VIDEO=null;
var NT_MEDIA_RECORDER=null,NT_AUDIO_CHUNKS=[];
function toggleNoticeVoiceRecording(){
  if(NT_MEDIA_RECORDER && NT_MEDIA_RECORDER.state==='recording'){NT_MEDIA_RECORDER.stop();return;}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('Voice recording not supported here.',true);return;}
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    NT_AUDIO_CHUNKS=[];
    NT_MEDIA_RECORDER=new MediaRecorder(stream);
    NT_MEDIA_RECORDER.ondataavailable=function(e){NT_AUDIO_CHUNKS.push(e.data);};
    NT_MEDIA_RECORDER.onstop=function(){
      var blob=new Blob(NT_AUDIO_CHUNKS,{type:'audio/webm'});
      var reader=new FileReader();
      reader.onload=function(){
        NOTICE_AUDIO=reader.result;
        document.getElementById('ntMediaPreview').innerHTML='<audio controls src="'+NOTICE_AUDIO+'"></audio>';
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(function(t){t.stop();});
      document.getElementById('ntVoiceBtn').textContent='🎙️ Record Audio';
    };
    NT_MEDIA_RECORDER.start();
    document.getElementById('ntVoiceBtn').textContent='⏹️ Stop';
    toast('🔴 Recording…');
  }).catch(function(){toast('Microphone access denied.',true);});
}
function handleNoticeVideo(e){
  var f=e.target.files[0];
  if(!f)return;
  var reader=new FileReader();
  reader.onload=function(){
    NOTICE_VIDEO=reader.result;
    document.getElementById('ntMediaPreview').innerHTML='<video controls src="'+NOTICE_VIDEO+'" style="max-width:100%;max-height:180px;"></video>';
  };
  reader.readAsDataURL(f);
}
function publishNotice(){
  var title=document.getElementById('ntTitle').value.trim();
  var body=document.getElementById('ntBody').value.trim();
  if(!title||!body){toast('Title and message are required.',true);return;}
  var record={title:title,custom_fields:{
    body:body,priority:document.getElementById('ntPriority').value,
    audience:document.getElementById('ntAudience').value||null,
    color:document.getElementById('ntColor').value,
    audioDataUrl:NOTICE_AUDIO,videoDataUrl:NOTICE_VIDEO,
    postedBy:CTX.name,postedAt:new Date().toISOString()
  }};
  record.tenant_id=CTX.tenant_id;record.created_by=CTX.user_id;record.type='notice';
  postTable('activities',record,true).then(function(){
    toast('📢 Notice published');
    document.getElementById('ntTitle').value='';document.getElementById('ntBody').value='';
    NOTICE_AUDIO=null;NOTICE_VIDEO=null;
    document.getElementById('ntMediaPreview').innerHTML='';
    loadNotices();
  }).catch(function(err){toast(err.message||'Could not publish.',true);});
}
function loadNotices(){
  var el=document.getElementById('apNoticesList');
  el.innerHTML='<div class="empty-hint">Loading…</div>';
  getTable('activities','type=eq.notice&order=created_at.desc',true).then(function(rows){
    if(!rows.length){el.innerHTML='<div class="empty-hint">No notices published yet.</div>';return;}
    el.innerHTML=rows.map(function(n){
      var cf=n.custom_fields||{};
      return '<div class="history-row"><span class="h-name">'+escapeHtml(n.title)+' <span class="pf-badge '+(cf.priority==='Urgent'?'fail':'pass')+'">'+cf.priority+'</span></span>'
        +'<span class="h-stats"><span>'+escapeHtml((cf.body||'').slice(0,40))+'</span><span>'+(cf.audience?cf.audience+' only':'Everyone')+'</span>'
        +'<span class="mr-remove" style="cursor:pointer;" onclick="deleteNotice(\''+n.id+'\')">✕</span></span></div>';
    }).join('');
  }).catch(function(){el.innerHTML='<div class="empty-hint">Could not load notices.</div>';});
}
function deleteNotice(id){
  if(!confirm('Delete this notice?'))return;
  deleteTable('activities','id=eq.'+id,true).then(function(){toast('Removed');loadNotices();}).catch(function(err){toast(err.message||'Could not delete.',true);});
}

// ---- Dashboard notice banner (shown to everyone, role-targeted) ----
function loadActiveNoticeBanner(){
  var host=document.getElementById('dashNoticeBanner');
  if(!host)return;
  getTable('activities','type=eq.notice&order=created_at.desc&limit=5',true).then(function(rows){
    var relevant=(rows||[]).filter(function(n){
      var cf=n.custom_fields||{};
      if(cf.audience && cf.audience!==CTX.role && CTX.role!=='owner')return false;
      return !localStorage.getItem('vc_notice_dismissed_'+n.id);
    });
    if(!relevant.length){host.innerHTML='';return;}
    var n=relevant[0];
    var cf=n.custom_fields||{};
    host.innerHTML='<div class="notice-banner" style="background:'+(cf.color||'#2563eb')+';">'
      +'<span class="nb-close" onclick="dismissNotice(\''+n.id+'\')">✕</span>'
      +'<div class="nb-title">📢 '+escapeHtml(n.title)+'</div>'
      +'<div class="nb-body">'+escapeHtml(cf.body||'')+'</div>'
      +(cf.audioDataUrl?'<audio controls src="'+cf.audioDataUrl+'"></audio>':'')
      +(cf.videoDataUrl?'<video controls src="'+cf.videoDataUrl+'"></video>':'')
      +'</div>';
  }).catch(function(){host.innerHTML='';});
}
function dismissNotice(id){
  localStorage.setItem('vc_notice_dismissed_'+id,'1');
  loadActiveNoticeBanner();
}

// ------------------------------------------------------------
// VISITORS MODULE (stored as activities.type='visitor')
// WRC-style rich intake form: Physical/Virtual mode, photo, documents,
// NEET score, admission tracking, follow-up — the module previously
// missing (People/Activities were too generic to cover this use case).
// ------------------------------------------------------------
var VISITORS_CACHE=[];
var V_VISIT_MODE='Physical';
var V_NEPAL_VISIT='First Time';
var V_SELECTED_TAGS=[];
var V_SELECTED_DOCS=[];
var V_PHOTO_DATA=null;
var V_DOC_FILES=[];

function setVisitMode(mode){
  V_VISIT_MODE=mode;
  document.getElementById('vTabPhysical').classList.toggle('active',mode==='Physical');
  document.getElementById('vTabVirtual').classList.toggle('active',mode==='Virtual');
}
function setNepalVisit(v){
  V_NEPAL_VISIT=v;
  document.getElementById('vNepalFirst').classList.toggle('active',v==='First Time');
  document.getElementById('vNepalReturn').classList.toggle('active',v==='Return');
}
function toggleVisitorTag(el){
  var tag=el.getAttribute('data-tag');
  var idx=V_SELECTED_TAGS.indexOf(tag);
  if(idx>-1){V_SELECTED_TAGS.splice(idx,1);el.classList.remove('active');}
  else{V_SELECTED_TAGS.push(tag);el.classList.add('active');}
}
function toggleVisitorDoc(el){
  var doc=el.getAttribute('data-doc');
  var idx=V_SELECTED_DOCS.indexOf(doc);
  if(idx>-1){V_SELECTED_DOCS.splice(idx,1);el.classList.remove('active');}
  else{V_SELECTED_DOCS.push(doc);el.classList.add('active');}
}
function handleVisitorPhoto(e){
  var f=e.target.files[0];
  if(!f)return;
  compressImage(f,700,0.8).then(function(dataUrl){
    V_PHOTO_DATA=dataUrl;
    document.getElementById('vPhotoHint').style.display='none';
    document.getElementById('vPhotoPreviewWrap').style.display='block';
    document.getElementById('vPhotoPreview').src=dataUrl;
  }).catch(function(){toast('Could not process photo',true);});
}
function handleVisitorDocUpload(e){
  var f=e.target.files[0];
  if(!f)return;
  var reader=new FileReader();
  reader.onload=function(){
    V_DOC_FILES.push({name:f.name,dataUrl:reader.result});
    renderVisitorDocsGrid();
  };
  reader.readAsDataURL(f);
}
function renderVisitorDocsGrid(){
  var el=document.getElementById('vDocsGrid');
  el.innerHTML=V_DOC_FILES.map(function(d,i){
    return '<div class="gallery-item" title="'+escapeHtml(d.name)+'"><img src="'+d.dataUrl+'"><span class="gi-remove" onclick="V_DOC_FILES.splice('+i+',1);renderVisitorDocsGrid();">✕</span></div>';
  }).join('');
}
function resetVisitorForm(){
  document.getElementById('vId').value='';
  document.getElementById('vName').value='';
  document.getElementById('vType').value='Student';
  document.getElementById('vContact').value='';
  document.getElementById('vEmail').value='';
  document.getElementById('vState').value='';
  document.getElementById('vCity').value='';
  document.getElementById('vCollegeInterest').value=CTX.company_name||'';
  document.getElementById('vVisitDate').value=new Date().toISOString().slice(0,10);
  document.getElementById('vReference').value='Direct';
  document.getElementById('vReferenceName').value='';
  document.getElementById('vNeetScore').value='';
  document.getElementById('vAdmissionPlan').value='';
  document.getElementById('vMajorQueries').value='';
  document.getElementById('vStatus').value='New';
  document.getElementById('vFollowUpDate').value='';
  document.getElementById('vNotes').value='';
  document.getElementById('vDeleteBtn').style.display='none';
  V_PHOTO_DATA=null;V_DOC_FILES=[];V_SELECTED_TAGS=[];V_SELECTED_DOCS=[];
  document.getElementById('vPhotoHint').style.display='block';
  document.getElementById('vPhotoPreviewWrap').style.display='none';
  document.querySelectorAll('#vVisitTypeTags .att-chip').forEach(function(el){el.classList.remove('active');});
  document.querySelectorAll('#vDocsTags .att-chip').forEach(function(el){el.classList.remove('active');});
  renderVisitorDocsGrid();
  setVisitMode('Physical');
  setNepalVisit('First Time');
}
function initVisitorsView(){
  resetVisitorForm();
  var label=(CTX.config&&CTX.config.terminology&&CTX.config.terminology.org_label)||'Institution';
  document.getElementById('vCollegeInterestLabel').textContent=label+' Interest';
  loadVisitors();
}
function loadVisitors(){
  var listEl=document.getElementById('visitorsList');
  listEl.innerHTML='<div class="empty-hint">Loading…</div>';
  getTable('activities','type=eq.visitor&order=created_at.desc',true).then(function(rows){
    VISITORS_CACHE=rows||[];
    renderVisitorStats();
    renderVisitorsList();
  }).catch(function(err){
    listEl.innerHTML='<div class="empty-hint">'+friendlyErrorMessage(err)+'</div>';
  });
}
function renderVisitorStats(){
  var today=new Date().toISOString().slice(0,10);
  var stats=[
    {value:VISITORS_CACHE.length,label:'Total Visits'},
    {value:VISITORS_CACHE.filter(function(v){return (v.custom_fields||{}).visitDate===today;}).length,label:'Today'},
    {value:VISITORS_CACHE.filter(function(v){return (v.custom_fields||{}).status==='Converted';}).length,label:'Converted'},
    {value:VISITORS_CACHE.filter(function(v){return (v.custom_fields||{}).status==='Follow-up';}).length,label:'Follow-up Due'}
  ];
  document.getElementById('visitorStats').innerHTML=stats.map(function(s,i){
    return '<div class="glass-stat" style="animation-delay:'+(i*0.05).toFixed(2)+'s"><div class="gs-value">'+s.value+'</div><div class="gs-label">'+s.label+'</div></div>';
  }).join('');
}
function renderVisitorsList(){
  var q=(document.getElementById('visitorSearch').value||'').trim().toLowerCase();
  var rows=VISITORS_CACHE.filter(function(v){
    var cf=v.custom_fields||{};
    if(!q)return true;
    return ((cf.name||'')+' '+(cf.contact||'')+' '+(cf.city||'')).toLowerCase().indexOf(q)>-1;
  });
  var el=document.getElementById('visitorsList');
  if(!rows.length){el.innerHTML='<div class="empty-hint">No visitor entries yet.</div>';return;}
  el.innerHTML=rows.map(function(v){
    var cf=v.custom_fields||{};
    return '<div class="att-row" style="cursor:pointer;" onclick="openVisitorEdit(\''+v.id+'\')">'
      +'<div><div class="p-name">'+escapeHtml(cf.name||'—')+'<span class="p-roll">'+(cf.visitMode==='Virtual'?'📹':'🏫')+' '+escapeHtml(cf.status||'New')+'</span></div>'
      +'<div class="p-meta">'+escapeHtml(cf.type||'')+' · '+escapeHtml(cf.city||'')+' · '+(cf.visitDate||'—')+'</div></div>'
      +'</div>';
  }).join('');
}
function openVisitorEdit(id){
  var v=VISITORS_CACHE.find(function(x){return x.id===id;});
  if(!v)return;
  var cf=v.custom_fields||{};
  resetVisitorForm();
  document.getElementById('vId').value=v.id;
  document.getElementById('vName').value=cf.name||'';
  document.getElementById('vType').value=cf.type||'Student';
  document.getElementById('vContact').value=cf.contact||'';
  document.getElementById('vEmail').value=cf.email||'';
  document.getElementById('vState').value=cf.state||'';
  document.getElementById('vCity').value=cf.city||'';
  document.getElementById('vCollegeInterest').value=cf.collegeInterest||'';
  document.getElementById('vVisitDate').value=cf.visitDate||'';
  document.getElementById('vReference').value=cf.reference||'Direct';
  document.getElementById('vReferenceName').value=cf.referenceName||'';
  document.getElementById('vNeetScore').value=cf.neetScore||'';
  document.getElementById('vAdmissionPlan').value=cf.admissionPlan||'';
  document.getElementById('vMajorQueries').value=cf.majorQueries||'';
  document.getElementById('vStatus').value=cf.status||'New';
  document.getElementById('vFollowUpDate').value=cf.followUpDate||'';
  document.getElementById('vNotes').value=cf.notes||'';
  setVisitMode(cf.visitMode||'Physical');
  setNepalVisit(cf.nepalVisit||'First Time');
  V_SELECTED_TAGS=(cf.visitTypes||[]).slice();
  V_SELECTED_TAGS.forEach(function(t){var el=document.querySelector('#vVisitTypeTags [data-tag="'+t+'"]');if(el)el.classList.add('active');});
  V_SELECTED_DOCS=(cf.documentsChecklist||[]).slice();
  V_SELECTED_DOCS.forEach(function(d){var el=document.querySelector('#vDocsTags [data-doc="'+d+'"]');if(el)el.classList.add('active');});
  V_PHOTO_DATA=cf.photoDataUrl||null;
  if(V_PHOTO_DATA){document.getElementById('vPhotoHint').style.display='none';document.getElementById('vPhotoPreviewWrap').style.display='block';document.getElementById('vPhotoPreview').src=V_PHOTO_DATA;}
  V_DOC_FILES=(cf.documentFiles||[]).slice();
  renderVisitorDocsGrid();
  document.getElementById('vDeleteBtn').style.display='inline-flex';
  document.getElementById('viewVisitors').scrollIntoView({behavior:'smooth',block:'start'});
}
function saveVisitor(){
  var name=document.getElementById('vName').value.trim();
  if(!name){toast('Name is required.',true);return;}
  var id=document.getElementById('vId').value;
  var cf={
    visitMode:V_VISIT_MODE,name:name,type:document.getElementById('vType').value,
    photoDataUrl:V_PHOTO_DATA,
    contact:document.getElementById('vContact').value.trim(),
    email:document.getElementById('vEmail').value.trim(),
    state:document.getElementById('vState').value.trim(),
    city:document.getElementById('vCity').value.trim(),
    collegeInterest:document.getElementById('vCollegeInterest').value.trim(),
    visitDate:document.getElementById('vVisitDate').value||null,
    nepalVisit:V_NEPAL_VISIT,
    visitTypes:V_SELECTED_TAGS,
    reference:document.getElementById('vReference').value,
    referenceName:document.getElementById('vReferenceName').value.trim(),
    neetScore:document.getElementById('vNeetScore').value||null,
    admissionPlan:document.getElementById('vAdmissionPlan').value.trim(),
    documentsChecklist:V_SELECTED_DOCS,
    documentFiles:V_DOC_FILES,
    majorQueries:document.getElementById('vMajorQueries').value.trim(),
    status:document.getElementById('vStatus').value,
    followUpDate:document.getElementById('vFollowUpDate').value||null,
    notes:document.getElementById('vNotes').value.trim()
  };
  var req;
  if(id){
    req=patchTable('activities','id=eq.'+id,{custom_fields:cf},true);
  }else{
    req=postTable('activities',{tenant_id:CTX.tenant_id,created_by:CTX.user_id,type:'visitor',title:'Visitor: '+name,custom_fields:cf},true);
  }
  req.then(function(){
    toast('✅ Visit saved');
    resetVisitorForm();
    loadVisitors();
  }).catch(function(err){toast(friendlyErrorMessage(err),true);});
}
function deleteVisitorConfirm(){
  var id=document.getElementById('vId').value;
  if(!id)return;
  if(!confirm('Delete this visitor entry?'))return;
  deleteTable('activities','id=eq.'+id,true).then(function(){
    toast('Removed');
    resetVisitorForm();
    loadVisitors();
  }).catch(function(err){toast(friendlyErrorMessage(err),true);});
}
function exportVisitorsCsv(){
  var header=['Name','Type','Visit Mode','Contact','Email','State','City','Institution Interest','Visit Date','Status','Follow-up Date'];
  var lines=[header.join(',')];
  VISITORS_CACHE.forEach(function(v){
    var cf=v.custom_fields||{};
    lines.push([cf.name,cf.type,cf.visitMode,cf.contact,cf.email,cf.state,cf.city,cf.collegeInterest,cf.visitDate,cf.status,cf.followUpDate].map(csvEscape).join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='visitors.csv';a.click();
}

// ------------------------------------------------------------
// Sign out
// ------------------------------------------------------------
function doSignOut(){
  if(SESSION&&SESSION.access_token){
    fetch(SUPABASE_URL+'/auth/v1/logout',{method:'POST',headers:authHeaders(true)}).catch(function(){});
  }
  localStorage.removeItem('vc_session');
  SESSION=null;CTX=null;
  location.reload();
}

// ------------------------------------------------------------
// Boot — restore session if present, otherwise show login
// ------------------------------------------------------------
// ------------------------------------------------------------
// LOCAL CACHE (IndexedDB — "phone storage" layer)
// ------------------------------------------------------------
// Supabase remains the source of truth for all multi-user business
// data (fees paid by one staff member must be visible to another
// immediately) — this is NOT a replacement for that, it's a
// stale-while-revalidate cache: show the last-known data instantly
// (even offline), then silently refresh from Supabase and re-render.
// This is the honest, safe interpretation of "phone storage first"
// for a multi-user SaaS — a true local-primary model would break
// cross-staff consistency for shared records.
var IDB=null;
function openLocalCache(){
  return new Promise(function(resolve){
    if(!window.indexedDB)return resolve(null);
    var req=indexedDB.open('verticore_cache_v1',1);
    req.onupgradeneeded=function(e){
      var db=e.target.result;
      if(!db.objectStoreNames.contains('cache'))db.createObjectStore('cache',{keyPath:'key'});
    };
    req.onsuccess=function(e){IDB=e.target.result;resolve(IDB);};
    req.onerror=function(){resolve(null);};
  });
}
function cacheGet(key){
  return new Promise(function(resolve){
    if(!IDB)return resolve(null);
    try{
      var tx=IDB.transaction('cache','readonly');
      var req=tx.objectStore('cache').get(key);
      req.onsuccess=function(){resolve(req.result?req.result.value:null);};
      req.onerror=function(){resolve(null);};
    }catch(e){resolve(null);}
  });
}
function cacheSet(key,value){
  if(!IDB)return;
  try{
    var tx=IDB.transaction('cache','readwrite');
    tx.objectStore('cache').put({key:key,value:value,ts:Date.now()});
  }catch(e){/* ignore cache write failures — Supabase is still authoritative */}
}
function cacheKeyFor(module){return module+':'+(CTX&&CTX.tenant_id||'anon');}

// ------------------------------------------------------------
// PWA — service worker registration (installable app)
// ------------------------------------------------------------
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(function(){});
}

// ---- Install App banner ----
var DEFERRED_INSTALL_PROMPT=null;
function isAlreadyInstalled(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
}
window.addEventListener('beforeinstallprompt',function(e){
  e.preventDefault();
  DEFERRED_INSTALL_PROMPT=e;
  if(!isAlreadyInstalled() && !sessionStorage.getItem('vc_install_dismissed')){
    var banner=document.getElementById('installBanner');
    if(banner)banner.classList.add('show');
  }
});
window.addEventListener('appinstalled',function(){
  DEFERRED_INSTALL_PROMPT=null;
  var banner=document.getElementById('installBanner');
  if(banner)banner.classList.remove('show');
  toast('✅ Verticore installed!');
});
function installApp(){
  if(!DEFERRED_INSTALL_PROMPT)return;
  DEFERRED_INSTALL_PROMPT.prompt();
  DEFERRED_INSTALL_PROMPT.userChoice.then(function(){
    DEFERRED_INSTALL_PROMPT=null;
    var banner=document.getElementById('installBanner');
    if(banner)banner.classList.remove('show');
  });
}
function dismissInstallBanner(){
  var banner=document.getElementById('installBanner');
  if(banner)banner.classList.remove('show');
  sessionStorage.setItem('vc_install_dismissed','1');
}

// ------------------------------------------------------------
// SESSION REFRESH — the app never refreshed the access token before
// this fix, so any session older than Supabase's JWT lifetime (~1hr)
// started failing every request with a raw "JWT expired" error
// (seen in Admin Panel Team list/invite, and likely contributing to
// failures during long operations like bulk contact import).
// ------------------------------------------------------------
var SESSION_REFRESH_TIMER=null;
function refreshSession(){
  if(!SESSION||!SESSION.refresh_token)return Promise.reject(new Error('No refresh token available.'));
  return fetch(SUPABASE_URL+'/auth/v1/token?grant_type=refresh_token',{
    method:'POST',headers:{'apikey':SUPABASE_ANON,'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:SESSION.refresh_token})
  }).then(function(r){return r.json().then(function(j){
    if(!r.ok)throw new Error((j&&(j.error_description||j.msg))||'Session refresh failed');
    SESSION={access_token:j.access_token,refresh_token:j.refresh_token||SESSION.refresh_token,expires_at:Date.now()+((j.expires_in||3600)*1000)};
    localStorage.setItem('vc_session',JSON.stringify(SESSION));
    return SESSION;
  });});
}
function ensureFreshSession(){
  if(!SESSION||!SESSION.expires_at)return Promise.resolve();
  var msLeft=SESSION.expires_at-Date.now();
  if(msLeft>120000)return Promise.resolve(); // still good for 2+ more minutes
  return refreshSession().catch(function(){/* if refresh fails, let the actual request surface the real error */});
}
function startSessionRefreshTimer(){
  clearInterval(SESSION_REFRESH_TIMER);
  SESSION_REFRESH_TIMER=setInterval(function(){
    if(SESSION)ensureFreshSession();
  },5*60*1000); // check every 5 minutes, refresh proactively before the ~1hr token expiry
}
// Friendly wrapper for the one raw error users kept seeing surfaced directly —
// use this to translate it wherever a message is shown to the person.
function friendlyErrorMessage(err){
  var msg=(err&&err.message)||String(err||'');
  if(msg.indexOf('JWT expired')>-1||msg.indexOf('PGRST303')>-1){
    return 'Your session expired — please sign out and sign in again.';
  }
  return msg;
}

(function boot(){
  openLocalCache();
  if(handleOAuthRedirect())return;
  var raw=localStorage.getItem('vc_session');
  if(!raw)return;
  try{
    SESSION=JSON.parse(raw);
  }catch(e){localStorage.removeItem('vc_session');return;}
  if(!SESSION||!SESSION.access_token)return;
  ensureFreshSession().then(function(){
    return loadMyContextAndEnter();
  }).then(function(){
    startSessionRefreshTimer();
  }).catch(function(){
    localStorage.removeItem('vc_session');
    SESSION=null;
  });
})();
