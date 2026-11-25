/* api.js — the ONLY file that talks to Supabase. Every page uses window.Api. */
(function () {
  'use strict';
  var C = window.APP_CONFIG || {};
  var sb = null;

  function configured() { return !!(C.supabaseUrl && C.supabaseKey && window.supabase && window.supabase.createClient); }
  function client() {
    if (!sb) {
      sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 10 } }
      });
    }
    return sb;
  }
  function unwrap(res) {
    if (res && res.error) {
      var e = new Error(res.error.message || 'error');
      e.code = res.error.code || '';
      throw e;
    }
    return res ? res.data : null;
  }

  /* phone number or email -> the e-mail address Supabase uses to sign in */
  function loginEmail(login) {
    var s = String(login || '').trim().toLowerCase();
    if (s.indexOf('@') >= 0) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
    var d = s.replace(/\D/g, '');
    if (d.indexOf('856') === 0 && d.length >= 11) d = d.slice(3);
    if (d.charAt(0) === '0') d = d.slice(1);
    if (d.length < 7 || d.length > 14) return '';
    return d + '@' + (C.phoneDomain || 'phone.example.com');
  }

  var MSG = {
    not_authenticated: 'ກະລຸນາເຂົ້າສູ່ລະບົບກ່ອນ',
    slug_taken: 'ຊື່ລິ້ງນີ້ມີຄົນໃຊ້ແລ້ວ ລອງຊື່ອື່ນ',
    bad_input: 'ຂໍ້ມູນບໍ່ຖືກຕ້ອງ (ຊື່ລິ້ງໃຊ້ໄດ້ແຕ່ a-z 0-9 ແລະ - ຍາວ 3-30 ຕົວ)',
    too_many_shops: 'ສ້າງຮ້ານໄດ້ສູງສຸດ 3 ຮ້ານຕໍ່ບັນຊີ',
    invalid_code: 'ລະຫັດເຊີນບໍ່ຖືກ ຫຼື ໝົດອາຍຸ ຫຼື ຖືກໃຊ້ແລ້ວ',
    already_member: 'ບັນຊີນີ້ຢູ່ໃນຮ້ານນີ້ແລ້ວ',
    member_limit: 'ແພັກເກດຂອງຮ້ານເຕັມຈຳນວນຜູ້ໃຊ້ແລ້ວ ຕ້ອງອັບເກຣດແພັກເກດ',
    forbidden: 'ບໍ່ມີສິດເຮັດລາຍການນີ້',
    bad_role: 'ຕຳແໜ່ງບໍ່ຖືກຕ້ອງ',
    'User already registered': 'ເບີ/ອີເມວນີ້ສະໝັກແລ້ວ ໃຫ້ກົດ “ເຂົ້າສູ່ລະບົບ”',
    'Invalid login credentials': 'ເບີ/ອີເມວ ຫຼື ລະຫັດຜ່ານບໍ່ຖືກ',
    confirm_email_on: 'ເຊີບເວີຍັງເປີດ “Confirm email” ຢູ່ ເຈົ້າຂອງລະບົບຕ້ອງປິດໃນ Supabase ກ່ອນ',
    not_configured: 'ຍັງບໍ່ໄດ້ຕັ້ງຄ່າເຊີບເວີ (config.js)'
  };
  function errText(e) {
    var m = String((e && e.message) || e || '');
    if (MSG[m]) return MSG[m];
    var k = Object.keys(MSG).filter(function (x) { return m.indexOf(x) >= 0; })[0];
    if (k) return MSG[k];
    if (/Password should be at least|weak_password/i.test(m)) return 'ລະຫັດຜ່ານສັ້ນເກີນໄປ (ຢ່າງໜ້ອຍ 6 ຕົວ)';
    if (/invalid.*email|email.*invalid|email_address_invalid/i.test(m)) return 'ເຊີບເວີບໍ່ຮັບເບີນີ້ (ອີເມວຈຳລອງບໍ່ຜ່ານ) ລອງສະໝັກດ້ວຍອີເມວແທນ';
    if (/rate limit|too many/i.test(m)) return 'ລອງຫຼາຍເກີນໄປ ລໍຖ້າສັກຄູ່ແລ້ວລອງໃໝ່';
    if (/fetch|network|Failed to/i.test(m)) return 'ເຊື່ອມຕໍ່ອິນເຕີເນັດບໍ່ໄດ້';
    return m || 'ມີບັນຫາ ລອງໃໝ່';
  }

  var Api = {
    configured: configured,
    loginEmail: loginEmail,
    errText: errText,

    /* ---- sign in ---- */
    session: function () {
      return client().auth.getSession().then(function (r) { var s = unwrap(r); return s && s.session ? s.session : null; });
    },
    signUp: function (login, pass) {
      var email = loginEmail(login);
      if (!email) return Promise.reject(new Error('ເບີໂທ ຫຼື ອີເມວບໍ່ຖືກຕ້ອງ'));
      return client().auth.signUp({ email: email, password: pass }).then(function (r) {
        var d = unwrap(r);
        if (!d || !d.session) throw new Error('confirm_email_on');
        return d.session;
      });
    },
    signIn: function (login, pass) {
      var email = loginEmail(login);
      if (!email) return Promise.reject(new Error('ເບີໂທ ຫຼື ອີເມວບໍ່ຖືກຕ້ອງ'));
      return client().auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
        var d = unwrap(r); return d.session;
      });
    },
    signOut: function () { return client().auth.signOut().then(function () { return null; }); },

    /* ---- shops I belong to ---- */
    myShops: function () {
      var c = client();
      // owners/managers can read every member row of their shop, so always filter to my own rows
      return c.auth.getSession().then(function (sr) {
        var ss = unwrap(sr); var uid = ss && ss.session && ss.session.user ? ss.session.user.id : null;
        if (!uid) return { data: [], error: null };
        return c.from('shop_members').select('shop_id,role,display_name').eq('user_id', uid);
      }).then(function (r) {
        var mem = unwrap(r) || [];
        if (!mem.length) return [];
        var ids = mem.map(function (m) { return m.shop_id; });
        return c.from('shops').select('id,slug,name,plan,status,trial_ends_at,paid_until').in('id', ids).then(function (r2) {
          var shops = unwrap(r2) || [], by = {};
          shops.forEach(function (s) { by[s.id] = s; });
          return mem.filter(function (m) { return by[m.shop_id]; }).map(function (m) {
            return Object.assign({}, by[m.shop_id], { role: m.role, display_name: m.display_name });
          });
        });
      });
    },
    renameShop: function (shopId, name) {
      return client().from('shops').update({ name: name }).eq('id', shopId).then(unwrap);
    },

    /* ---- functions that run on the server ---- */
    rpc: function (name, args) { return client().rpc(name, args || {}).then(unwrap); },

    /* ---- shop data (the "docs" table) ---- */
    docsSelect: function (shopId, coll, filter) {
      var c = client(), out = [], PAGE = 1000;
      function page(from) {
        var q = c.from('docs').select('id,day,data').eq('shop_id', shopId).eq('coll', coll);
        if (filter) q = q.gte('day', filter.gte).lte('day', filter.lte);
        return q.order('id', { ascending: true }).range(from, from + PAGE - 1).then(function (r) {
          var rows = unwrap(r) || [];
          out = out.concat(rows);
          if (rows.length === PAGE) return page(from + PAGE);
          return out;
        });
      }
      return page(0);
    },
    docUpsert: function (shopId, coll, id, day, data) {
      return client().from('docs').upsert({ shop_id: shopId, coll: coll, id: id, day: day || null, data: data }, { onConflict: 'shop_id,coll,id' }).then(unwrap);
    },
    docDelete: function (shopId, coll, id) {
      return client().from('docs').delete().eq('shop_id', shopId).eq('coll', coll).eq('id', id).then(unwrap);
    },
    docsClear: function (shopId, coll) {
      return client().from('docs').delete().eq('shop_id', shopId).eq('coll', coll).then(unwrap);
    },

    /* live updates: onEvent({type, coll, id, day, data}) ; returns {close()} */
    subscribe: function (shopId, onEvent, onStatus) {
      var c = client();
      var ch = c.channel('docs-' + shopId + '-' + Math.random().toString(36).slice(2, 7))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'shop_id=eq.' + shopId }, function (p) {
          var rec = p.eventType === 'DELETE' ? p.old : p.new;
          if (!rec || !rec.coll) return;
          onEvent({ type: p.eventType, coll: rec.coll, id: rec.id, day: rec.day || null, data: p.eventType === 'DELETE' ? null : rec.data });
        })
        .subscribe(function (status) { if (onStatus) onStatus(status); });
      return { close: function () { try { c.removeChannel(ch); } catch (e) {} } };
    }
  };

  window.Api = Api;
})();
