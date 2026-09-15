(() => {
  'use strict';

  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];
  const fmt = n => new Intl.NumberFormat('uz-UZ').format(Math.round(Number(n) || 0));
  const fmtDate = v => { try { return new Date(v).toLocaleString('uz-UZ', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); } catch { return ''; } };
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const statusLabel = s => ({pending:'Haydovchi qidirilmoqda',accepted:'Haydovchi yo‘lda',arrived:'Haydovchi keldi',in_progress:'Safar davom etmoqda',completed:'Yakunlandi',cancelled:'Bekor qilindi'}[s] || s);
  const statusClass = s => s === 'completed' ? 'green' : s === 'cancelled' ? 'red' : s === 'pending' ? 'amber' : 'violet';
  const roleLabel = r => ({client:'Klient',driver:'Haydovchi',admin:'Administrator'}[r] || r);
  const vehicleLabel = v => ({economy:'Ekonom',comfort:'Komfort',business:'Biznes'}[v] || v);

  const state = {
    token: localStorage.getItem('taxi_token') || '', user: null, driver: null, pricing: null,
    page: 'home', map: null, markers: {}, route: null, pickup: null, destination: null,
    vehicleClass: 'economy', paymentMethod: 'cash', rides: [], available: [], socket: null,
    installPrompt: null, adminTab: 'drivers', admin: { stats:null, users:[], drivers:[], rides:[] },
    persistence: 'unknown'
  };

  function toast(msg, type='ok') {
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg; $('#toastHost').appendChild(el);
    setTimeout(() => { el.style.opacity='0'; el.style.transform='translateY(-6px)'; setTimeout(()=>el.remove(),220); }, 3200);
  }
  async function api(url, options={}) {
    const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const r = await fetch(url, { ...options, headers });
    const ct = r.headers.get('content-type') || ''; const data = ct.includes('application/json') ? await r.json() : await r.text();
    if (!r.ok) { const e = new Error(data?.error || `HTTP ${r.status}`); e.status=r.status; e.data=data; throw e; }
    return data;
  }
  function saveSession(token, user) { state.token=token; state.user=user; localStorage.setItem('taxi_token',token); connectSocket(); }
  function logout() { localStorage.removeItem('taxi_token'); state.token=''; state.user=null; state.driver=null; if(state.socket) state.socket.disconnect(); destroyMap(); renderAuth(); }

  function authView(register=false) {
    return `
    <section class="auth">
      <div class="auth-hero">
        <div class="logo-row"><div class="brand-mark">H</div><div><b>HALLAYM Taxi</b><span>premium mobility</span></div></div>
        <div class="hero-copy">
          <span class="eyebrow">✦ Tez • xavfsiz • zamonaviy</span>
          <h1>Shahar bo‘ylab <span>yangi darajadagi</span> harakat.</h1>
          <p>Klient va haydovchini real vaqtda bog‘laydigan, mobil uchun yaratilgan premium taksi ekotizimi. Buyurtma, kuzatuv, tarix va boshqaruv — barchasi bitta joyda.</p>
        </div>
        <div class="hero-features">
          <div class="feature-mini"><b>⚡ Real-time</b><span>Buyurtma va statuslar bir zumda yangilanadi.</span></div>
          <div class="feature-mini"><b>⌖ Smart location</b><span>GPS, xarita va manzil qidiruvi bilan.</span></div>
          <div class="feature-mini"><b>◈ PWA Ready</b><span>Telefon bosh ekraniga ilova sifatida o‘rnating.</span></div>
        </div>
      </div>
      <div class="auth-panel">
        <h2>${register ? 'Akkaunt yaratish' : 'Xush kelibsiz 👋'}</h2>
        <p>${register ? 'Klient yoki haydovchi sifatida tez ro‘yxatdan o‘ting.' : 'Telefon raqamingiz orqali tizimga kiring.'}</p>
        ${register ? `
          <div class="segmented" id="roleSeg"><button class="active" data-role="client">Klient</button><button data-role="driver">Haydovchi</button></div>
          <form id="registerForm">
            <input type="hidden" name="role" value="client" />
            <div class="field"><label>Ism va familiya</label><input class="input" name="name" required minlength="2" placeholder="Masalan: Alisher Karimov" /></div>
            <div class="field"><label>Telefon raqam</label><input class="input" name="phone" required inputmode="tel" placeholder="+998 90 123 45 67" /></div>
            <div class="field"><label>Email (ixtiyoriy)</label><input class="input" name="email" type="email" placeholder="you@example.com" /></div>
            <div class="field"><label>Parol</label><input class="input" name="password" type="password" required minlength="6" placeholder="Kamida 6 belgi" /></div>
            <button class="btn full" type="submit">Ro‘yxatdan o‘tish →</button>
          </form>
          <div class="auth-switch">Akkauntingiz bormi? <button id="toLogin">Kirish</button></div>
        ` : `
          <form id="loginForm">
            <div class="field"><label>Telefon raqam</label><input class="input" name="phone" required inputmode="tel" placeholder="+998 90 123 45 67" /></div>
            <div class="field"><label>Parol</label><input class="input" name="password" type="password" required placeholder="••••••••" /></div>
            <button class="btn full" type="submit">Tizimga kirish →</button>
          </form>
          <div class="auth-switch">Yangi foydalanuvchimisiz? <button id="toRegister">Ro‘yxatdan o‘tish</button></div>
        `}
      </div>
    </section>`;
  }
  function renderAuth(register=false) {
    $('#app').innerHTML = authView(register);
    $('#toRegister')?.addEventListener('click',()=>renderAuth(true)); $('#toLogin')?.addEventListener('click',()=>renderAuth(false));
    $$('#roleSeg button').forEach(b => b.addEventListener('click', () => { $$('#roleSeg button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); $('[name=role]').value=b.dataset.role; }));
    $('#loginForm')?.addEventListener('submit', onLogin); $('#registerForm')?.addEventListener('submit', onRegister);
  }
  async function onLogin(e) {
    e.preventDefault(); const btn=$('button[type=submit]',e.currentTarget); btn.disabled=true; btn.textContent='Kirilmoqda...';
    try { const f=new FormData(e.currentTarget); const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))}); saveSession(d.token,d.user); await loadMe(); await renderShell(); toast('Muvaffaqiyatli kirdingiz'); }
    catch(err){ toast(err.message,'err'); btn.disabled=false; btn.textContent='Tizimga kirish →'; }
  }
  async function onRegister(e) {
    e.preventDefault(); const btn=$('button[type=submit]',e.currentTarget); btn.disabled=true; btn.textContent='Yaratilmoqda...';
    try { const f=new FormData(e.currentTarget); const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify(Object.fromEntries(f))}); saveSession(d.token,d.user); await loadMe(); await renderShell(); toast(d.user.role==='driver'?'Akkaunt yaratildi. Endi avtomobil ma’lumotlarini to‘ldiring.':'Akkaunt yaratildi'); }
    catch(err){ toast(err.message,'err'); btn.disabled=false; btn.textContent='Ro‘yxatdan o‘tish →'; }
  }

  async function loadMe() { const d=await api('/api/me'); state.user=d.user; state.driver=d.driver || null; }
  async function loadPricing() { try { state.pricing=await api('/api/pricing'); } catch{} }
  async function loadRides() { try { state.rides=await api('/api/rides/mine'); } catch{} }
  async function loadAvailable() { if(state.user?.role==='driver') try { state.available=await api('/api/rides/available'); } catch{} }
  function activeRide() { return state.rides.find(r=>['pending','accepted','arrived','in_progress'].includes(r.status)); }

  function navItems() {
    if(state.user.role==='admin') return [ ['home','◈','Dashboard'],['drivers','🚕','Haydovchilar'],['rides','↝','Safarlar'],['profile','⚙','Sozlamalar'] ];
    if(state.user.role==='driver') return [ ['home','⌂','Bosh sahifa'],['orders','◎','Buyurtmalar'],['history','↻','Tarix'],['profile','◉','Profil'] ];
    return [ ['home','⌂','Buyurtma'],['active','↝','Faol safar'],['history','↻','Tarix'],['profile','◉','Profil'] ];
  }
  function shellHtml() {
    const nav=navItems();
    return `<div class="shell">
      <aside class="sidebar">
        <div class="side-brand"><div class="brand-mark">H</div><div><b>HALLAYM Taxi</b><span>${roleLabel(state.user.role)} paneli</span></div></div>
        <nav class="nav">${nav.map(([p,i,t])=>`<button class="nav-btn ${state.page===p?'active':''}" data-page="${p}"><span class="ico">${i}</span>${t}</button>`).join('')}</nav>
        <div class="side-foot"><div class="profile-mini"><div class="avatar">${esc(state.user.name?.[0]||'U')}</div><div><b>${esc(state.user.name)}</b><span>${esc(state.user.phone)}</span></div></div><button class="btn ghost full small mt8" id="logoutSide">Chiqish</button></div>
      </aside>
      <section class="main">
        <div class="topbar"><div class="title-wrap"><h1 id="pageTitle">${pageTitle()}</h1><p id="pageSub">${pageSub()}</p></div><div class="top-actions"><button class="icon-btn" title="Bildirishnomalar">🔔<span class="dot"></span></button><button class="btn secondary small install-btn" id="installBtn">＋ Ilovani o‘rnatish</button></div></div>
        <div id="content"></div>
      </section>
      <nav class="bottom-nav">${nav.slice(0,4).map(([p,i,t])=>`<button class="${state.page===p?'active':''}" data-page="${p}"><i>${i}</i>${t}</button>`).join('')}</nav>
    </div>`;
  }
  function pageTitle(){ if(state.user?.role==='admin') return state.page==='home'?'Boshqaruv markazi':state.page==='drivers'?'Haydovchilar':state.page==='rides'?'Safarlar':'Tizim sozlamalari'; if(state.user?.role==='driver') return state.page==='home'?'Haydovchi paneli':state.page==='orders'?'Yangi buyurtmalar':state.page==='history'?'Safarlar tarixi':'Haydovchi profili'; return state.page==='home'?'Qayerga boramiz?':state.page==='active'?'Faol safar':state.page==='history'?'Safarlar tarixi':'Mening profilim'; }
  function pageSub(){ return `${roleLabel(state.user?.role)} • ${state.persistence==='memory'?'Demo saqlash':'Real-time platforma'}`; }

  async function renderShell() {
    destroyMap(); $('#app').innerHTML=shellHtml(); bindNav(); $('#logoutSide')?.addEventListener('click',logout); $('#installBtn')?.addEventListener('click',installApp);
    await renderPage();
  }
  function bindNav(){ $$('[data-page]').forEach(b=>b.addEventListener('click', async()=>{ state.page=b.dataset.page; await renderShell(); })); }
  async function renderPage() {
    $('#pageTitle').textContent=pageTitle(); $('#pageSub').textContent=pageSub();
    if(state.user.role==='admin') return renderAdmin();
    if(state.user.role==='driver') return renderDriver();
    return renderClient();
  }

  function mapBlock(){ return `<div class="card"><div id="map" class="map"></div></div>`; }
  function rideCard(r, withActions=false) {
    return `<div class="ride-card" data-ride-id="${esc(r._id||r.id)}">
      <div class="card-title"><div><span class="badge ${statusClass(r.status)}">${statusLabel(r.status)}</span></div><b class="price">${fmt(r.fare)} so‘m</b></div>
      <div class="route"><div class="route-line"><i></i><span></span><i></i></div><div class="route-text"><b>${esc(r.pickup?.label||'Jo‘nash nuqtasi')}</b><small>${fmtDate(r.createdAt)}</small><b>${esc(r.destination?.label||'Manzil')}</b><small>${Number(r.distanceKm||0).toFixed(1)} km • ${vehicleLabel(r.vehicleClass)}</small></div></div>
      <div class="ride-meta"><span>💳 ${esc(r.paymentMethod||'cash')}</span><span>🚘 ${vehicleLabel(r.vehicleClass)}</span>${r.rating?`<span>★ ${r.rating}/5</span>`:''}${r.sos?'<span style="color:#fecdd3">⚠ SOS</span>':''}</div>
      ${withActions ? rideActions(r) : ''}
    </div>`;
  }
  function rideActions(r) {
    const id=esc(r._id||r.id);
    if(state.user.role==='client' && ['pending','accepted','arrived'].includes(r.status)) return `<div class="actions"><button class="btn ghost small" data-cancel="${id}">Bekor qilish</button><button class="btn red small" data-sos="${id}">SOS</button></div>`;
    if(state.user.role==='client' && r.status==='in_progress') return `<div class="actions"><button class="btn red small" data-sos="${id}">⚠ SOS / Yordam</button></div>`;
    if(state.user.role==='driver') {
      if(r.status==='accepted') return `<div class="actions"><button class="btn green small" data-status="arrived" data-id="${id}">Yetib keldim</button><button class="btn red small" data-sos="${id}">SOS</button></div>`;
      if(r.status==='arrived') return `<div class="actions"><button class="btn green small" data-status="in_progress" data-id="${id}">Safarni boshlash</button></div>`;
      if(r.status==='in_progress') return `<div class="actions"><button class="btn green small" data-status="completed" data-id="${id}">Safarni yakunlash</button><button class="btn red small" data-sos="${id}">SOS</button></div>`;
    }
    return '';
  }

  async function renderClient() {
    await Promise.all([loadPricing(),loadRides()]);
    const c=$('#content');
    if(state.page==='home') {
      c.innerHTML=`<div class="grid two"><div>${mapBlock()}</div><div class="card"><div class="booking">
        <div class="card-title"><div><h3>Yangi buyurtma</h3><p>Nuqtalarni qidiring yoki xaritadan tanlang</p></div><span class="badge green">● Onlayn</span></div>
        <div class="search-wrap point-field"><span class="point-dot"></span><input class="input" id="pickupInput" placeholder="Qayerdan?" autocomplete="off" /><button class="locate" id="locateBtn" title="GPS">⌖</button><div class="suggest hidden" id="pickupSuggest"></div></div>
        <div class="search-wrap point-field"><span class="point-dot end"></span><input class="input" id="destInput" placeholder="Qayerga?" autocomplete="off" /><div class="suggest hidden" id="destSuggest"></div></div>
        <div class="vehicle-row">${[['economy','🚙','Ekonom'],['comfort','🚘','Komfort'],['business','🏎','Biznes']].map(([v,i,t])=>`<button class="vehicle ${state.vehicleClass===v?'active':''}" data-vehicle="${v}"><strong>${i} ${t}</strong><span>x${mult(v)} tarif</span></button>`).join('')}</div>
        <div class="row"><div class="field"><label>To‘lov</label><select class="select" id="payment"><option value="cash">Naqd</option><option value="click">Click</option><option value="payme">Payme</option></select></div><div class="field"><label>Izoh</label><input class="input" id="note" placeholder="Masalan: 2-kirish" /></div></div>
        <div class="fare-box"><span>Taxminiy narx<br><small id="distanceLabel">Manzilni tanlang</small></span><b id="fare">—</b></div>
        <button class="btn full" id="orderBtn" disabled>Taksi chaqirish →</button>
        ${activeRide()?`<div class="sep"></div><div class="tiny muted">Sizda faol buyurtma bor. Yangi buyurtma uchun avval uni yakunlang yoki bekor qiling.</div>`:''}
      </div></div></div>`;
      initMap('client'); bindClientBooking();
    } else if(state.page==='active') {
      const r=activeRide(); c.innerHTML=r?`<div class="grid two"><div>${mapBlock()}</div><div class="card card-pad"><div class="card-title"><div><h3>Safar holati</h3><p>Real vaqtda yangilanadi</p></div></div>${rideCard(r,true)}<div class="sep"></div><div class="tiny muted">Haydovchi biriktirilganda uning joylashuvi xaritada ko‘rinadi.</div></div></div>`:`<div class="card empty"><span class="big">🚕</span><b>Faol safar yo‘q</b><span>Bosh sahifadan yangi taksi buyurtma qilishingiz mumkin.</span><button class="btn small mt12" id="goOrder">Buyurtma qilish</button></div>`;
      if(r){initMap('ride',r);bindRideActions();} $('#goOrder')?.addEventListener('click',()=>{state.page='home';renderShell();});
    } else if(state.page==='history') {
      const done=state.rides.filter(r=>['completed','cancelled'].includes(r.status)); c.innerHTML=`<div class="card card-pad"><div class="card-title"><div><h3>Safarlar tarixi</h3><p>${done.length} ta yopilgan buyurtma</p></div></div><div class="status-stack">${done.length?done.map(r=>rideCard(r,false)).join(''):`<div class="empty"><span class="big">↻</span><b>Tarix hali bo‘sh</b><span>Safarlaringiz shu yerda saqlanadi.</span></div>`}</div></div>`;
    } else renderProfile(c);
  }
  function mult(v){ const p=state.pricing||{}; return Number(v==='business'?p.businessMultiplier:v==='comfort'?p.comfortMultiplier:p.economyMultiplier||1).toFixed(2).replace(/0+$/,'').replace(/\.$/,''); }
  function bindClientBooking(){
    $('#payment').value=state.paymentMethod; $('#payment').onchange=e=>state.paymentMethod=e.target.value;
    $$('[data-vehicle]').forEach(b=>b.onclick=()=>{state.vehicleClass=b.dataset.vehicle;$$('[data-vehicle]').forEach(x=>x.classList.toggle('active',x===b));updateEstimate();});
    attachSearch('#pickupInput','#pickupSuggest','pickup'); attachSearch('#destInput','#destSuggest','destination');
    $('#locateBtn').onclick=()=>getLocation(true); $('#orderBtn').onclick=createRide;
    if(activeRide()) $('#orderBtn').disabled=true;
    setTimeout(()=>getLocation(false),250);
  }
  function attachSearch(inputSel,suggestSel,kind){
    const input=$(inputSel), box=$(suggestSel); let timer;
    input.addEventListener('input',()=>{ clearTimeout(timer); const q=input.value.trim(); if(q.length<3){box.classList.add('hidden');return;} timer=setTimeout(async()=>{try{const rows=await api(`/api/geocode/search?q=${encodeURIComponent(q)}`);box.innerHTML=rows.map((x,i)=>`<button data-i="${i}">${esc(x.label)}</button>`).join('')||'<button disabled>Natija topilmadi</button>';box.classList.remove('hidden');$$('button',box).forEach(b=>b.onclick=()=>{const x=rows[Number(b.dataset.i)]; if(!x)return; state[kind]=x;input.value=x.label;box.classList.add('hidden');syncMapPoints();updateEstimate();});}catch{box.classList.add('hidden');}},420); });
    input.addEventListener('blur',()=>setTimeout(()=>box.classList.add('hidden'),220));
  }
  async function getLocation(showToast=true){
    if(!navigator.geolocation){if(showToast)toast('GPS mavjud emas','err');return;}
    navigator.geolocation.getCurrentPosition(async pos=>{const p={lat:pos.coords.latitude,lng:pos.coords.longitude,label:'Joriy joylashuv'};try{Object.assign(p,await api(`/api/geocode/reverse?lat=${p.lat}&lng=${p.lng}`));}catch{} state.pickup=p; if($('#pickupInput'))$('#pickupInput').value=p.label; syncMapPoints();updateEstimate(); if(showToast)toast('Joriy joylashuv olindi');},()=>{if(showToast)toast('Joylashuvga ruxsat berilmadi','err');},{enableHighAccuracy:true,timeout:9000,maximumAge:20000});
  }
  function updateEstimate(){
    if(!state.pickup||!state.destination){$('#orderBtn')&&( $('#orderBtn').disabled=true);return;}
    const km=haversine(state.pickup,state.destination)*1.18,p=state.pricing||{},m=state.vehicleClass==='business'?p.businessMultiplier:state.vehicleClass==='comfort'?p.comfortMultiplier:p.economyMultiplier||1;
    const fare=Math.ceil(Math.max(p.minimumFare||7000,((p.baseFare||5000)+km*(p.perKm||2500)+(p.serviceFee||0))*m)/500)*500;
    $('#distanceLabel')&&($('#distanceLabel').textContent=`≈ ${km.toFixed(1)} km`); $('#fare')&&($('#fare').textContent=`${fmt(fare)} so‘m`); $('#orderBtn')&&($('#orderBtn').disabled=!!activeRide());
  }
  function haversine(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
  async function createRide(){
    if(!state.pickup||!state.destination)return toast('Jo‘nash va manzilni tanlang','err'); const btn=$('#orderBtn');btn.disabled=true;btn.textContent='Haydovchi qidirilmoqda...';
    try{const r=await api('/api/rides',{method:'POST',body:JSON.stringify({pickup:state.pickup,destination:state.destination,vehicleClass:state.vehicleClass,paymentMethod:state.paymentMethod,note:$('#note')?.value||''})});state.rides.unshift(r);toast('Buyurtma yaratildi 🚕');state.page='active';await renderShell();}
    catch(e){toast(e.message,'err');btn.disabled=false;btn.textContent='Taksi chaqirish →';}
  }

  async function renderDriver(){
    await Promise.all([loadRides(),loadAvailable()]); const c=$('#content'); const r=activeRide();
    if(state.page==='home'){
      c.innerHTML=`<div class="grid two"><div>${mapBlock()}</div><div><div class="card card-pad"><div class="card-title"><div><h3>Ish holati</h3><p>${state.driver?.approved?'Buyurtmalarni qabul qilishga tayyor':'Admin tasdig‘i kutilmoqda'}</p></div><span class="badge ${state.driver?.approved?'green':'amber'}">${state.driver?.approved?'✓ Tasdiqlangan':'⏳ Tekshiruvda'}</span></div><div class="online-switch"><div><b class="tiny">Onlayn rejim</b><div class="tiny muted mt8">Onlayn bo‘lsangiz yaqin buyurtmalar ko‘rinadi.</div></div><button id="onlineSwitch" class="switch ${state.driver?.online?'on':''}"></button></div>${!state.driver?.approved?'<div class="tiny muted">Avtomobil va guvohnoma ma’lumotlarini Profil bo‘limida to‘liq kiriting. Admin tekshirganidan so‘ng onlayn rejim ochiladi.</div>':''}</div>${r?`<div class="card card-pad mt12"><div class="card-title"><div><h3>Faol safar</h3><p>Statusni bosqichma-bosqich yangilang</p></div></div>${rideCard(r,true)}</div>`:''}</div></div>`;
      initMap('driver',r); $('#onlineSwitch').onclick=toggleOnline; bindRideActions(); startDriverLocation();
    }else if(state.page==='orders'){
      c.innerHTML=`<div class="card card-pad"><div class="card-title"><div><h3>Yangi buyurtmalar</h3><p>${state.available.length} ta mavjud</p></div><span class="badge ${state.driver?.online?'green':'amber'}">${state.driver?.online?'● Onlayn':'○ Oflayn'}</span></div><div class="status-stack">${state.available.length?state.available.map(r=>`${rideCard(r,false)}<button class="btn full small mt8" data-accept="${esc(r._id||r.id)}">Buyurtmani qabul qilish</button>`).join(''):`<div class="empty"><span class="big">📡</span><b>Hozircha buyurtma yo‘q</b><span>Onlayn rejimda bo‘lsangiz yangi buyurtmalar real vaqtda chiqadi.</span></div>`}</div></div>`; $$('[data-accept]').forEach(b=>b.onclick=()=>acceptRide(b.dataset.accept));
    }else if(state.page==='history'){
      const done=state.rides.filter(x=>['completed','cancelled'].includes(x.status)); c.innerHTML=`<div class="card card-pad"><div class="card-title"><div><h3>Safarlar tarixi</h3><p>Jami ${done.length} ta</p></div><span class="badge violet">★ ${Number(state.driver?.rating||5).toFixed(1)}</span></div><div class="status-stack">${done.length?done.map(x=>rideCard(x)).join(''):'<div class="empty"><span class="big">🛣</span><b>Hali safarlar yo‘q</b></div>'}</div></div>`;
    } else renderProfile(c,true);
  }
  async function toggleOnline(){try{const d=await api('/api/driver/online',{method:'PATCH',body:JSON.stringify({online:!state.driver?.online})});state.driver.online=d.online;toast(d.online?'Onlayn rejim yoqildi':'Oflayn rejim');renderShell();}catch(e){toast(e.message,'err');}}
  async function acceptRide(id){try{await api(`/api/rides/${id}/accept`,{method:'POST',body:'{}'});toast('Buyurtma qabul qilindi');state.page='home';await renderShell();}catch(e){toast(e.message,'err');await loadAvailable();renderShell();}}
  let locationWatch=null;
  function startDriverLocation(){if(locationWatch!==null||!navigator.geolocation||!state.driver?.online)return;locationWatch=navigator.geolocation.watchPosition(async p=>{const loc={lat:p.coords.latitude,lng:p.coords.longitude};try{await api('/api/driver/location',{method:'PATCH',body:JSON.stringify(loc)});}catch{} if(state.map){state.driver.location=loc;syncDriverMarker(loc);}},()=>{}, {enableHighAccuracy:true,maximumAge:10000,timeout:15000});}
  function stopDriverLocation(){if(locationWatch!==null&&navigator.geolocation){navigator.geolocation.clearWatch(locationWatch);locationWatch=null;}}

  function renderProfile(c,isDriver=false){
    const d=state.driver||{}; c.innerHTML=`<div class="grid two"><div class="card card-pad"><div class="card-title"><div><h3>Shaxsiy ma’lumotlar</h3><p>Akkauntingizning asosiy sozlamalari</p></div><span class="badge violet">${roleLabel(state.user.role)}</span></div><form id="profileForm"><div class="field"><label>Ism</label><input class="input" name="name" value="${esc(state.user.name)}" /></div><div class="field"><label>Telefon</label><input class="input" value="${esc(state.user.phone)}" disabled /></div><div class="field"><label>Avatar URL (ixtiyoriy)</label><input class="input" name="avatar" value="${esc(state.user.avatar||'')}" placeholder="https://..." /></div><button class="btn small" type="submit">Saqlash</button></form><div class="sep"></div><button class="btn ghost small" id="logoutProfile">Akkauntdan chiqish</button></div>${isDriver?`<div class="card card-pad"><div class="card-title"><div><h3>Avtomobil ma’lumotlari</h3><p>Admin tasdig‘i uchun to‘liq kiriting</p></div><span class="badge ${d.approved?'green':'amber'}">${d.approved?'Tasdiqlangan':'Tekshiruvda'}</span></div><form id="driverForm"><div class="row stack-mobile"><div class="field"><label>Marka</label><input class="input" name="carMake" value="${esc(d.carMake||'')}" placeholder="Chevrolet" /></div><div class="field"><label>Model</label><input class="input" name="carModel" value="${esc(d.carModel||'')}" placeholder="Cobalt" /></div></div><div class="row stack-mobile"><div class="field"><label>Rang</label><input class="input" name="carColor" value="${esc(d.carColor||'')}" placeholder="Oq" /></div><div class="field"><label>Davlat raqami</label><input class="input" name="plate" value="${esc(d.plate||'')}" placeholder="75 A 777 AA" /></div></div><div class="field"><label>Haydovchilik guvohnomasi</label><input class="input" name="licenseNo" value="${esc(d.licenseNo||'')}" placeholder="AA1234567" /></div><div class="field"><label>Tarif sinfi</label><select class="select" name="vehicleClass"><option value="economy">Ekonom</option><option value="comfort">Komfort</option><option value="business">Biznes</option></select></div><button class="btn small" type="submit">Avtomobilni saqlash</button></form></div>`:`<div class="card card-pad"><div class="card-title"><div><h3>Ilova haqida</h3><p>Premium PWA klient</p></div></div><div class="tiny muted">HALLAYM Taxi — tezkor buyurtma, real-time statuslar va xavfsizlik funksiyalari bilan mobil-first platforma.</div><button class="btn secondary small mt12" id="installInside">＋ Bosh ekranga o‘rnatish</button></div>`}</div>`;
    $('#profileForm').onsubmit=async e=>{e.preventDefault();try{const f=Object.fromEntries(new FormData(e.currentTarget));const x=await api('/api/me',{method:'PATCH',body:JSON.stringify(f)});state.user=x.user;toast('Profil saqlandi');renderShell();}catch(er){toast(er.message,'err');}};
    $('#logoutProfile').onclick=logout; $('#installInside')?.addEventListener('click',installApp);
    if(isDriver){$('[name=vehicleClass]').value=d.vehicleClass||'economy';$('#driverForm').onsubmit=async e=>{e.preventDefault();try{const f=Object.fromEntries(new FormData(e.currentTarget));state.driver=await api('/api/driver/profile',{method:'PUT',body:JSON.stringify(f)});toast('Avtomobil ma’lumotlari saqlandi');renderShell();}catch(er){toast(er.message,'err');}};}
  }

  async function renderAdmin(){
    const c=$('#content');
    if(state.page==='home'){
      await adminLoad('all'); const s=state.admin.stats||{};
      c.innerHTML=`<div class="stats"><div class="stat"><span>Foydalanuvchilar</span><b>${fmt(s.users)}</b><small>${fmt(s.clients)} klient</small></div><div class="stat"><span>Haydovchilar</span><b>${fmt(s.drivers)}</b><small>${fmt(s.pendingDrivers)} ta tasdiq kutmoqda</small></div><div class="stat"><span>Faol safarlar</span><b>${fmt(s.active)}</b><small>Jami ${fmt(s.rides)} buyurtma</small></div><div class="stat"><span>Yakunlangan tushum</span><b>${fmt(s.revenue)}</b><small>so‘m • ${fmt(s.completed)} safar</small></div></div><div class="grid two"><div class="card card-pad"><div class="card-title"><div><h3>Oxirgi safarlar</h3><p>Real-time buyurtmalar oqimi</p></div><span class="badge green">● Live</span></div><div class="status-stack">${state.admin.rides.slice(0,6).map(r=>rideCard(r)).join('')||'<div class="empty"><b>Safarlar yo‘q</b></div>'}</div></div><div class="card card-pad"><div class="card-title"><div><h3>Tekshiruv navbati</h3><p>Yangi haydovchilar</p></div></div>${state.admin.drivers.filter(d=>!d.approved).slice(0,6).map(driverMini).join('')||'<div class="empty"><span class="big">✓</span><b>Navbat toza</b><span>Barcha haydovchilar ko‘rib chiqilgan.</span></div>'}</div></div>`; bindAdminApprove();
    }else if(state.page==='drivers'){
      await adminLoad('drivers'); c.innerHTML=`<div class="card card-pad"><div class="card-title"><div><h3>Haydovchilar boshqaruvi</h3><p>Tekshirish, tasdiqlash va holat nazorati</p></div><span class="badge violet">${state.admin.drivers.length} ta</span></div><div class="table-wrap"><table><thead><tr><th>Haydovchi</th><th>Avtomobil</th><th>Raqam</th><th>Sinfi</th><th>Reyting</th><th>Holat</th><th>Amal</th></tr></thead><tbody>${state.admin.drivers.map(d=>`<tr><td><b>${esc(d.user?.name||'—')}</b><div class="muted">${esc(d.user?.phone||'')}</div></td><td>${esc([d.carMake,d.carModel].filter(Boolean).join(' ')||'—')}<div class="muted">${esc(d.carColor||'')}</div></td><td>${esc(d.plate||'—')}</td><td>${vehicleLabel(d.vehicleClass)}</td><td>★ ${Number(d.rating||5).toFixed(1)}</td><td><span class="badge ${d.approved?'green':'amber'}">${d.approved?'Tasdiqlangan':'Kutilmoqda'}</span></td><td><button class="btn ${d.approved?'ghost':'green'} small" data-approve="${esc(d.user?._id||d.user?.id||d.userId)}" data-next="${d.approved?'0':'1'}">${d.approved?'Bekor qilish':'Tasdiqlash'}</button></td></tr>`).join('')}</tbody></table></div></div>`;bindAdminApprove();
    }else if(state.page==='rides'){
      await adminLoad('rides'); c.innerHTML=`<div class="card card-pad"><div class="card-title"><div><h3>Barcha safarlar</h3><p>Buyurtma holatlari va narxlar</p></div><span class="badge violet">${state.admin.rides.length} ta</span></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Yo‘nalish</th><th>Tarif</th><th>Narx</th><th>Status</th><th>Sana</th></tr></thead><tbody>${state.admin.rides.map(r=>`<tr><td class="mono">${esc(String(r._id||r.id).slice(-8))}</td><td>${esc((r.pickup?.label||'').slice(0,34))}<div class="muted">→ ${esc((r.destination?.label||'').slice(0,34))}</div></td><td>${vehicleLabel(r.vehicleClass)}</td><td>${fmt(r.fare)} so‘m</td><td><span class="badge ${statusClass(r.status)}">${statusLabel(r.status)}</span></td><td>${fmtDate(r.createdAt)}</td></tr>`).join('')}</tbody></table></div></div>`;
    } else {
      await loadPricing(); await adminLoad('users'); const p=state.pricing||{};
      c.innerHTML=`<div class="grid two"><div class="card card-pad"><div class="card-title"><div><h3>Tarif sozlamalari</h3><p>Narx hisoblash formulasi</p></div></div><form id="pricingForm"><div class="row stack-mobile"><div class="field"><label>Boshlang‘ich narx</label><input class="input" name="baseFare" type="number" value="${p.baseFare||5000}" /></div><div class="field"><label>1 km narxi</label><input class="input" name="perKm" type="number" value="${p.perKm||2500}" /></div></div><div class="row stack-mobile"><div class="field"><label>Minimal narx</label><input class="input" name="minimumFare" type="number" value="${p.minimumFare||7000}" /></div><div class="field"><label>Servis haqi</label><input class="input" name="serviceFee" type="number" value="${p.serviceFee||0}" /></div></div><div class="row stack-mobile"><div class="field"><label>Ekonom x</label><input class="input" name="economyMultiplier" type="number" step="0.05" value="${p.economyMultiplier||1}" /></div><div class="field"><label>Komfort x</label><input class="input" name="comfortMultiplier" type="number" step="0.05" value="${p.comfortMultiplier||1.35}" /></div><div class="field"><label>Biznes x</label><input class="input" name="businessMultiplier" type="number" step="0.05" value="${p.businessMultiplier||1.8}" /></div></div><button class="btn small" type="submit">Tariflarni saqlash</button></form></div><div class="card card-pad"><div class="card-title"><div><h3>Foydalanuvchilar</h3><p>Bloklash va qayta faollashtirish</p></div><span class="badge violet">${state.admin.users.length} ta</span></div><div class="status-stack">${state.admin.users.slice(0,15).map(u=>`<div class="ride-card"><div class="card-title"><div><b>${esc(u.name)}</b><p>${esc(u.phone)} • ${roleLabel(u.role)}</p></div><button class="btn ${u.status==='active'?'ghost':'green'} small" data-user-status="${esc(u._id||u.id)}" data-next="${u.status==='active'?'blocked':'active'}">${u.status==='active'?'Bloklash':'Faollashtirish'}</button></div></div>`).join('')}</div></div></div>`;
      $('#pricingForm').onsubmit=savePricing; $$('[data-user-status]').forEach(b=>b.onclick=()=>setUserStatus(b.dataset.userStatus,b.dataset.next));
    }
  }
  function driverMini(d){return `<div class="ride-card"><div class="card-title"><div><b>${esc(d.user?.name||'Haydovchi')}</b><p>${esc(d.user?.phone||'')} • ${esc(d.plate||'Raqam kiritilmagan')}</p></div><button class="btn green small" data-approve="${esc(d.user?._id||d.user?.id||d.userId)}" data-next="1">Tasdiqlash</button></div></div>`;}
  async function adminLoad(kind){try{if(kind==='all'||!state.admin.stats)state.admin.stats=await api('/api/admin/stats');if(kind==='all'||kind==='drivers')state.admin.drivers=await api('/api/admin/drivers');if(kind==='all'||kind==='rides')state.admin.rides=await api('/api/admin/rides');if(kind==='users')state.admin.users=await api('/api/admin/users');}catch(e){toast(e.message,'err');}}
  function bindAdminApprove(){ $$('[data-approve]').forEach(b=>b.onclick=async()=>{try{await api(`/api/admin/drivers/${b.dataset.approve}/approve`,{method:'PATCH',body:JSON.stringify({approved:b.dataset.next==='1'})});toast(b.dataset.next==='1'?'Haydovchi tasdiqlandi':'Tasdiq bekor qilindi');await renderShell();}catch(e){toast(e.message,'err');}}); }
  async function savePricing(e){e.preventDefault();const x=Object.fromEntries(new FormData(e.currentTarget));Object.keys(x).forEach(k=>x[k]=Number(x[k]));try{state.pricing=await api('/api/admin/pricing',{method:'PUT',body:JSON.stringify(x)});toast('Tariflar yangilandi');}catch(er){toast(er.message,'err');}}
  async function setUserStatus(id,status){try{await api(`/api/admin/users/${id}/status`,{method:'PATCH',body:JSON.stringify({status})});toast('Akkaunt holati yangilandi');await renderShell();}catch(e){toast(e.message,'err');}}

  function bindRideActions(){
    $$('[data-cancel]').forEach(b=>b.onclick=()=>cancelRide(b.dataset.cancel)); $$('[data-sos]').forEach(b=>b.onclick=()=>sosRide(b.dataset.sos)); $$('[data-status]').forEach(b=>b.onclick=()=>setRideStatus(b.dataset.id,b.dataset.status));
  }
  async function cancelRide(id){if(!confirm('Buyurtmani bekor qilasizmi?'))return;try{await api(`/api/rides/${id}/cancel`,{method:'POST',body:JSON.stringify({reason:'Foydalanuvchi bekor qildi'})});toast('Buyurtma bekor qilindi');await renderShell();}catch(e){toast(e.message,'err');}}
  async function sosRide(id){if(!confirm('SOS signalini adminga yuborilsinmi?'))return;try{await api(`/api/rides/${id}/sos`,{method:'POST',body:'{}'});toast('SOS signali yuborildi','err');}catch(e){toast(e.message,'err');}}
  async function setRideStatus(id,status){try{await api(`/api/rides/${id}/status`,{method:'PATCH',body:JSON.stringify({status})});toast(statusLabel(status));await renderShell();}catch(e){toast(e.message,'err');}}

  function destroyMap(){ if(state.map){try{state.map.remove();}catch{} state.map=null;} state.markers={};state.route=null; stopDriverLocation(); }
  function pinIcon(type='start'){return L.divIcon({className:'',html:`<div class="taxi-pin ${type==='end'?'dest-pin':type==='driver'?'driver-pin':''}">${type==='end'?'◆':type==='driver'?'🚕':'●'}</div>`,iconSize:[34,34],iconAnchor:[17,17]});}
  function initMap(mode,ride=null){
    if(!window.L||!$('#map'))return; state.map=L.map('map',{zoomControl:true,attributionControl:true}).setView([38.861,65.789],13); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(state.map);
    if(mode==='client'){state.map.on('click',async e=>{const p={lat:e.latlng.lat,lng:e.latlng.lng,label:'Xaritadan tanlangan manzil'};try{Object.assign(p,await api(`/api/geocode/reverse?lat=${p.lat}&lng=${p.lng}`));}catch{} if(!state.pickup){state.pickup=p;$('#pickupInput').value=p.label;}else{state.destination=p;$('#destInput').value=p.label;}syncMapPoints();updateEstimate();}); syncMapPoints();}
    if(mode==='ride'&&ride){state.pickup=ride.pickup;state.destination=ride.destination;syncMapPoints();}
    if(mode==='driver'){if(state.driver?.location)syncDriverMarker(state.driver.location); if(ride){state.pickup=ride.pickup;state.destination=ride.destination;syncMapPoints();}}
    setTimeout(()=>state.map?.invalidateSize(),100);
  }
  function syncMapPoints(){if(!state.map)return;['pickup','destination'].forEach(k=>{const p=state[k];if(!p)return;if(state.markers[k])state.markers[k].setLatLng([p.lat,p.lng]);else state.markers[k]=L.marker([p.lat,p.lng],{icon:pinIcon(k==='destination'?'end':'start')}).addTo(state.map).bindPopup(esc(p.label||k));});if(state.pickup&&state.destination){if(state.route)state.route.remove();state.route=L.polyline([[state.pickup.lat,state.pickup.lng],[state.destination.lat,state.destination.lng]],{color:'#8b5cf6',weight:4,opacity:.75,dashArray:'8 9'}).addTo(state.map);state.map.fitBounds(state.route.getBounds(),{padding:[45,45]});}else if(state.pickup)state.map.setView([state.pickup.lat,state.pickup.lng],15);}
  function syncDriverMarker(loc){if(!state.map||!loc)return;if(state.markers.driver)state.markers.driver.setLatLng([loc.lat,loc.lng]);else state.markers.driver=L.marker([loc.lat,loc.lng],{icon:pinIcon('driver')}).addTo(state.map).bindPopup('Haydovchi');}

  function connectSocket(){
    if(!state.token||!window.io)return;if(state.socket)state.socket.disconnect();state.socket=io({auth:{token:state.token},transports:['websocket','polling']});
    state.socket.on('ride:new',async()=>{if(state.user?.role==='driver'){await loadAvailable();toast('Yangi buyurtma keldi 🚕');if(state.page==='orders')renderShell();}});
    state.socket.on('ride:taken',async()=>{if(state.user?.role==='driver'&&state.page==='orders'){await loadAvailable();renderShell();}});
    state.socket.on('ride:updated',async()=>{await loadRides();toast('Safar holati yangilandi');if(['active','home'].includes(state.page))renderShell();});
    state.socket.on('driver:location',d=>{if(state.user?.role==='client')syncDriverMarker(d);});
    state.socket.on('driver:approval',async d=>{if(state.user?.role==='driver'){toast(d.approved?'Admin sizni tasdiqladi ✅':'Haydovchi tasdig‘i bekor qilindi',d.approved?'ok':'err');await loadMe();renderShell();}});
    state.socket.on('account:status',d=>{if(d.status==='blocked'){toast('Akkaunt bloklandi','err');setTimeout(logout,900);}});
    state.socket.on('admin:refresh',async()=>{if(state.user?.role==='admin'&&state.page==='home'){await adminLoad('all');renderShell();}});
    state.socket.on('sos',()=>{if(state.user?.role==='admin'){toast('⚠ SOS signali kelib tushdi!','err');}});
  }

  async function installApp(){ if(state.installPrompt){state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;} else toast('Brauzer menyusidan “Bosh ekranga qo‘shish”ni tanlang'); }
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;});
  if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));

  async function boot(){
    try{const meta=await api('/api/meta');state.persistence=meta.persistence;}catch{}
    if(!state.token){renderAuth(false);return;}
    try{await loadMe();await loadPricing();connectSocket();await renderShell();}catch{logout();}
  }
  setTimeout(()=>$('#boot')?.classList.add('hide'),450);
  boot();
})();
