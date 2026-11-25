(function(){
'use strict';

/* ============ small helpers ============ */
var $ = function(s,el){ return (el||document).querySelector(s); };
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function fmt(n){ return Math.round(n||0).toLocaleString('en-US'); }
function fmtUsd(n){ return (Math.round((n||0)*100)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtAmt(n){ return Number.isInteger(n) ? fmt(n) : fmtUsd(n); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function pad(n,l){ return String(n).padStart(l||2,'0'); }
function clone(x){ return x==null?x:JSON.parse(JSON.stringify(x)); }
function dayKey(ts){ var d=new Date(ts); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function parseDay(k){ var p=k.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); }
function timeStr(ts){ var d=new Date(ts); return pad(d.getHours())+':'+pad(d.getMinutes()); }
function dateStr(ts){ var d=new Date(ts); return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear(); }
function r100(x){ return Math.round(x/100)*100; }
function num(s){ var v=parseFloat(String(s==null?'':s).replace(/[,\s]/g,'')); return isNaN(v)?0:v; }
function sum(a,f){ return a.reduce(function(s,x){ return s+f(x); },0); }

var SESS = Math.random().toString(36).slice(2,6);

/* ============ money (pure functions) ============ */
function calc(items, disc, svcPct, vatPct){
  var sub = sum(items,function(i){ return i.price*i.qty; });
  var d = 0;
  if(disc && disc.v>0){
    d = disc.t==='p' ? r100(sub*Math.min(100,disc.v)/100) : Math.round(disc.v);
    d = Math.min(sub, Math.max(0,d));
  }
  var base = sub-d;
  var svc = svcPct>0 ? r100(base*svcPct/100) : 0;
  var vat = vatPct>0 ? r100((base+svc)*vatPct/100) : 0;
  return {sub:sub, disc:d, svc:svc, vat:vat, total:base+svc+vat};
}
function toLak(cur, amt, rates){ return cur==='LAK' ? Math.round(amt) : Math.round(amt*rates[cur]); }
function fromLak(cur, lak, rates){
  if(cur==='LAK') return Math.max(0,Math.round(lak));
  if(cur==='THB') return Math.max(0, Math.ceil(lak/rates.THB - 1e-9));
  return Math.max(0, Math.ceil(lak/rates.USD*100 - 1e-6)/100);
}
function payState(total, pays){
  var paid = sum(pays,function(p){ return p.lak; });
  return {paid:paid, remain:Math.max(0,total-paid), change:Math.max(0,paid-total)};
}
function summarize(bills){
  var ok = bills.filter(function(b){ return !b.void; });
  var r = {count:ok.length, total:sum(ok,function(b){ return b.total; }), qr:0, cashLak:0, thb:0, thbLak:0, usd:0, usdLak:0, items:{}, cats:{}, voids:bills.length-ok.length};
  r.avg = r.count ? Math.round(r.total/r.count) : 0;
  ok.forEach(function(b){
    (b.pays||[]).forEach(function(p){
      if(p.m==='qr') r.qr+=p.lak;
      else if(p.c==='THB'){ r.thb+=p.amt; r.thbLak+=p.lak; }
      else if(p.c==='USD'){ r.usd+=p.amt; r.usdLak+=p.lak; }
      else r.cashLak+=p.lak;
    });
    r.cashLak -= (b.change||0);
    (b.items||[]).forEach(function(i){
      var e = r.items[i.name] || (r.items[i.name]={name:i.name,qty:0,rev:0});
      e.qty+=i.qty; e.rev+=i.price*i.qty;
      var c = i.cat||'ອື່ນໆ'; r.cats[c]=(r.cats[c]||0)+i.price*i.qty;
    });
  });
  return r;
}

/* ============ storage: Supabase (one shared table of documents per shop) ============ */
var Store = {
  shopId:null, subs:[], live:false, ch:null, wc:{}, wlast:{}, lastPoll:0, loadN:0,
  start:function(shopId){
    var self=this; this.shopId=shopId;
    this.ch=Api.subscribe(shopId,function(ev){ self.onEvent(ev); },function(st){ self.live=(st==='SUBSCRIBED'); });
    setInterval(function(){
      if(document.hidden) return;
      var gap=self.live?60000:8000;
      if(Date.now()-self.lastPoll>=gap){ self.lastPoll=Date.now(); self.subs.slice().forEach(function(w){ self.load(w); }); }
    },4000);
    document.addEventListener('visibilitychange',function(){ if(!document.hidden){ self.lastPoll=Date.now(); self.subs.slice().forEach(function(w){ self.load(w); }); } });
    window.addEventListener('online',function(){ self.subs.slice().forEach(function(w){ self.load(w); }); });
  },
  watchColl:function(coll, filter, cb, onErr){
    var self=this, w={coll:coll, filter:filter, cb:cb, onErr:onErr, map:null, dead:false};
    this.subs.push(w); this.load(w);
    return function(){ w.dead=true; self.subs=self.subs.filter(function(x){ return x!==w; }); };
  },
  reload:function(coll){ var self=this; this.subs.filter(function(w){ return w.coll===coll; }).forEach(function(w){ self.load(w); }); },
  load:function(w){
    var self=this, t0=Date.now(), n=++this.loadN; w.n=n;
    return Api.docsSelect(this.shopId, w.coll, w.filter).then(function(rows){
      if(w.dead || w.n!==n) return;
      if((self.wc[w.coll]||0)>0 || (self.wlast[w.coll]||0)>=t0){ setTimeout(function(){ if(!w.dead) self.load(w); },1500); return; }   // we wrote meanwhile: this answer may be stale
      w.map={}; rows.forEach(function(r){ w.map[r.id]={id:r.id,day:r.day,data:r.data}; });
      self.emit(w);
    },function(e){ if(!w.dead && w.onErr) w.onErr(e); });
  },
  emit:function(w){
    var rows=Object.keys(w.map).map(function(id){ var r=w.map[id]; return Object.assign({id:id}, clone(r.data)); });
    w.cb(rows);
  },
  onEvent:function(ev){
    var self=this;
    this.subs.slice().forEach(function(w){
      if(w.coll!==ev.coll || !w.map || w.dead) return;
      if(ev.type==='DELETE'){ if(w.map[ev.id]){ delete w.map[ev.id]; self.emit(w); } return; }
      if(w.filter && !(ev.day && ev.day>=w.filter.gte && ev.day<=w.filter.lte)){ if(w.map[ev.id]){ delete w.map[ev.id]; self.emit(w); } return; }
      w.map[ev.id]={id:ev.id,day:ev.day,data:ev.data}; self.emit(w);
    });
  },
  wrap:function(coll,p){
    var self=this;
    if(CTX.readOnly) return Promise.reject(new Error('readonly'));
    this.wc[coll]=(this.wc[coll]||0)+1;
    function end(){ self.wc[coll]--; self.wlast[coll]=Date.now(); }
    return p().then(function(x){ end(); return x; },function(e){ end(); throw e; });
  },
  set:function(coll,id,data,day){ var self=this; return this.wrap(coll,function(){ return Api.docUpsert(self.shopId,coll,id,day,data); }); },
  del:function(coll,id){ var self=this; return this.wrap(coll,function(){ return Api.docDelete(self.shopId,coll,id); }); },
  clearColl:function(coll){ var self=this; return this.wrap(coll,function(){ return Api.docsClear(self.shopId,coll); }); }
};

/* ============ app state ============ */
var DEFAULTS = {shop:'ຮ້ານຂອງຂ້ອຍ', tables:8, svc:0, vat:0, THB:660, USD:21700, qr:'', qrOrder:true};
var CFG = window.APP_CONFIG || {};
var ROLE_LAO = {owner:'ເຈົ້າຂອງ', manager:'ຜູ້ຈັດການ', cashier:'ແຄຊເຍີ', kitchen:'ຄົວ'};
/* who am I, which shop, may I change things */
var CTX = {shop:null, role:null, readOnly:false, user:null, shops:[]};
function isBoss(){ return CTX.role==='owner' || CTX.role==='manager'; }
function canSales(){ return CTX.role!=='kitchen'; }
function shopState(sh){
  var now=Date.now(), te=Date.parse(sh.trial_ends_at)||0, pu=sh.paid_until?Date.parse(sh.paid_until):0, end=Math.max(te,pu||0);
  var days=Math.ceil((end-now)/86400000);
  return {active: sh.status==='active' && end>now, suspended: sh.status!=='active', end:end, days:days, trial: sh.plan==='trial'};
}
var S = {
  tab:'tables', settings:Object.assign({},DEFAULTS), menu:[], orders:[], draft:null, cur:null, ordView:'menu', cat:null,
  salesDocs:{}, shardLW:{}, sessShard:{}, repRange:'today', repLimit:40,
  loaded:{}, ready:false, slow:false, inbox:[], inboxSeen:null, team:null
};
var PAY=null, dlgRes=null;
var dirty={}, lastWrite={}, lastDel={}, pend={}, timers={};

function rates(){ return {THB:S.settings.THB>0?S.settings.THB:660, USD:S.settings.USD>0?S.settings.USD:21700}; }
function totals(o){ return calc(o.items, o.disc, S.settings.svc, S.settings.vat); }
function getCur(){
  if(!S.cur) return null;
  if(S.draft && S.draft.id===S.cur) return S.draft;
  return S.orders.find(function(o){ return o.id===S.cur; }) || null;
}
function cats(){ var out=[]; S.menu.forEach(function(m){ var c=m.cat||'ອື່ນໆ'; if(out.indexOf(c)<0) out.push(c); }); return out; }

/* ============ toast, dialogs, sheets ============ */
var toastT=null;
function toast(msg){
  var t=$('#toast'); t.textContent=msg; t.hidden=false;
  clearTimeout(toastT); toastT=setTimeout(function(){ t.hidden=true; },2200);
}
function openSheet(html){ IN_OPEN=false; TEAM_OPEN=false; $('#sheet').innerHTML='<div class="scrim" data-act="scrim"><div class="sheet" role="dialog">'+html+'</div></div>'; }
function setSheet(html){ var s=$('#sheet .sheet'); if(s) s.innerHTML=html; }
function closeSheet(){ IN_OPEN=false; TEAM_OPEN=false; $('#sheet').innerHTML=''; }
function sheetOpen(){ return !!$('#sheet .sheet'); }
function ask(title,text,ok,danger){
  return new Promise(function(res){
    dlgRes=res;
    $('#dialog').innerHTML='<div class="scrim center" data-act="dlgNo"><div class="dlg" role="alertdialog"><h3>'+esc(title)+'</h3>'+(text?'<p>'+esc(text)+'</p>':'')+
      '<div class="row"><button class="btn ghost" data-act="dlgNo">ຍົກເລີກ</button><button class="btn '+(danger?'dangerfill':'primary')+'" data-act="dlgYes">'+esc(ok)+'</button></div></div></div>';
  });
}
function dlgEnd(v){ $('#dialog').innerHTML=''; var r=dlgRes; dlgRes=null; if(r) r(v); }

/* ============ writes (one at a time per document) ============ */
var Q={}, failShown=0;
function enqueue(key, fn){
  var prev=Q[key]||Promise.resolve();
  var run=prev.catch(function(){}).then(fn);
  Q[key]=run;
  run.catch(function(){ if(Date.now()-failShown>4000){ failShown=Date.now(); toast('ບັນທຶກບໍ່ສຳເລັດ ກວດອິນເຕີເນັດ ແລ້ວລອງໃໝ່'); } });
  return run;
}
function saveSettings(patch){
  if(CTX.readOnly || !isBoss()){ toast('ບໍ່ສາມາດແກ້ໄຂໄດ້'); return; }
  if(patch.shop && CTX.role==='owner' && patch.shop!==S.settings.shop) Api.renameShop(CTX.shop.id,patch.shop).then(null,function(){});
  S.settings=Object.assign({},S.settings,patch);
  enqueue('settings/main',function(){ return Store.set('settings','main',S.settings); });
  render();
}
function stripOrder(o){ return {tableId:o.tableId, tableName:o.tableName, items:o.items, disc:o.disc||null, created:o.created, updated:o.updated}; }
function scheduleSave(o){
  lastWrite[o.id]=Date.now(); dirty[o.id]=true; pend[o.id]=o;
  clearTimeout(timers[o.id]);
  timers[o.id]=setTimeout(function(){ flush(o.id).catch(function(){}); },300);
}
function flush(id){
  var o=pend[id]; if(!o) return Promise.resolve(); delete pend[id]; clearTimeout(timers[id]);
  return enqueue('orders/'+id,function(){ return Store.set('orders',id,stripOrder(o)); }).then(function(){
    lastWrite[id]=Date.now(); if(!pend[id]) dirty[id]=false;
  },function(e){ if(!pend[id]) dirty[id]=false; throw e; });
}
function deleteOrder(id){
  lastDel[id]=Date.now(); delete pend[id]; delete dirty[id]; clearTimeout(timers[id]);
  S.orders=S.orders.filter(function(o){ return o.id!==id; });
  return enqueue('orders/'+id,function(){ return Store.del('orders',id); });
}
function commit(o){
  o.updated=Date.now();
  var idx=S.orders.findIndex(function(x){ return x.id===o.id; });
  if(o.items.length===0){
    if(idx>=0){ o.draft=true; S.draft=o; deleteOrder(o.id); }
    else { o.draft=true; S.draft=o; }
    return;
  }
  delete o.draft; if(S.draft && S.draft.id===o.id) S.draft=null;
  if(idx>=0) S.orders[idx]=o; else S.orders.push(o);
  scheduleSave(o);
}
function edit(fn){ var o=clone(getCur()); if(!o) return; fn(o); commit(o); render(); }
function mergeOrders(rows){
  var now=Date.now(), map={}, next=[];
  rows.forEach(function(r){ map[r.id]=r; });
  rows.forEach(function(r){
    if(lastDel[r.id] && now-lastDel[r.id]<6000) return;
    if(dirty[r.id]){ var loc=S.orders.find(function(x){ return x.id===r.id; }); next.push(loc||r); }
    else next.push(r);
  });
  S.orders.forEach(function(loc){
    if(!map[loc.id] && (dirty[loc.id] || now-(lastWrite[loc.id]||0)<6000)) next.push(loc);
  });
  S.orders=next;
}

/* ============ sales data ============ */
function onSalesSnap(from,to,rows){
  var ids={}, now=Date.now();
  rows.forEach(function(r){ ids[r.id]=true; });
  Object.keys(S.salesDocs).forEach(function(k){
    var d=S.salesDocs[k];
    if(d.day>=from && d.day<=to && !ids[k] && now-(S.shardLW[k]||0)>6000) delete S.salesDocs[k];
  });
  rows.forEach(function(r){
    if(now-(S.shardLW[r.id]||0)<6000) return;
    var id=r.id; delete r.id; S.salesDocs[id]=r;
  });
}
function billsInRange(from,to){
  var out=[];
  Object.keys(S.salesDocs).forEach(function(k){
    var d=S.salesDocs[k];
    if(d.day>=from && d.day<=to) (d.bills||[]).forEach(function(b){ var c=Object.assign({},b); c._shard=k; out.push(c); });
  });
  return out.sort(function(a,b){ return b.paidAt-a.paidAt; });
}
function rangeDays(r){
  var now=new Date(), t=dayKey(now);
  if(r==='today') return [t,t];
  if(r==='yday'){ var y=dayKey(new Date(now.getFullYear(),now.getMonth(),now.getDate()-1)); return [y,y]; }
  if(r==='week') return [dayKey(new Date(now.getFullYear(),now.getMonth(),now.getDate()-6)), t];
  return [dayKey(new Date(now.getFullYear(),now.getMonth(),1)), t];
}
var todayUnsub=null, todayDay=null, repUnsub=null, repKey='';
function watchToday(){
  var d=dayKey(Date.now()); if(d===todayDay) return; todayDay=d;
  if(todayUnsub) todayUnsub();
  todayUnsub=Store.watchColl('sales',{field:'day',gte:d,lte:d},function(rows){ onSalesSnap(d,d,rows); done('sales'); render(); },function(){ S.slow=true; render(); });
}
function watchRep(){
  var r=rangeDays(S.repRange), k=r[0]+'|'+r[1]; if(k===repKey) return; repKey=k;
  if(repUnsub) repUnsub();
  repUnsub=Store.watchColl('sales',{field:'day',gte:r[0],lte:r[1]},function(rows){ onSalesSnap(r[0],r[1],rows); render(); },function(){ S.slow=true; render(); });
}
function pickShard(day, add){
  var n=S.sessShard[day]||1;
  for(;;){
    var key=day+'_'+SESS+'_'+n, d=S.salesDocs[key];
    if(d && JSON.stringify(d).length+add>200000){ n++; continue; }
    S.sessShard[day]=n; return key;
  }
}
function nextBillNo(day){
  var n=0; Object.keys(S.salesDocs).forEach(function(k){ if(S.salesDocs[k].day===day) n+=(S.salesDocs[k].bills||[]).length; });
  return day.slice(2).replace(/-/g,'')+'-'+pad(n+1,3);
}
function done(name){
  S.loaded[name]=true;
  if(!S.ready && S.loaded.settings && S.loaded.menu && S.loaded.orders && S.loaded.sales) S.ready=true;
}

/* ============ icons ============ */
function svg(p,s){ return '<svg viewBox="0 0 24 24" width="'+(s||22)+'" height="'+(s||22)+'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>'; }
var IC={
  back:svg('<path d="M15 5l-7 7 7 7"/>'),
  tables:svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  menu:svg('<path d="M5 6h14M5 12h14M5 18h9"/>'),
  report:svg('<path d="M5 20V10M12 20V4M19 20v-7"/>'),
  gear:svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'),
  plus:svg('<path d="M12 5v14M5 12h14"/>',18),
  minus:svg('<path d="M5 12h14"/>',18),
  x:svg('<path d="M6 6l12 12M18 6L6 18"/>',18),
  kitchen:svg('<path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v6M7 3v6M17 21V3c-2 1-3 4-3 8h3"/>')
};

/* ============ rendering ============ */
var rafPending=false, pendingRender=false, lastKey='';
function render(){
  if(rafPending) return;
  rafPending=true;
  requestAnimationFrame(function(){ rafPending=false; doRender(); });
}
function typing(){
  var a=document.activeElement;
  return a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && (($('#view').contains(a)) || ($('#order').contains(a)));
}
function doRender(){
  if(typing()){ pendingRender=true; return; }
  pendingRender=false;
  renderTop();
  if(S.cur && !getCur()) S.cur=null;
  var key = S.cur ? 'o'+S.ordView+S.cur : 't'+S.tab;
  var same = key===lastKey; lastKey=key;
  var keep={};
  ['view','ordScroll','chips'].forEach(function(id){ var el=document.getElementById(id); if(el) keep[id]=[el.scrollTop,el.scrollLeft]; });
  if(S.cur){ renderOrder(); }
  else {
    $('#order').hidden=true;
    renderTabs();
    if(!S.ready) $('#view').innerHTML='<div class="loading">ກຳລັງໂຫຼດຂໍ້ມູນ…</div>';
    else if(S.tab==='tables') $('#view').innerHTML=viewTables();
    else if(S.tab==='kitchen') $('#view').innerHTML=viewKitchen();
    else if(S.tab==='menu') $('#view').innerHTML=viewMenu();
    else if(S.tab==='report') $('#view').innerHTML=viewReport();
    else $('#view').innerHTML=viewSettings();
  }
  if(same){
    ['view','ordScroll','chips'].forEach(function(id){ var el=document.getElementById(id); if(el && keep[id]){ el.scrollTop=keep[id][0]; el.scrollLeft=keep[id][1]; } });
  }
}
document.addEventListener('focusout',function(){ setTimeout(function(){ if(pendingRender) render(); },150); });

function bannerHtml(){
  var ib = (S.inbox.length && CTX.role!=='kitchen') ? '<button class="banner inbox" data-act="inboxOpen">🔔 ມີອໍເດີຈາກລູກຄ້າ '+S.inbox.length+' ລາຍການ · ແຕະເພື່ອເບິ່ງ</button>' : '';
  var sh=CTX.shop; if(!sh) return ib;
  var st=shopState(sh), wa=CFG.contactWhatsApp ? ' <a href="https://wa.me/'+esc(CFG.contactWhatsApp)+'" target="_blank" rel="noopener">ຕິດຕໍ່ຕໍ່ອາຍຸ</a>' : '';
  if(!st.active) return ib+'<div class="banner bad">'+(st.suspended?'ບັນຊີຮ້ານຖືກລະງັບ':'ໝົດອາຍຸການໃຊ້ງານແລ້ວ')+' · ເບິ່ງຂໍ້ມູນໄດ້ ແຕ່ຂາຍ/ແກ້ໄຂບໍ່ໄດ້'+wa+'</div>';
  if(st.days<=14) return ib+'<div class="banner warn">'+(st.trial?'ທົດລອງໃຊ້ຟຣີ ເຫຼືອ ':'ແພັກເກດຈະໝົດໃນ ')+st.days+' ວັນ'+wa+'</div>';
  if(st.trial) return ib+'<div class="banner info">ທົດລອງໃຊ້ຟຣີ ເຫຼືອ '+st.days+' ວັນ</div>';
  return ib;
}
function renderTop(){
  var d=dayKey(Date.now());
  var tot=canSales()?sum(billsInRange(d,d).filter(function(b){ return !b.void; }),function(b){ return b.total; }):0;
  var st = S.slow && !S.ready ? ['slow','ເຊື່ອມຕໍ່ຊ້າ'] : (Store.live ? ['','ເຊື່ອມຕໍ່ສົດ'] : ['local','ອັບເດດທຸກ 8 ວິນາທີ']);
  $('#top').innerHTML='<div class="shop"><b>'+esc(S.settings.shop)+'</b><span class="sync '+st[0]+'"><i></i>'+st[1]+' · '+esc(ROLE_LAO[CTX.role]||'')+'</span></div>'+
    (canSales()?'<div class="today"><small>ຍອດຂາຍມື້ນີ້</small><b class="num">'+fmt(tot)+' ₭</b></div>':'');
  var bn=$('#banner'); if(bn) bn.innerHTML=bannerHtml();
}
function tabList(){
  if(CTX.role==='kitchen') return [['kitchen','ຈໍຄົວ',IC.kitchen],['settings','ບັນຊີ',IC.gear]];
  if(CTX.role==='cashier') return [['tables','ໂຕະ',IC.tables],['report','ລາຍງານ',IC.report],['settings','ບັນຊີ',IC.gear]];
  return [['tables','ໂຕະ',IC.tables],['menu','ເມນູ',IC.menu],['report','ລາຍງານ',IC.report],['settings','ຕັ້ງຄ່າ',IC.gear]];
}
function renderTabs(){
  var t=tabList();
  if(!t.some(function(x){ return x[0]===S.tab; })) S.tab=t[0][0];
  $('#tabs').innerHTML=t.map(function(x){ return '<button class="tab" data-act="tab" data-v="'+x[0]+'" aria-current="'+(S.tab===x[0])+'">'+x[2]+'<span>'+x[1]+'</span></button>'; }).join('');
  $('#tabs').hidden=!!S.cur;
}
function ago(ts){
  var m=Math.max(0,Math.floor((Date.now()-ts)/60000));
  if(m<60) return m+' ນາທີ';
  return Math.floor(m/60)+' ຊົ່ວໂມງ '+(m%60)+' ນາທີ';
}

/* ---- tables ---- */
function viewTables(){
  var n=S.settings.tables, by={}, others=[];
  S.orders.forEach(function(o){
    var m=/^t(\d+)$/.exec(o.tableId);
    if(m && +m[1]<=n) by[o.tableId]=o; else others.push(o);
  });
  var nIn=S.inbox.length, h='';
  h+='<div class="sec"><span>ໂຕະ</span>'+(CFG && S.settings.qrOrder!==false?'<button class="btn ghost small" data-act="inboxOpen">ອໍເດີລູກຄ້າ'+(nIn?' <span class="pill">'+nIn+'</span>':'')+'</button>':'')+'</div><div class="grid">';
  for(var i=1;i<=n;i++){
    var id='t'+i, o=by[id], name='ໂຕະ '+i;
    if(o){
      var t=totals(o);
      h+='<button class="tbl busy" data-act="openTable" data-id="'+id+'" data-name="'+esc(name)+'"><b>'+esc(name)+'</b><span class="amt num">'+fmt(t.total)+' ₭</span><small>'+esc(ago(o.created))+'</small></button>';
    } else {
      h+='<button class="tbl" data-act="openTable" data-id="'+id+'" data-name="'+esc(name)+'"><b>'+esc(name)+'</b><span class="free">ຫວ່າງ</span></button>';
    }
  }
  h+='</div>';
  h+='<div class="sec"><span>ກັບບ້ານ / ເຄົາເຕີ</span><button class="btn primary small" data-act="newTk">'+IC.plus+' ບິນໃໝ່</button></div><div class="tk-list">';
  if(!others.length) h+='<div class="empty card">ບໍ່ມີບິນຄ້າງ</div>';
  others.sort(function(a,b){ return a.created-b.created; }).forEach(function(o){
    h+='<button class="tk" data-act="openOrder" data-id="'+esc(o.id)+'"><span><b>'+esc(o.tableName)+'</b><br><small>'+sum(o.items,function(i){return i.qty;})+' ລາຍການ · '+esc(ago(o.created))+'</small></span><span class="amt num">'+fmt(totals(o).total)+' ₭</span></button>';
  });
  return h+'</div>';
}

/* ---- kitchen (read-only list of open orders, newest last) ---- */
function viewKitchen(){
  var list=S.orders.slice().sort(function(a,b){ return a.created-b.created; });
  var h='<div class="sec"><span>ອໍເດີທີ່ຍັງເປີດຢູ່ ('+list.length+')</span></div>';
  if(!list.length) return h+'<div class="empty card">ຍັງບໍ່ມີອໍເດີ</div>';
  list.forEach(function(o){
    h+='<div class="card kt"><div class="kh"><b>'+esc(o.tableName)+'</b><small>'+esc(ago(o.created))+'</small></div>'+
      o.items.map(function(i){ return '<div class="kl"><span class="kq num">'+i.qty+'×</span><span>'+esc(i.name)+(i.note?'<em>'+esc(i.note)+'</em>':'')+'</span></div>'; }).join('')+'</div>';
  });
  return h;
}

/* ---- order screen ---- */
function renderOrder(){
  var o=getCur(), root=$('#order'); root.hidden=false;
  $('#tabs').hidden=true;
  root.innerHTML = S.ordView==='cart' ? cartHtml(o) : menuHtml(o);
}
function qtyOf(o,mid){ return sum(o.items.filter(function(i){ return i.mid===mid; }),function(i){ return i.qty; }); }
function menuHtml(o){
  var t=totals(o), count=sum(o.items,function(i){ return i.qty; });
  var cs=cats(), act = S.cat && cs.indexOf(S.cat)>=0 ? S.cat : null;
  function card(m){
    var q=qtyOf(o,m.id);
    return '<div class="item'+(q?' sel':'')+(m.off?' off':'')+'" data-act="add" data-id="'+esc(m.id)+'" role="button" tabindex="0"><span class="nm">'+esc(m.name)+(m.off?' <small>(ໝົດ)</small>':'')+'</span><span class="pr num">'+fmt(m.price)+'</span>'+
      (q?'<span class="badge num">'+q+'</span><button class="minus" data-act="dec" data-id="'+esc(m.id)+'" aria-label="ຫຼຸດ">'+IC.minus+'</button>':'')+'</div>';
  }
  var body='';
  if(!S.menu.length) body='<div class="empty">ຍັງບໍ່ມີເມນູ ໄປທີ່ແຖບ “ເມນູ” ເພື່ອເພີ່ມ</div>';
  else if(act) body='<div class="items" style="margin-top:6px">'+S.menu.filter(function(m){ return (m.cat||'ອື່ນໆ')===act; }).map(card).join('')+'</div>';
  else body=cs.map(function(c){ return '<div class="cat">'+esc(c)+'</div><div class="items">'+S.menu.filter(function(m){ return (m.cat||'ອື່ນໆ')===c; }).map(card).join('')+'</div>'; }).join('');
  var chips='<button class="chip" data-act="cat" data-v="" aria-pressed="'+(!act)+'">ທັງໝົດ</button>'+cs.map(function(c){ return '<button class="chip" data-act="cat" data-v="'+esc(c)+'" aria-pressed="'+(act===c)+'">'+esc(c)+'</button>'; }).join('');
  return '<div class="ohead"><button class="iconbtn" data-act="closeOrder" aria-label="ກັບຄືນ">'+IC.back+'</button><h2>'+esc(o.tableName)+'</h2></div>'+
    '<div id="chips">'+chips+'</div><div id="ordScroll">'+body+'</div>'+
    '<div class="obar"><button class="btn primary block" data-act="view" data-v="cart"'+(count?'':' disabled')+'>'+(count?'ເບິ່ງບິນ · '+count+' ລາຍການ · <span class="num">'+fmt(t.total)+' ₭</span>':'ຍັງບໍ່ໄດ້ເລືອກເມນູ')+'</button></div>';
}
function cartHtml(o){
  var t=totals(o), s=S.settings;
  var lines=o.items.map(function(i){
    return '<div class="line"><div class="info"><b>'+esc(i.name)+'</b>'+(i.note?'<div class="note">'+esc(i.note)+'</div>':'')+
      '<button class="linkbtn" data-act="note" data-id="'+esc(i.id)+'">'+(i.note?'ແກ້ໝາຍເຫດ':'+ ໝາຍເຫດ')+'</button></div>'+
      '<div class="step"><button data-act="ldec" data-id="'+esc(i.id)+'" aria-label="ຫຼຸດ">'+IC.minus+'</button><span class="num">'+i.qty+'</span><button data-act="linc" data-id="'+esc(i.id)+'" aria-label="ເພີ່ມ">'+IC.plus+'</button></div>'+
      '<div class="tot num">'+fmt(i.price*i.qty)+'</div></div>';
  }).join('');
  var sums='<div class="sumrow"><span>ລວມລາຍການ</span><span class="num">'+fmt(t.sub)+'</span></div>'+
    '<div class="sumrow"><span>ສ່ວນຫຼຸດ'+(o.disc&&o.disc.v>0?' <small>('+(o.disc.t==='p'?fmt(o.disc.v)+'%':'ຈຳນວນເງິນ')+')</small>':'')+' <button class="linkbtn" data-act="disc">'+(t.disc?'ແກ້ໄຂ':'+ ເພີ່ມ')+'</button></span><span class="num">'+(t.disc?'−'+fmt(t.disc):'0')+'</span></div>'+
    (t.svc?'<div class="sumrow"><span>ຄ່າບໍລິການ ('+fmt(s.svc)+'%)</span><span class="num">'+fmt(t.svc)+'</span></div>':'')+
    (t.vat?'<div class="sumrow"><span>ອາກອນ VAT ('+fmt(s.vat)+'%)</span><span class="num">'+fmt(t.vat)+'</span></div>':'')+
    '<div class="sumrow big"><span>ລວມທັງໝົດ</span><span class="num">'+fmt(t.total)+' ₭</span></div>';
  return '<div class="ohead"><button class="iconbtn" data-act="view" data-v="menu" aria-label="ກັບຄືນ">'+IC.back+'</button><h2>ບິນ · '+esc(o.tableName)+'</h2></div>'+
    '<div id="ordScroll" style="padding-top:12px"><div class="card">'+(lines||'<div class="empty">ຍັງບໍ່ມີລາຍການ</div>')+'</div><div class="card" style="margin-top:12px">'+sums+'</div>'+
    '<div style="margin-top:12px"><button class="btn danger block" data-act="cancelOrder">ຍົກເລີກບິນນີ້</button></div></div>'+
    '<div class="obar"><button class="btn ghost" data-act="view" data-v="menu">'+IC.plus+' ເພີ່ມເມນູ</button><button class="btn primary" style="flex:1" data-act="pay"'+(o.items.length?'':' disabled')+'>ຊຳລະເງິນ</button></div>';
}

/* ---- menu management ---- */
function viewMenu(){
  var h='<div class="sec"><span>ເມນູທັງໝົດ ('+S.menu.length+')</span><button class="btn primary small" data-act="menuAdd">'+IC.plus+' ເພີ່ມເມນູ</button></div>';
  if(!S.menu.length){
    return h+'<div class="card stack" style="text-align:center"><div class="muted">ຍັງບໍ່ມີເມນູ ເລີ່ມດ້ວຍເມນູຕົວຢ່າງ (ອາຫານລາວ + ຄາເຟ່) ແລ້ວແກ້ລາຄາ ແລະ ຊື່ຕາມຮ້ານຂອງເຈົ້າ</div><button class="btn primary block" data-act="sample">ໃຊ້ເມນູຕົວຢ່າງ</button></div>';
  }
  cats().forEach(function(c){
    h+='<div class="cat">'+esc(c)+'</div>';
    S.menu.filter(function(m){ return (m.cat||'ອື່ນໆ')===c; }).forEach(function(m){
      h+='<div class="mrow'+(m.off?' off':'')+'" data-act="menuEdit" data-id="'+esc(m.id)+'" role="button" tabindex="0"><div class="nm"><b>'+esc(m.name)+'</b><small class="num">'+fmt(m.price)+' ₭</small></div>'+
        '<button class="sw" data-act="toggle" data-id="'+esc(m.id)+'" role="switch" aria-checked="'+(!m.off)+'" aria-label="ມີຂາຍ"></button></div>';
    });
  });
  return h;
}
function menuSheet(m){
  var isNew=!m; m=m||{name:'',price:'',cat:cats()[0]||'ອາຫານ',off:false};
  var cs=cats();
  openSheet('<h3>'+(isNew?'ເພີ່ມເມນູ':'ແກ້ໄຂເມນູ')+'</h3>'+
    '<label class="f">ຊື່ເມນູ<input id="mName" value="'+esc(m.name)+'" autocomplete="off"></label>'+
    '<label class="f">ລາຄາ (₭)<input id="mPrice" inputmode="numeric" value="'+esc(m.price)+'" autocomplete="off"></label>'+
    '<label class="f">ໝວດ<input id="mCat" value="'+esc(m.cat)+'" autocomplete="off"></label>'+
    (cs.length?'<div class="quick">'+cs.map(function(c){ return '<button data-act="pickCat" data-v="'+esc(c)+'">'+esc(c)+'</button>'; }).join('')+'</div>':'')+
    '<div class="row"><button class="btn ghost" data-act="closeSheet">ຍົກເລີກ</button><button class="btn primary" data-act="menuSave" data-id="'+(isNew?'':esc(m.id))+'">ບັນທຶກ</button></div>'+
    (isNew?'':'<button class="btn danger block" data-act="menuDel" data-id="'+esc(m.id)+'">ລຶບເມນູນີ້</button>'));
}

/* ---- report ---- */
function viewReport(){
  var r=rangeDays(S.repRange), bills=billsInRange(r[0],r[1]), sm=summarize(bills);
  var rg=[['today','ມື້ນີ້'],['yday','ມື້ວານ'],['week','7 ວັນ'],['month','ເດືອນນີ້']];
  var h='<div class="ranges">'+rg.map(function(x){ return '<button class="chip" data-act="range" data-v="'+x[0]+'" aria-pressed="'+(S.repRange===x[0])+'">'+x[1]+'</button>'; }).join('')+'</div>';
  if(!bills.length) return h+'<div class="empty card">ຍັງບໍ່ມີການຂາຍໃນຊ່ວງນີ້</div>';
  h+='<div class="kpis"><div class="kpi wide"><small>ຍອດຂາຍ</small><b class="num">'+fmt(sm.total)+' ₭</b></div><div class="kpi"><small>ຈຳນວນບິນ</small><b class="num">'+sm.count+'</b></div><div class="kpi"><small>ສະເລ່ຍຕໍ່ບິນ</small><b class="num">'+fmt(sm.avg)+'</b></div></div>';
  h+=chartHtml(bills,r[0],r[1]);
  h+='<div class="sec">ເງິນທີ່ໄດ້ຮັບ</div><div class="card" style="margin-bottom:18px">'+
    '<div class="pay-row"><span>ເງິນສົດ ກີບ <small>(ຫັກເງິນທອນແລ້ວ)</small></span><b class="num">'+fmt(sm.cashLak)+' ₭</b></div>'+
    (sm.thb?'<div class="pay-row"><span>ເງິນສົດ ບາດ</span><span class="num"><b>'+fmtAmt(sm.thb)+' ฿</b> <small>≈ '+fmt(sm.thbLak)+' ₭</small></span></div>':'')+
    (sm.usd?'<div class="pay-row"><span>ເງິນສົດ ໂດລາ</span><span class="num"><b>'+fmtAmt(sm.usd)+' $</b> <small>≈ '+fmt(sm.usdLak)+' ₭</small></span></div>':'')+
    '<div class="pay-row"><span>ໂອນ QR</span><b class="num">'+fmt(sm.qr)+' ₭</b></div></div>';
  var top=Object.keys(sm.items).map(function(k){ return sm.items[k]; }).sort(function(a,b){ return b.qty-a.qty || b.rev-a.rev; }).slice(0,8);
  if(top.length){
    h+='<div class="sec">ເມນູຂາຍດີ</div><div class="card" style="margin-bottom:18px">'+top.map(function(t,i){ return '<div class="pay-row"><span>'+(i+1)+'. '+esc(t.name)+' <small class="num">× '+t.qty+'</small></span><b class="num">'+fmt(t.rev)+'</b></div>'; }).join('')+'</div>';
  }
  var cs=Object.keys(sm.cats).sort(function(a,b){ return sm.cats[b]-sm.cats[a]; });
  if(cs.length>1) h+='<div class="sec">ຍອດຕາມໝວດ</div><div class="card" style="margin-bottom:18px">'+cs.map(function(c){ return '<div class="pay-row"><span>'+esc(c)+'</span><b class="num">'+fmt(sm.cats[c])+'</b></div>'; }).join('')+'</div>';
  h+='<div class="sec">ປະຫວັດບິນ'+(sm.voids?' <small>(ຍົກເລີກ '+sm.voids+')</small>':'')+'</div>';
  bills.slice(0,S.repLimit).forEach(function(b){
    h+='<button class="brow'+(b.void?' void':'')+'" data-act="showBill" data-id="'+esc(b.id)+'"><span class="tt"><b>'+esc(b.tableName)+' <small class="num">'+esc(b.no)+'</small></b><small class="num">'+dateStr(b.paidAt)+' '+timeStr(b.paidAt)+'</small></span>'+
      (b.void?'<span class="tagvoid">ຍົກເລີກ</span>':'<b class="num">'+fmt(b.total)+' ₭</b>')+'</button>';
  });
  if(bills.length>S.repLimit) h+='<button class="btn ghost block" data-act="more">ສະແດງເພີ່ມ</button>';
  return h;
}
function chartHtml(bills,from,to){
  var ok=bills.filter(function(b){ return !b.void; }), data=[], i;
  if(!ok.length) return '';
  if(from===to){
    var hrs=[]; for(i=0;i<24;i++) hrs.push({l:String(i),v:0});
    ok.forEach(function(b){ hrs[new Date(b.paidAt).getHours()].v+=b.total; });
    var first=-1,last=-1; hrs.forEach(function(x,k){ if(x.v>0){ if(first<0) first=k; last=k; } });
    data=hrs.slice(Math.max(0,first-1),Math.min(24,last+2));
  } else {
    var m={}; ok.forEach(function(b){ var k=dayKey(b.paidAt); m[k]=(m[k]||0)+b.total; });
    for(var d=parseDay(from); dayKey(d)<=to; d.setDate(d.getDate()+1)){ var k2=dayKey(d); data.push({l:String(d.getDate()),v:m[k2]||0}); }
  }
  var mx=Math.max.apply(null,data.map(function(x){ return x.v; }))||1, step=data.length>14?5:1;
  return '<div class="sec"><span>'+(from===to?'ຍອດຂາຍຕາມຊົ່ວໂມງ':'ຍອດຂາຍຕາມວັນ')+'</span><small class="num">ສູງສຸດ '+fmt(mx)+'</small></div><div class="card" style="margin-bottom:18px"><div class="bars">'+
    data.map(function(x,k){ return '<div class="bar"><i style="height:'+Math.max(2,Math.round(x.v/mx*100))+'%" title="'+fmt(x.v)+'"></i><span class="num">'+(k%step===0?x.l:'')+'</span></div>'; }).join('')+'</div></div>';
}

/* ---- receipt ---- */
function payLabel(p){
  if(p.m==='qr') return 'ໂອນ QR';
  if(p.c==='THB') return 'ເງິນສົດ '+fmtAmt(p.amt)+' ບາດ';
  if(p.c==='USD') return 'ເງິນສົດ '+fmtAmt(p.amt)+' ໂດລາ';
  return 'ເງິນສົດ ກີບ';
}
function billSheet(b, fromReport){
  var rows=b.items.map(function(i){ return '<div class="rl"><span>'+esc(i.name)+' <small class="num">× '+i.qty+'</small>'+(i.note?'<em>'+esc(i.note)+'</em>':'')+'</span><span class="num">'+fmt(i.price*i.qty)+'</span></div>'; }).join('');
  var ex='';
  if(b.disc) ex+='<div class="rl sep"><span>ສ່ວນຫຼຸດ</span><span class="num">−'+fmt(b.disc)+'</span></div>';
  if(b.svc) ex+='<div class="rl"><span>ຄ່າບໍລິການ</span><span class="num">'+fmt(b.svc)+'</span></div>';
  if(b.vat) ex+='<div class="rl"><span>ອາກອນ VAT</span><span class="num">'+fmt(b.vat)+'</span></div>';
  var pays=(b.pays||[]).map(function(p){ return '<div class="rl"><span>'+esc(payLabel(p))+'</span><span class="num">'+fmt(p.lak)+'</span></div>'; }).join('');
  openSheet('<div class="receipt"><div class="hd"><b>'+esc(S.settings.shop)+'</b><small class="num">ບິນ '+esc(b.no)+' · '+dateStr(b.paidAt)+' '+timeStr(b.paidAt)+'</small><br><small>'+esc(b.tableName)+'</small>'+(b.void?'<div style="margin-top:6px"><span class="tagvoid">ບິນຖືກຍົກເລີກ</span></div>':'')+'</div>'+
    rows+ex+'<div class="rl sep tot"><span>ລວມທັງໝົດ</span><span class="num">'+fmt(b.total)+' ₭</span></div><div class="rl sep"><small>ການຊຳລະ</small><span></span></div>'+pays+
    (b.change?'<div class="rl"><span>ເງິນທອນ</span><span class="num">'+fmt(b.change)+'</span></div>':'')+'</div>'+
    '<div class="row"><button class="btn ghost" data-act="copyBill" data-id="'+esc(b.id)+'">ຄັດລອກໃບບິນ</button><button class="btn primary" data-act="closeSheet">ປິດ</button></div>'+
    (fromReport&&!b.void?'<button class="btn danger block" data-act="voidBill" data-id="'+esc(b.id)+'">ຍົກເລີກບິນນີ້</button>':''));
  SHOWN=b;
}
var SHOWN=null;
function billText(b){
  var L=[S.settings.shop, 'ບິນ '+b.no+' · '+dateStr(b.paidAt)+' '+timeStr(b.paidAt), b.tableName, '------------------'];
  b.items.forEach(function(i){ L.push(i.name+' × '+i.qty+'   '+fmt(i.price*i.qty)+(i.note?' ('+i.note+')':'')); });
  L.push('------------------');
  if(b.disc) L.push('ສ່ວນຫຼຸດ −'+fmt(b.disc));
  if(b.svc) L.push('ຄ່າບໍລິການ '+fmt(b.svc));
  if(b.vat) L.push('ອາກອນ VAT '+fmt(b.vat));
  L.push('ລວມທັງໝົດ '+fmt(b.total)+' ₭');
  (b.pays||[]).forEach(function(p){ L.push(payLabel(p)+' '+fmt(p.lak)); });
  if(b.change) L.push('ເງິນທອນ '+fmt(b.change));
  L.push('ຂອບໃຈທີ່ອຸດໜູນ');
  return L.join('\n');
}
function copyText(t){
  var ok=false;
  try{ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(function(){ toast('ຄັດລອກແລ້ວ'); },function(){ copyFallback(t); }); ok=true; } }catch(e){}
  if(!ok) copyFallback(t);
}
function copyFallback(t){
  openSheet('<h3>ຄັດລອກໃບບິນ</h3><small>ແຕະຄ້າງທີ່ຂໍ້ຄວາມ ແລ້ວເລືອກ “ຄັດລອກ”</small><textarea readonly rows="10" id="cpTxt">'+esc(t)+'</textarea><button class="btn primary block" data-act="closeSheet">ປິດ</button>');
  var ta=$('#cpTxt'); if(ta){ try{ ta.focus(); ta.select(); }catch(e){} }
}

/* ---- settings ---- */
function planLabel(sh){
  if(sh.plan==='trial') return 'ທົດລອງໃຊ້ຟຣີ';
  var p=(CFG.plans||[]).filter(function(x){ return x.id===sh.plan; })[0];
  return p?p.name:sh.plan;
}
function viewSettings(){
  var s=S.settings, h='';
  if(isBoss()){
    var qrOk = typeof s.qr==='string' && s.qr.indexOf('data:image/')===0;
    h+='<div class="set-g"><div class="sec">ຮ້ານ</div>'+
      '<label class="f">ຊື່ຮ້ານ<input data-set="shop" value="'+esc(s.shop)+'" autocomplete="off"></label>'+
      '<label class="f">ຈຳນວນໂຕະ<input data-set="tables" inputmode="numeric" value="'+esc(s.tables)+'"></label></div>'+
      '<div class="set-g"><div class="sec">ສັ່ງອາຫານຜ່ານ QR <small>(ລູກຄ້າສະແກນ → ອໍເດີເຂົ້າແອັບ)</small></div>'+
      '<div class="mrow" style="cursor:default"><div class="nm"><b>ເປີດໃຫ້ລູກຄ້າສັ່ງເອງ</b><small>ປິດໄດ້ເວລາບໍ່ຕ້ອງການ</small></div><button class="sw" data-act="toggleQrOrder" role="switch" aria-checked="'+(s.qrOrder!==false)+'" aria-label="ເປີດສັ່ງຜ່ານ QR"></button></div>'+
      '<div class="row"><button class="btn ghost" data-act="qrPrint">ພິມ QR ໂຕະ</button><button class="btn ghost" data-act="qrTest">ທົດລອງເປີດ</button></div></div>'+
      '<div class="set-g"><div class="sec">ຄ່າບໍລິການ ແລະ ອາກອນ <small>(ໃສ່ 0 ຖ້າບໍ່ໃຊ້)</small></div><div class="two">'+
      '<label class="f">ຄ່າບໍລິການ (%)<input data-set="svc" inputmode="decimal" value="'+esc(s.svc)+'"></label>'+
      '<label class="f">ອາກອນ VAT (%)<input data-set="vat" inputmode="decimal" value="'+esc(s.vat)+'"></label></div></div>'+
      '<div class="set-g"><div class="sec">ອັດຕາແລກປ່ຽນ <small>(ກີບ ຕໍ່ 1 ໜ່ວຍ)</small></div><div class="two">'+
      '<label class="f">1 ບາດ = ກີບ<input data-set="THB" inputmode="decimal" value="'+esc(s.THB)+'"></label>'+
      '<label class="f">1 ໂດລາ = ກີບ<input data-set="USD" inputmode="decimal" value="'+esc(s.USD)+'"></label></div></div>'+
      '<div class="set-g"><div class="sec">QR ຮັບເງິນໂອນ</div>'+
      (qrOk?'<img class="qrimg" alt="QR" src="'+esc(s.qr)+'">':'<div class="muted">ຍັງບໍ່ໄດ້ຕັ້ງ ເລືອກຮູບ QR ຂອງຮ້ານຈາກຮູບໃນເຄື່ອງ ເພື່ອສະແດງຕອນຊຳລະເງິນ</div>')+
      '<input type="file" id="qrFile" accept="image/*" hidden>'+
      '<div class="row"><button class="btn ghost" data-act="qrPick">'+(qrOk?'ປ່ຽນຮູບ QR':'ເລືອກຮູບ QR')+'</button>'+(qrOk?'<button class="btn danger" data-act="qrClear">ລຶບ QR</button>':'')+'</div></div>'+
      '<div class="set-g"><div class="sec">ທີມງານ</div><div class="muted">ເຊີນແຄຊເຍີ / ຄົວ / ຜູ້ຈັດການ ໃຫ້ມີບັນຊີຂອງຕົນເອງ</div><button class="btn ghost block" data-act="team">ຈັດການທີມງານ</button></div>';
  }
  var sh=CTX.shop, st=sh?shopState(sh):null;
  h+='<div class="set-g"><div class="sec">ແພັກເກດ</div><div class="card">'+
    '<div class="pay-row"><span>ແພັກເກດ</span><b>'+esc(sh?planLabel(sh):'')+'</b></div>'+
    '<div class="pay-row"><span>ໝົດອາຍຸ</span><b class="num">'+(st&&st.end?dateStr(st.end):'-')+(st&&st.active?' · ເຫຼືອ '+st.days+' ວັນ':'')+'</b></div>'+
    (CFG.contactWhatsApp?'<div style="margin-top:10px"><a class="btn ghost block" href="https://wa.me/'+esc(CFG.contactWhatsApp)+'" target="_blank" rel="noopener">'+esc(CFG.contactText||'ຕິດຕໍ່ທີມງານ')+'</a></div>':'')+
    '</div></div>'+
    '<div class="set-g"><div class="sec">ບັນຊີ</div><div class="card"><div class="pay-row"><span>ເຂົ້າສູ່ລະບົບເປັນ</span><b class="num">'+esc(loginShow(CTX.user&&CTX.user.email))+'</b></div>'+
    '<div class="pay-row"><span>ຕຳແໜ່ງ</span><b>'+esc(ROLE_LAO[CTX.role]||'')+'</b></div></div>'+
    (CTX.shops.length>1?'<button class="btn ghost block" data-act="switchShop">ປ່ຽນຮ້ານ</button>':'')+
    '<button class="btn ghost block" data-act="logout">ອອກຈາກລະບົບ</button></div>';
  if(CTX.role==='owner'){
    h+='<div class="set-g"><div class="sec">ຂໍ້ມູນ</div><div class="muted">ຂໍ້ມູນເກັບໃນເຊີບເວີ ເປີດຈາກເຄື່ອງອື່ນກໍ່ເຫັນຊຸດດຽວກັນ.</div>'+
      '<button class="btn danger block" data-act="clearSales">ລຶບປະຫວັດການຂາຍທັງໝົດ (ລ້າງຂໍ້ມູນທົດລອງ)</button></div>';
  }
  return h;
}

/* ============ payment ============ */
function openPay(){
  var o=getCur(); if(!o||!o.items.length) return;
  if(!PAY || PAY.oid!==o.id) PAY={oid:o.id, sel:'LAK', lines:[], amt:''};
  openSheet(payHtml());
}
function payHtml(){
  var o=getCur(), t=totals(o), r=rates(), ps=payState(t.total,PAY.lines), sel=PAY.sel, cur=sel==='QR'?'LAK':sel;
  var opts=[['LAK','ເງິນສົດ ₭'],['THB','ເງິນສົດ ฿'],['USD','ເງິນສົດ $'],['QR','ໂອນ QR']];
  var quick={LAK:[50000,100000,200000,500000],THB:[100,500,1000],USD:[10,20,50,100],QR:[]}[sel];
  var qrOk = typeof S.settings.qr==='string' && S.settings.qr.indexOf('data:image/')===0;
  var h='<h3>ຊຳລະເງິນ · '+esc(o.tableName)+'</h3>'+
    '<div class="due"><small>ຍອດທີ່ຕ້ອງຊຳລະ</small><b class="num">'+fmt(t.total)+' ₭</b><small class="num">≈ '+fmt(fromLak('THB',t.total,r))+' ฿ · ≈ '+fmtUsd(fromLak('USD',t.total,r))+' $</small></div>';
  if(PAY.lines.length){
    h+='<div>'+PAY.lines.map(function(p,i){ return '<div class="pl"><span>'+esc(payLabel(p))+'</span><b class="num">'+fmt(p.lak)+' ₭</b><button class="x" data-act="payDel" data-i="'+i+'" aria-label="ລຶບ">'+IC.x+'</button></div>'; }).join('')+'</div>';
  }
  h+=payStatHtml(ps);
  if(ps.remain>0){
    h+='<div class="seg" role="group" aria-label="ວິທີຊຳລະ">'+opts.map(function(x){ return '<button data-act="paySel" data-v="'+x[0]+'" aria-pressed="'+(sel===x[0])+'">'+x[1]+'</button>'; }).join('')+'</div>';
    if(sel==='QR'){
      h+=qrOk?'<img class="qrimg" alt="QR ຮັບເງິນ" src="'+esc(S.settings.qr)+'">':'<div class="muted">ຍັງບໍ່ໄດ້ຕັ້ງຮູບ QR ໄປທີ່ ຕັ້ງຄ່າ → QR ຮັບເງິນໂອນ</div>';
    }
    h+='<label class="f">'+(sel==='QR'?'ຈຳນວນທີ່ໂອນ (₭)':'ຈຳນວນທີ່ໄດ້ຮັບ ('+{LAK:'ກີບ',THB:'ບາດ',USD:'ໂດລາ'}[cur]+')')+'<input id="payAmt" inputmode="decimal" autocomplete="off" value="'+esc(PAY.amt)+'"></label>'+
      '<div id="payConv" class="muted num" style="min-height:22px"></div>'+
      '<div class="quick"><button data-act="payExact">ພໍດີ</button>'+quick.map(function(v){ return '<button data-act="payQuick" data-v="'+v+'" class="num">'+fmt(v)+'</button>'; }).join('')+'</div>'+
      '<button class="btn ghost block" data-act="payAdd">ຮັບເງິນ</button>';
  }
  h+='<div class="row"><button class="btn ghost" data-act="closeSheet">ປິດ</button><button class="btn primary" data-act="payDone"'+((ps.remain>0)?' disabled':'')+'>ຢືນຢັນຊຳລະ</button></div>';
  return h;
}
function payStatHtml(ps){
  if(ps.remain>0 && ps.paid>0) return '<div class="stat short">ຍັງຂາດ <span class="big num">'+fmt(ps.remain)+' ₭</span></div>';
  if(ps.remain>0) return '';
  if(ps.change>0) return '<div class="stat okay">ເງິນທອນ <span class="big num">'+fmt(ps.change)+' ₭</span></div>';
  return '<div class="stat okay">ຮັບເງິນຄົບແລ້ວ</div>';
}
function payRefresh(focus){
  setSheet(payHtml());
  var el=$('#payAmt'); if(el){ el.value=PAY.amt; if(focus){ try{ el.focus(); }catch(e){} } }
  payPreview();
}
function payPreview(){
  var el=$('#payConv'); if(!el||!PAY) return;
  var cur=PAY.sel==='QR'?'LAK':PAY.sel, v=num(PAY.amt);
  el.textContent = (cur!=='LAK' && v>0) ? '= '+fmt(toLak(cur,v,rates()))+' ₭' : '';
}
function payRemain(){ var o=getCur(); return payState(totals(o).total, PAY.lines).remain; }
function finishPay(){
  var o=getCur(); if(!o||!PAY) return;
  var t=totals(o), ps=payState(t.total,PAY.lines);
  if(ps.remain>0) return;
  var now=Date.now(), day=dayKey(now), r=rates();
  var bill={
    id:o.id, no:nextBillNo(day), tableId:o.tableId, tableName:o.tableName, tk:o.tableId==='tk',
    items:o.items.map(function(i){ return {name:i.name,price:i.price,qty:i.qty,note:i.note||'',cat:i.cat||''}; }),
    sub:t.sub, disc:t.disc, svc:t.svc, vat:t.vat, total:t.total,
    pays:clone(PAY.lines), paid:ps.paid, change:ps.change, created:o.created, paidAt:now, void:false, rate:r
  };
  var key=pickShard(day, JSON.stringify(bill).length);
  var doc=clone(S.salesDocs[key])||{day:day,bills:[]};
  doc.day=day; doc.bills=(doc.bills||[]).concat([bill]);
  S.salesDocs[key]=doc; S.shardLW[key]=now;
  closeSheet(); PAY=null;
  var oid=o.id; S.cur=null; S.draft=null; S.ordView='menu';
  enqueue('sales/'+key,function(){ return Store.set('sales',key,doc,doc.day); }).then(function(){ deleteOrder(oid); },function(){
    S.shardLW[key]=0; toast('ບັນທຶກບິນບໍ່ສຳເລັດ ບິນຍັງຄ້າງຢູ່ໂຕະ');
  });
  S.orders=S.orders.filter(function(x){ return x.id!==oid; });
  lastDel[oid]=now;
  render();
  var shown=Object.assign({},bill); shown._shard=key;
  billSheet(shown,false);
}

/* ============ orders sent by customers (QR -> straight into the POS) ============ */
var beepCtx=null, IN_OPEN=false, INB_BUSY={}, titleBase=document.title;
function unlockAudio(){
  try{
    if(!beepCtx){ var AC=window.AudioContext||window.webkitAudioContext; if(AC) beepCtx=new AC(); }
    if(beepCtx && beepCtx.state==='suspended') beepCtx.resume();
  }catch(e){}
}
function beep(){
  try{
    unlockAudio();
    if(beepCtx){
      [880,1175].forEach(function(f,k){
        var o=beepCtx.createOscillator(), g=beepCtx.createGain(), t=beepCtx.currentTime+k*0.22;
        o.type='sine'; o.frequency.value=f; g.gain.setValueAtTime(0.18,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.2);
        o.connect(g); g.connect(beepCtx.destination); o.start(t); o.stop(t+0.21);
      });
    }
  }catch(e){}
  try{ if(navigator.vibrate) navigator.vibrate([200,100,200]); }catch(e){}
}
function setTitle(){ document.title = S.inbox.length ? '('+S.inbox.length+') '+titleBase : titleBase; }
function onInbox(rows){
  var list=rows.filter(function(r){ return r.status==='new'; }).sort(function(a,b){ return (a.created||0)-(b.created||0); });
  var fresh=false;
  if(S.inboxSeen===null){ S.inboxSeen={}; list.forEach(function(r){ S.inboxSeen[r.id]=1; }); fresh=list.length>0; }
  else list.forEach(function(r){ if(!S.inboxSeen[r.id]){ S.inboxSeen[r.id]=1; fresh=true; } });
  S.inbox=list; setTitle(); done('inbox');
  if(fresh){ beep(); toast('ມີອໍເດີຈາກລູກຄ້າ'); }
  if(IN_OPEN && sheetOpen()) inboxSheet();
  render();
}
function inboxName(r){ return r.table==='tk' ? 'ກັບບ້ານ'+(r.name?' · '+r.name:'') : 'ໂຕະ '+String(r.table).slice(1); }
function inboxHtml(){
  var h='<h3>ອໍເດີຈາກລູກຄ້າ</h3>';
  if(!S.inbox.length) h+='<div class="empty">ບໍ່ມີອໍເດີລໍຖ້າ</div>';
  S.inbox.forEach(function(r){
    var total=sum(r.items||[],function(i){ return i.price*i.qty; });
    h+='<div class="card inb"><div class="kh"><b>'+esc(inboxName(r))+'</b><small>'+esc(ago(r.created||Date.now()))+'</small></div>'+
      (r.items||[]).map(function(i){ return '<div class="kl"><span class="kq num">'+i.qty+'×</span><span>'+esc(i.name)+(i.note?'<em>'+esc(i.note)+'</em>':'')+'</span><b class="num">'+fmt(i.price*i.qty)+'</b></div>'; }).join('')+
      '<div class="sumrow big"><span>ລວມ</span><span class="num">'+fmt(total)+' ₭</span></div>'+
      '<div class="row"><button class="btn ghost" data-act="inboxNo" data-id="'+esc(r.id)+'">ປະຕິເສດ</button><button class="btn primary" data-act="inboxOk" data-id="'+esc(r.id)+'">ຮັບເຂົ້າບິນ</button></div></div>';
  });
  return h+'<button class="btn ghost block" data-act="closeSheet">ປິດ</button>';
}
function inboxSheet(){
  if(sheetOpen() && IN_OPEN) setSheet(inboxHtml());
  else { openSheet(inboxHtml()); IN_OPEN=true; }
}
function resolveInbox(id,status){
  if(INB_BUSY[id]) return; INB_BUSY[id]=1;
  Api.rpc('inbox_resolve',{p_shop:CTX.shop.id,p_id:id,p_status:status}).then(function(d){
    delete INB_BUSY[id];
    S.inbox=S.inbox.filter(function(r){ return r.id!==id; }); setTitle();
    if(!d) toast('ມີຄົນຈັດການອໍເດີນີ້ແລ້ວ');
    else if(status==='accepted') acceptIntoOrder(d,id);
    else toast('ປະຕິເສດແລ້ວ');
    if(IN_OPEN && sheetOpen()) inboxSheet();
    render();
  },function(e){ delete INB_BUSY[id]; toast(Api.errText(e)); });
}
function acceptIntoOrder(d,id){
  var table=d.table, o, ex = table!=='tk' ? S.orders.find(function(x){ return x.tableId===table; }) : null;
  if(ex) o=clone(ex);
  else {
    var nm='ໂຕະ '+String(table).slice(1);
    if(table==='tk'){
      var day=dayKey(Date.now());
      var n=S.orders.filter(function(x){ return x.tableId==='tk'; }).length + billsInRange(day,day).filter(function(b){ return b.tk; }).length + 1;
      nm='ກັບບ້ານ '+n+(d.name?' · '+d.name:'');
    }
    o={id:uid(),tableId:table,tableName:nm,items:[],disc:null,created:Date.now(),updated:Date.now()};
  }
  (d.items||[]).forEach(function(i){
    var ln=o.items.find(function(x){ return x.mid===i.mid && (x.note||'')===(i.note||''); });
    if(ln) ln.qty+=i.qty; else o.items.push({id:uid(),mid:i.mid,name:i.name,price:i.price,cat:i.cat||'',qty:i.qty,note:i.note||''});
  });
  commit(o);
  flush(o.id).then(null,function(){
    lastWrite[o.id]=0; dirty[o.id]=false;
    Api.rpc('inbox_reopen',{p_shop:CTX.shop.id,p_id:id}).then(null,function(){});
    Store.reload('orders'); Store.reload('inbox');
    toast('ບັນທຶກບໍ່ສຳເລັດ ອໍເດີຖືກສົ່ງຄືນໄປລໍຖ້າ');
  });
  toast('ເພີ່ມເຂົ້າ '+o.tableName+' ແລ້ວ');
}

/* ============ team, QR sheets, account ============ */
function loginShow(l){ l=String(l||''); var dm='@'+(CFG.phoneDomain||''); return l.slice(-dm.length)===dm ? l.slice(0,-dm.length) : l; }
function teamHtml(){
  var me=CTX.user && CTX.user.id, rows;
  if(!S.team) rows='<div class="muted">ກຳລັງໂຫຼດ…</div>';
  else rows=S.team.map(function(m){
    var can = m.role!=='owner' && m.user_id!==me && (CTX.role==='owner' || m.role!=='manager');
    return '<div class="pl"><span><b>'+esc(m.display_name||loginShow(m.login))+'</b><br><small>'+esc(ROLE_LAO[m.role]||m.role)+' · '+esc(loginShow(m.login))+'</small></span>'+(can?'<button class="x" data-act="rmMember" data-id="'+esc(m.user_id)+'" aria-label="ລຶບ">'+IC.x+'</button>':'')+'</div>';
  }).join('');
  var roles=[['cashier','ແຄຊເຍີ'],['kitchen','ຄົວ']]; if(CTX.role==='owner') roles.unshift(['manager','ຜູ້ຈັດການ']);
  var inv=S.invite?('<div class="stat okay">ລະຫັດເຊີນ <span class="big num" style="letter-spacing:3px">'+esc(S.invite.code)+'</span><small>ໃຊ້ໄດ້ 7 ວັນ ໃຊ້ໄດ້ຄັ້ງດຽວ · ໃຫ້ພະນັກງານເປີດລິ້ງນີ້:</small><br><small class="num" style="word-break:break-all">'+esc(S.invite.link)+'</small></div><button class="btn ghost block" data-act="copyInvite">ຄັດລອກລິ້ງເຊີນ</button>'):'';
  return '<h3>ທີມງານ</h3><div>'+rows+'</div><div class="sec" style="margin-top:6px">ເຊີນພະນັກງານ</div>'+
    '<label class="f">ຊື່ (ບໍ່ບັງຄັບ)<input id="invName" autocomplete="off" maxlength="40" placeholder="ເຊັ່ນ ນ້ອງແອ"></label>'+
    '<div class="seg" role="group">'+roles.map(function(r){ return '<button data-act="invRole" data-v="'+r[0]+'" aria-pressed="'+(INV_ROLE===r[0])+'">'+r[1]+'</button>'; }).join('')+'</div>'+
    '<button class="btn primary block" data-act="invite">ສ້າງລະຫັດເຊີນ</button>'+inv+
    '<button class="btn ghost block" data-act="closeSheet">ປິດ</button>';
}
var INV_ROLE='cashier';
function loadTeam(){
  Api.rpc('list_members',{p_shop:CTX.shop.id}).then(function(rows){ S.team=rows||[]; if(sheetOpen() && TEAM_OPEN) setSheet(teamHtml()); },function(e){ toast(Api.errText(e)); });
}
var TEAM_OPEN=false;
function qrUrl(t){ return new URL('m.html?s='+encodeURIComponent(CTX.shop.slug)+'&t='+t, location.href).href; }
function qrSvg(text){ var q=window.qrcode(0,'M'); q.addData(text); q.make(); return q.createSvgTag({cellSize:4,margin:2,scalable:true}); }
function printHtml(){
  var n=S.settings.tables, cards='';
  function card(t,label){ return '<div class="qc"><b class="qs">'+esc(S.settings.shop)+'</b><div class="qi">'+qrSvg(qrUrl(t))+'</div><div class="ql">'+esc(label)+'</div><small>ສະແກນເພື່ອເບິ່ງເມນູ ແລະ ສັ່ງອາຫານ</small></div>'; }
  for(var i=1;i<=n;i++) cards+=card('t'+i,'ໂຕະ '+i);
  cards+=card('tk','ສັ່ງກັບບ້ານ');
  return '<div class="ptool"><button class="btn ghost" data-act="qrBack">'+IC.back+' ກັບຄືນ</button><button class="btn primary" data-act="doPrint">ພິມ</button></div>'+
    '<p class="ptip">ພິມແລ້ວຕັດ ແລະ ວາງໃສ່ແຕ່ລະໂຕະ. ເມື່ອລູກຄ້າສະແກນ ເມນູຈະເປີດໃນໂທລະສັບ ແລະ ອໍເດີຈະເຂົ້າມາໃນແອັບທັນທີ.</p><div class="qgrid">'+cards+'</div>';
}

/* ============ actions ============ */
var H={
  tab:function(el){ S.tab=el.dataset.v; if(S.tab==='report') watchRep(); render(); },
  scrim:function(){ closeSheet(); },
  closeSheet:function(){ closeSheet(); },
  dlgNo:function(){ dlgEnd(false); },
  dlgYes:function(){ dlgEnd(true); },

  openTable:function(el){
    var id=el.dataset.id, ex=S.orders.find(function(o){ return o.tableId===id; });
    if(ex){ S.cur=ex.id; }
    else { S.draft={id:uid(),tableId:id,tableName:el.dataset.name,items:[],disc:null,created:Date.now(),updated:Date.now(),draft:true}; S.cur=S.draft.id; }
    S.ordView='menu'; render();
  },
  openOrder:function(el){ S.cur=el.dataset.id; S.ordView='menu'; render(); },
  newTk:function(){
    var d=dayKey(Date.now());
    var n=S.orders.filter(function(o){ return o.tableId==='tk'; }).length + billsInRange(d,d).filter(function(b){ return b.tk; }).length + 1;
    S.draft={id:uid(),tableId:'tk',tableName:'ກັບບ້ານ '+n,items:[],disc:null,created:Date.now(),updated:Date.now(),draft:true};
    S.cur=S.draft.id; S.ordView='menu'; render();
  },
  closeOrder:function(){ S.cur=null; S.draft=null; render(); },
  cat:function(el){ S.cat=el.dataset.v||null; render(); },
  view:function(el){ S.ordView=el.dataset.v; render(); },
  add:function(el){
    var m=S.menu.find(function(x){ return x.id===el.dataset.id; });
    if(!m){ return; }
    if(m.off){ toast('ເມນູນີ້ໝົດ'); return; }
    edit(function(o){
      var ln=o.items.find(function(i){ return i.mid===m.id && !i.note; });
      if(ln) ln.qty++; else o.items.push({id:uid(),mid:m.id,name:m.name,price:m.price,cat:m.cat||'',qty:1,note:''});
    });
  },
  dec:function(el){
    edit(function(o){
      for(var k=o.items.length-1;k>=0;k--){
        if(o.items[k].mid===el.dataset.id){ o.items[k].qty--; if(o.items[k].qty<=0) o.items.splice(k,1); break; }
      }
    });
  },
  linc:function(el){ edit(function(o){ var l=o.items.find(function(i){ return i.id===el.dataset.id; }); if(l) l.qty++; }); },
  ldec:function(el){ edit(function(o){ var k=o.items.findIndex(function(i){ return i.id===el.dataset.id; }); if(k>=0){ o.items[k].qty--; if(o.items[k].qty<=0) o.items.splice(k,1); } }); },
  note:function(el){
    var o=getCur(), l=o.items.find(function(i){ return i.id===el.dataset.id; }); if(!l) return;
    openSheet('<h3>ໝາຍເຫດ · '+esc(l.name)+'</h3><label class="f">ຂໍ້ຄວາມ<input id="noteTxt" value="'+esc(l.note||'')+'" placeholder="ເຊັ່ນ: ບໍ່ເຜັດ, ນ້ຳຕານໜ້ອຍ" autocomplete="off"></label>'+
      '<div class="row"><button class="btn ghost" data-act="closeSheet">ຍົກເລີກ</button><button class="btn primary" data-act="noteSave" data-id="'+esc(l.id)+'">ບັນທຶກ</button></div>');
  },
  noteSave:function(el){
    var v=($('#noteTxt').value||'').trim().slice(0,80), id=el.dataset.id;
    closeSheet();
    edit(function(o){
      var k=o.items.findIndex(function(i){ return i.id===id; }); if(k<0) return;
      o.items[k].note=v;
      var same=o.items.find(function(i,j){ return j!==k && i.mid===o.items[k].mid && (i.note||'')===v; });
      if(same){ same.qty+=o.items[k].qty; o.items.splice(k,1); }
    });
  },
  disc:function(){
    var o=getCur(), d=o.disc||{t:'a',v:''};
    openSheet('<h3>ສ່ວນຫຼຸດ</h3><div class="seg"><button data-act="discType" data-v="a" aria-pressed="'+(d.t==='a')+'">ຈຳນວນເງິນ (₭)</button><button data-act="discType" data-v="p" aria-pressed="'+(d.t==='p')+'">ເປີເຊັນ (%)</button></div>'+
      '<label class="f">ຈຳນວນ<input id="discVal" inputmode="decimal" value="'+esc(d.v||'')+'" autocomplete="off"></label>'+
      '<div class="row"><button class="btn ghost" data-act="discClear">ລຶບສ່ວນຫຼຸດ</button><button class="btn primary" data-act="discSave">ບັນທຶກ</button></div>');
    DISC_T=d.t;
  },
  discType:function(el){ DISC_T=el.dataset.v; var b=document.querySelectorAll('[data-act="discType"]'); for(var i=0;i<b.length;i++) b[i].setAttribute('aria-pressed', String(b[i].dataset.v===DISC_T)); },
  discSave:function(){ var v=num($('#discVal').value), t=DISC_T; closeSheet(); edit(function(o){ o.disc = v>0 ? {t:t,v:v} : null; }); },
  discClear:function(){ closeSheet(); edit(function(o){ o.disc=null; }); },
  cancelOrder:function(){
    ask('ຍົກເລີກບິນນີ້?','ລາຍການທັງໝົດໃນບິນຈະຖືກລຶບ','ຍົກເລີກບິນ',true).then(function(y){
      if(!y) return; var id=S.cur; S.cur=null; S.draft=null; deleteOrder(id); render();
    });
  },
  pay:function(){ openPay(); },
  paySel:function(el){ PAY.sel=el.dataset.v; PAY.amt=''; payRefresh(true); },
  payQuick:function(el){ PAY.amt=el.dataset.v; var a=$('#payAmt'); if(a) a.value=PAY.amt; payPreview(); },
  payExact:function(){
    var cur=PAY.sel==='QR'?'LAK':PAY.sel;
    PAY.amt=String(fromLak(cur,payRemain(),rates())); var a=$('#payAmt'); if(a) a.value=PAY.amt; payPreview();
  },
  payAdd:function(){
    var sel=PAY.sel, cur=sel==='QR'?'LAK':sel, v=num(PAY.amt), remain=payRemain();
    if(!(v>0)){ toast('ໃສ່ຈຳນວນເງິນກ່ອນ'); return; }
    var line;
    if(sel==='QR'){ var lak=Math.min(Math.round(v),remain); line={m:'qr',c:'LAK',amt:lak,lak:lak}; }
    else line={m:'cash',c:cur,amt:v,lak:toLak(cur,v,rates())};
    PAY.lines.push(line); PAY.amt=''; payRefresh(false);
  },
  payDel:function(el){ PAY.lines.splice(+el.dataset.i,1); payRefresh(false); },
  payDone:function(){ finishPay(); },

  menuAdd:function(){ menuSheet(null); },
  menuEdit:function(el){ var m=S.menu.find(function(x){ return x.id===el.dataset.id; }); if(m) menuSheet(m); },
  pickCat:function(el){ $('#mCat').value=el.dataset.v; },
  menuSave:function(el){
    var name=($('#mName').value||'').trim(), price=Math.round(num($('#mPrice').value)), cat=($('#mCat').value||'').trim()||'ອື່ນໆ', id=el.dataset.id;
    if(!name){ toast('ໃສ່ຊື່ເມນູ'); return; }
    if(!(price>=0) || $('#mPrice').value.trim()===''){ toast('ໃສ່ລາຄາເປັນຕົວເລກ'); return; }
    var old=S.menu.find(function(x){ return x.id===id; });
    var rec={name:name,price:price,cat:cat,off:old?!!old.off:false,sort:old?old.sort:Date.now()};
    var nid=id||uid();
    S.menu=S.menu.filter(function(x){ return x.id!==nid; }).concat([Object.assign({id:nid},rec)]).sort(sortMenu);
    enqueue('menu/'+nid,function(){ return Store.set('menu',nid,rec); });
    closeSheet(); render();
  },
  menuDel:function(el){
    var id=el.dataset.id, m=S.menu.find(function(x){ return x.id===id; });
    ask('ລຶບເມນູນີ້?', m?m.name:'', 'ລຶບ', true).then(function(y){
      if(!y) return;
      S.menu=S.menu.filter(function(x){ return x.id!==id; });
      enqueue('menu/'+id,function(){ return Store.del('menu',id); });
      closeSheet(); render();
    });
  },
  toggle:function(el,e){
    e.stopPropagation();
    var m=S.menu.find(function(x){ return x.id===el.dataset.id; }); if(!m) return;
    m.off=!m.off;
    var rec={name:m.name,price:m.price,cat:m.cat,off:m.off,sort:m.sort};
    enqueue('menu/'+m.id,function(){ return Store.set('menu',m.id,rec); });
    render();
  },
  sample:function(){
    var base=Date.now(), i=0;
    SAMPLE.forEach(function(g){ g[1].forEach(function(it){
      var id=uid()+(i++), rec={name:it[0],price:it[1],cat:g[0],off:false,sort:base+i};
      S.menu.push(Object.assign({id:id},rec));
      enqueue('menu/'+id,function(){ return Store.set('menu',id,rec); });
    }); });
    S.menu.sort(sortMenu); toast('ເພີ່ມເມນູຕົວຢ່າງແລ້ວ'); render();
  },

  inboxOpen:function(){ unlockAudio(); inboxSheet(); },
  inboxOk:function(el){ resolveInbox(el.dataset.id,'accepted'); },
  inboxNo:function(el){ resolveInbox(el.dataset.id,'rejected'); },

  toggleQrOrder:function(el,e){ e.stopPropagation(); saveSettings({qrOrder: S.settings.qrOrder===false}); },
  qrPrint:function(){ var r=$('#printRoot'); r.innerHTML=printHtml(); r.classList.add('on'); },
  qrBack:function(){ var r=$('#printRoot'); r.classList.remove('on'); r.innerHTML=''; },
  doPrint:function(){ try{ window.print(); }catch(e){ toast('ເປີດເມນູພິມຂອງບຣາວເຊີ'); } },
  qrTest:function(){ window.open(qrUrl('t1'),'_blank'); },

  team:function(){ S.team=null; openSheet(teamHtml()); TEAM_OPEN=true; loadTeam(); },
  invRole:function(el){ INV_ROLE=el.dataset.v; var b=document.querySelectorAll('[data-act="invRole"]'); for(var i=0;i<b.length;i++) b[i].setAttribute('aria-pressed',String(b[i].dataset.v===INV_ROLE)); },
  invite:function(){
    var nm=($('#invName')||{}).value||'';
    Api.rpc('create_invite',{p_shop:CTX.shop.id,p_role:INV_ROLE,p_name:nm.trim()||null}).then(function(code){
      S.invite={code:code,link:new URL('login.html?join='+code,location.href).href};
      if(sheetOpen() && TEAM_OPEN){ setSheet(teamHtml()); }
    },function(e){ toast(Api.errText(e)); });
  },
  copyInvite:function(){ if(S.invite) copyText(S.invite.link); },
  rmMember:function(el){
    var id=el.dataset.id, m=(S.team||[]).find(function(x){ return x.user_id===id; });
    ask('ລຶບຜູ້ໃຊ້ນີ້ອອກຈາກຮ້ານ?', m?(m.display_name||loginShow(m.login)):'', 'ລຶບອອກ', true).then(function(y){
      if(!y) return;
      Api.rpc('remove_member',{p_shop:CTX.shop.id,p_user:id}).then(function(){ toast('ລຶບແລ້ວ'); S.team=null; if(sheetOpen()) { openSheet(teamHtml()); TEAM_OPEN=true; } loadTeam(); },function(e){ toast(Api.errText(e)); });
    });
  },
  switchShop:function(){
    openSheet('<h3>ປ່ຽນຮ້ານ</h3>'+CTX.shops.map(function(x){ return '<button class="brow" data-act="pickShop" data-id="'+esc(x.id)+'"><span class="tt"><b>'+esc(x.name)+'</b><small>'+esc(ROLE_LAO[x.role]||x.role)+'</small></span></button>'; }).join('')+'<button class="btn ghost block" data-act="closeSheet">ປິດ</button>');
  },
  pickShop:function(el){ try{ localStorage.setItem('pos.shop',el.dataset.id); }catch(e){} location.reload(); },
  logout:function(){ Api.signOut().then(function(){ try{ localStorage.removeItem('pos.shop'); }catch(e){} nav('login.html'); },function(){ nav('login.html'); }); },

  range:function(el){ S.repRange=el.dataset.v; S.repLimit=40; watchRep(); render(); },
  more:function(){ S.repLimit+=40; render(); },
  showBill:function(el){
    var r=rangeDays(S.repRange), b=billsInRange(r[0],r[1]).find(function(x){ return x.id===el.dataset.id; });
    if(b) billSheet(b,true);
  },
  copyBill:function(){ if(SHOWN) copyText(billText(SHOWN)); },
  voidBill:function(){
    var b=SHOWN; if(!b) return;
    ask('ຍົກເລີກບິນ '+b.no+'?','ບິນນີ້ຈະບໍ່ຖືກນັບໃນຍອດຂາຍ','ຍົກເລີກບິນ',true).then(function(y){
      if(!y) return;
      var key=b._shard, doc=clone(S.salesDocs[key]); if(!doc) return;
      var k=doc.bills.findIndex(function(x){ return x.id===b.id; }); if(k<0) return;
      doc.bills[k].void=true; doc.bills[k].voidAt=Date.now();
      S.salesDocs[key]=doc; S.shardLW[key]=Date.now();
      enqueue('sales/'+key,function(){ return Store.set('sales',key,doc,doc.day); });
      closeSheet(); toast('ຍົກເລີກບິນແລ້ວ'); render();
    });
  },

  qrPick:function(){ var f=$('#qrFile'); if(f) f.click(); },
  qrClear:function(){ saveSettings({qr:''}); },
  clearSales:function(){
    ask('ລຶບປະຫວັດການຂາຍທັງໝົດ?','ບິນທີ່ຊຳລະແລ້ວທັງໝົດຈະຖືກລຶບ ແລະ ກູ້ຄືນບໍ່ໄດ້','ລຶບທັງໝົດ',true).then(function(y){
      if(!y) return;
      Store.clearColl('sales').then(function(){ S.salesDocs={}; S.shardLW={}; toast('ລຶບແລ້ວ'); render(); },function(){ toast('ລຶບບໍ່ສຳເລັດ'); });
    });
  }
};
var DISC_T='a';
function sortMenu(a,b){ return (a.sort||0)-(b.sort||0) || String(a.name).localeCompare(String(b.name)); }
var SAMPLE=[
  ['ອາຫານ',[['ຕຳໝາກຫຸ່ງ',25000],['ລາບໄກ່',35000],['ລາບໝູ',35000],['ປີ້ງໄກ່ ເຄິ່ງໂຕ',55000],['ເຝີ',30000],['ເຂົ້າຜັດ',28000],['ຕົ້ມຢຳກຸ້ງ',50000],['ເຂົ້າໜຽວ',5000]]],
  ['ເຄື່ອງດື່ມ',[['ນ້ຳດື່ມ',5000],['ເບຍລາວ',18000],['ນ້ຳອັດລົມ',8000],['ນ້ຳໝາກນາວປັ່ນ',15000]]],
  ['ຄາເຟ່',[['ເອສເປຣສໂຊ',18000],['ອາເມລິກາໂນ',20000],['ລາເຕ້',28000],['ຄາປູຊິໂນ',28000],['ຊາຂຽວເຢັນ',25000]]],
  ['ຂອງຫວານ',[['ເຄັກຊັອກໂກແລັດ',30000],['ໄອສະຄຣີມ',15000]]]
];

var MUT={add:1,dec:1,linc:1,ldec:1,noteSave:1,discSave:1,discClear:1,cancelOrder:1,payDone:1,menuSave:1,menuDel:1,toggle:1,sample:1,inboxOk:1,inboxNo:1,voidBill:1,clearSales:1,qrClear:1,toggleQrOrder:1,invite:1,rmMember:1};
document.addEventListener('click',function(e){
  if(!beepCtx) unlockAudio();
  var el=e.target.closest('[data-act]'); if(!el) return;
  if(el.classList.contains('scrim') && e.target!==el) return;
  if(CTX.readOnly && MUT[el.dataset.act]){ toast('ໝົດອາຍຸໃຊ້ງານ ແກ້ໄຂບໍ່ໄດ້'); return; }
  var f=H[el.dataset.act]; if(f) f(el,e);
});
document.addEventListener('keydown',function(e){
  if((e.key==='Enter'||e.key===' ') && e.target.getAttribute && e.target.getAttribute('role')==='button' && e.target.dataset.act){ e.preventDefault(); e.target.click(); }
});
document.addEventListener('input',function(e){
  if(e.target.id==='payAmt' && PAY){ PAY.amt=e.target.value; payPreview(); }
});
document.addEventListener('change',function(e){
  var t=e.target;
  if(t.id==='qrFile'){ onQr(t); return; }
  var k=t.dataset && t.dataset.set; if(!k) return;
  var v=t.value, d=S.settings, p={};
  if(k==='shop') p.shop=v.trim()||d.shop;
  else if(k==='tables') p.tables=Math.max(1,Math.min(60,Math.round(num(v))||d.tables));
  else if(k==='svc'||k==='vat') p[k]=Math.max(0,Math.min(100,num(v)));
  else p[k]=num(v)>0?num(v):d[k];
  saveSettings(p);
});
function onQr(input){
  var f=input.files && input.files[0]; if(!f) return;
  var rd=new FileReader();
  rd.onerror=function(){ toast('ອ່ານຮູບບໍ່ໄດ້'); };
  rd.onload=function(){
    var img=new Image();
    img.onerror=function(){ toast('ໄຟລ໌ນີ້ບໍ່ແມ່ນຮູບ'); };
    img.onload=function(){
      var max=640, sc=Math.min(1,max/Math.max(img.width,img.height)), c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(img.width*sc)); c.height=Math.max(1,Math.round(img.height*sc));
      var cx=c.getContext('2d'); cx.fillStyle='#fff'; cx.fillRect(0,0,c.width,c.height); cx.drawImage(img,0,0,c.width,c.height);
      var url=c.toDataURL('image/png');
      if(url.length>180000) url=c.toDataURL('image/jpeg',0.9);
      if(url.length>200000){ toast('ຮູບໃຫຍ່ເກີນໄປ ລອງຮູບທີ່ນ້ອຍກວ່າ'); return; }
      saveSettings({qr:url}); toast('ບັນທຶກ QR ແລ້ວ');
    };
    img.src=rd.result;
  };
  rd.readAsDataURL(f);
}

/* ============ start ============ */
function tick(){
  if(canSales()) watchToday();
  if(!S.cur && (S.tab==='tables'||S.tab==='kitchen') && !sheetOpen()) render(); else renderTop();
}
function applyShop(sh){
  CTX.shop=sh; CTX.role=sh.role; CTX.readOnly=!shopState(sh).active;
  titleBase=sh.name||titleBase; setTitle();
}
function nav(u){ if(window.__nav) window.__nav(u); else location.replace(u); }
function fatal(msg){
  $('#tabs').hidden=true;
  $('#view').innerHTML='<div class="empty card" style="margin-top:30px"><b>'+esc(msg)+'</b><div style="margin-top:14px"><a class="btn ghost" href="login.html">ໄປໜ້າເຂົ້າສູ່ລະບົບ</a></div></div>';
}
function refreshShop(){
  Api.myShops().then(function(list){
    var sh=list.filter(function(x){ return x.id===CTX.shop.id; })[0];
    if(!sh){ toast('ບັນຊີຖືກລຶບອອກຈາກຮ້ານນີ້'); setTimeout(function(){ nav('login.html'); },1500); return; }
    var was=CTX.readOnly, role=CTX.role; CTX.shops=list; applyShop(sh);
    if(role!==CTX.role) location.reload(); else if(was!==CTX.readOnly) render(); else renderTop();
  },function(){});
}
function startData(){
  Store.start(CTX.shop.id);
  var onErr=function(){ S.slow=true; render(); };
  Store.watchColl('settings',null,function(rows){
    var m=rows.find(function(r){ return r.id==='main'; }); if(m) delete m.id;
    S.settings=Object.assign({},DEFAULTS,m||{}); done('settings'); render();
  },onErr);
  Store.watchColl('menu',null,function(rows){ S.menu=rows.sort(sortMenu); done('menu'); render(); },onErr);
  Store.watchColl('orders',null,function(rows){ mergeOrders(rows); done('orders'); render(); },onErr);
  if(canSales()) watchToday(); else S.loaded.sales=true;
  if(CTX.role!=='kitchen') Store.watchColl('inbox',null,onInbox,function(){});
  setTimeout(function(){ if(!S.ready){ S.ready=true; S.slow=true; render(); } },10000);
  setInterval(tick,30000);
  setInterval(refreshShop,120000);
}
function boot(){
  render();
  if(!Api.configured()){ fatal('ຍັງບໍ່ໄດ້ຕັ້ງຄ່າເຊີບເວີ (ເບິ່ງ config.js)'); return; }
  Api.session().then(function(sess){
    if(!sess){ nav('login.html'); return null; }
    CTX.user={id:sess.user.id,email:sess.user.email};
    return Api.myShops().then(function(list){
      if(!list.length){ nav('login.html?need=shop'); return; }
      CTX.shops=list;
      var want=null; try{ want=localStorage.getItem('pos.shop'); }catch(e){}
      applyShop(list.filter(function(x){ return x.id===want; })[0] || list[0]);
      S.tab = tabList()[0][0];
      render(); startData();
    });
  }).then(null,function(e){ fatal(Api.errText(e)); });
}
window.__pos={S:S,H:H,CTX:CTX,calc:calc,toLak:toLak,fromLak:fromLak,payState:payState,summarize:summarize,Store:Store,getCur:getCur,totals:totals,shopState:shopState,tick:tick,refreshShop:refreshShop};
boot();
})();
