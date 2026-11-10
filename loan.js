/* ======================================================================
   Wifaq — Mortgage Loan Tracker  (loan.js)
   ----------------------------------------------------------------------
   Loaded by index.html after the main script, so it can reuse the app's
   own Auth (Worker-backed Google sign-in), gfetch, GSheets/GDrive helpers,
   modal, toast and i18n. Nothing here changes the building-expenses data.

   STORAGE
   - Google Sheets is the source of truth. Your EXISTING ledger tab
     (A: Month - Year, B: Evidence link, C: Amount) is extended IN PLACE:
     columns D:E (your own totals) are never touched; the app keeps its
     bookkeeping (payment ID, status, dates, receipt IDs, version...) in
     columns G:X of the same rows. Rows are found by payment ID, never by
     row number. Loan terms live in a "Loan Details" tab, sync metadata in
     "Loan Metadata", extra documents in "Loan Documents".
   - Google Drive holds the receipts, inside the folder you pick (e.g.
     "Dept"), as <year>/<month>/<receipt>. Existing receipts are never
     moved, renamed or deleted. Receipt links stay private (no sharing).
   - localStorage is only a cache + a queue of unsent changes.

   SAFETY RULES (enforced in code, covered by tests)
   - A failed/empty read is never treated as "no data".
   - Writes touch only the intended record, located by ID, and are
     idempotent (retrying cannot duplicate a payment).
   - Every write is preceded by a hash check against what is currently in
     the sheet; a mismatch becomes a conflict you decide, never an overwrite.
   - Deleting a row only clears this app's cells (A:C, G:X) - never shifts
     rows, so your D:E totals can't be damaged.
   ====================================================================== */

const LOAN_SCHEMA = 1;
const LOAN_CACHE_KEY = 'bsst_loan_v1';
const LOAN_QUEUE_KEY = 'bsst_loan_queue_v1';
const LOAN_BACKUP_KEY = 'bsst_loan_backups_v1';
const LOAN_THEME_KEY = 'bsst_theme_v1';
const LOAN_TAB = {details:'Loan Details', meta:'Loan Metadata', docs:'Loan Documents', link:'Loan Link'};
const LOAN_STATUSES = ['paid','partial','pending','overdue','cancelled'];
const LOAN_MAX_ROWS = 3000;
const LOAN_FILE_MAX = 15*1024*1024;
const LOAN_FOLDER_MIME = 'application/vnd.google-apps.folder';
const LOAN_APP_HEAD = ['Payment ID','Loan ID','Type','Due Date','Payment Date','Amount Due','Status','Principal Portion','Interest or Profit Portion','Fees','Transaction Reference','Receipt File ID','Receipt Filename','Receipt Link','Notes','Created At','Updated At','Version'];
const LOAN_DETAIL_HEAD = ['Loan ID','Loan Name','Original Loan Amount','Currency','Loan Start Date','First Installment Date','Monthly Installment','Payment Frequency','Interest or Profit Rate','Interest Calculation Method','Loan Term (Months)','Expected End Date','Additional Fees or Insurance','Notes','Created At','Updated At','Record Version'];
const LOAN_DOC_HEAD = ['Document ID','Drive File ID','File Name','Type','Size (bytes)','Uploaded At','Link','Notes'];

/* ---------- small pure helpers ---------- */
const LU = {
  num(v){ if(v===''||v==null) return null; const n = typeof v==='number' ? v : parseFloat(String(v).replace(/[,\s]/g,'')); return Number.isFinite(n) ? n : null; },
  // Money is handled as integer halalas (cents) so sums never drift.
  toCents(v){ const n = this.num(v); return n==null ? 0 : Math.round((n + Number.EPSILON)*100); },
  fmtNum(c){ return (c/100).toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2}); },
  fmt(c, cur){
    const n = this.fmtNum(c); cur = cur || 'SAR';
    if(cur==='SAR') return (typeof Lang!=='undefined' && Lang.cur==='ar') ? n+' ر.س' : 'SAR '+n;
    return n+' '+cur;
  },
  pad(n){ return String(n).padStart(2,'0'); },
  today(){ const d=new Date(); return d.getFullYear()+'-'+this.pad(d.getMonth()+1)+'-'+this.pad(d.getDate()); },
  nowISO(){ return new Date().toISOString(); },
  addMonths(period, n){ const [y,m]=period.split('-').map(Number); const t=y*12+(m-1)+n; return Math.floor(t/12)+'-'+this.pad(t%12+1); },
  daysIn(y,m){ return new Date(y,m,0).getDate(); },
  dueDate(period, day){ const [y,m]=period.split('-').map(Number); return period+'-'+this.pad(Math.min(Math.max(1,day||1), this.daysIn(y,m))); },
  periodLabel(period){ const [y,m]=period.split('-'); return m+' - '+y; },   // the format your sheet already uses
  parsePeriodLabel(txt){
    const s = String(txt||'').trim(); let m = s.match(/^(\d{1,2})\s*[-\/.]\s*(\d{4})$/);
    let y, mo; if(m){ mo=+m[1]; y=m[2]; } else { m = s.match(/^(\d{4})\s*[-\/.]\s*(\d{1,2})$/); if(m){ y=m[1]; mo=+m[2]; } }
    return (y && mo>=1 && mo<=12) ? y+'-'+this.pad(mo) : '';
  },
  normDate(s){
    s = String(s||'').trim(); if(!s) return '';
    if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    const d = new Date(s); return isNaN(d) ? '' : d.getFullYear()+'-'+this.pad(d.getMonth()+1)+'-'+this.pad(d.getDate());
  },
  driveId(url){
    const u = String(url||''); let m = u.match(/\/d\/([A-Za-z0-9_-]{10,})/) || u.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || u.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : '';
  },
  // Leading apostrophe makes Sheets keep a value as text (no auto date/number/formula parsing).
  txt(s){ return (s===''||s==null) ? '' : "'"+s; },
  untxt(s){ return String(s||'').replace(/^'/,''); },
  blankNum(v){ const n = this.num(v); return n==null ? '' : n; },
  newId(period){ return 'pay_'+(period||'x')+'_'+Math.random().toString(36).slice(2,8); },
  hash(p){
    const c = v => (v===''||v==null) ? '' : LU.toCents(v);
    return [p.period||'', p.type||'installment', c(p.amountPaid), c(p.amountDue), p.status||'', p.receiptFileId||'', p.receiptLink||'',
      p.dueDate||'', p.paymentDate||'', String(p.reference||'').trim(), String(p.notes||'').trim(), c(p.principal), c(p.interest), c(p.fees)].join('|');
  },
  hashLoan(l){
    if(!l) return '';
    return [l.name||'', LU.toCents(l.originalAmount), l.currency||'', l.startDate||'', l.firstInstallmentDate||'', LU.toCents(l.monthlyInstallment),
      l.frequency||'', l.rate===''||l.rate==null?'':Number(l.rate), l.method||'', Number(l.termMonths)||0, l.expectedEndDate||'', LU.toCents(l.extraFees), String(l.notes||'').trim()].join('|');
  },
  clamp(v,a,b){ return Math.min(b, Math.max(a, v)); },
  uid8(){ return Math.random().toString(36).slice(2,10); },
};

/* ======================================================================
   CALCULATIONS — one place, used by dashboard, history and analytics
   ====================================================================== */
const LoanCalc = {
  isConfirmed(p){ return (p.status==='paid' || p.status==='partial') && LU.toCents(p.amountPaid) > 0; },
  effDate(p){ return p.paymentDate || p.dueDate || (p.period ? p.period+'-01' : ''); },

  compute(loan, payments, opts){
    opts = opts || {};
    const today = opts.today || LU.today();
    const curP = today.slice(0,7);
    const orig = LU.toCents(loan.originalAmount);
    const monthly = LU.toCents(loan.monthlyInstallment);
    const term = Number(loan.termMonths) || 0;
    const confirmed = payments.filter(p=>this.isConfirmed(p));
    const totalPaid = confirmed.reduce((a,p)=>a+LU.toCents(p.amountPaid),0);

    // ---- balance model -------------------------------------------------
    // A: no interest rate and no breakdown -> every payment is assumed to reduce principal (labelled estimate)
    // B: a rate or per-payment principal amounts exist -> only the known principal portions reduce the balance
    const hasRate = Number(loan.rate) > 0;
    const known = confirmed.filter(p=>p.principal!=='' && p.principal!=null && Number.isFinite(Number(p.principal)));
    const mode = (opts.calcMode==='simple' || !(known.length>0 || hasRate)) ? 'A' : 'B';
    let principalRepaid, unallocated = 0;
    if(mode==='A') principalRepaid = totalPaid;
    else { principalRepaid = known.reduce((a,p)=>a+LU.toCents(p.principal),0); unallocated = confirmed.length - known.length; }
    const remaining = Math.max(0, orig - principalRepaid);
    const progress = orig>0 ? LU.clamp(principalRepaid*100/orig, 0, 100) : 0;
    const complete = orig>0 && remaining===0;

    // ---- installment schedule -------------------------------------------
    const insts = payments.filter(p=>p.type!=='extra');
    const firstP = (loan.firstInstallmentDate||'').slice(0,7) || insts.map(p=>p.period).filter(Boolean).sort()[0] || '';
    const dueDay = loan.firstInstallmentDate ? (Number(loan.firstInstallmentDate.slice(8,10)) || 1) : 1;
    const lastRec = insts.map(p=>p.period).filter(Boolean).sort().pop() || '';
    const periods = [];
    if(firstP){
      let endP = LU.addMonths([curP,lastRec].sort().pop(), 1);        // always show at least one future period
      if(term){ const termEnd = LU.addMonths(firstP, term-1); if(endP > termEnd) endP = termEnd; }
      for(let p=firstP, i=0; p<=endP && i<1200; p=LU.addMonths(p,1), i++){
        const recs = insts.filter(r=>r.period===p);
        const active = recs.filter(r=>r.status!=='cancelled');
        const dueRec = active.find(r=>LU.toCents(r.amountDue)>0);
        const dueC = dueRec ? LU.toCents(dueRec.amountDue) : monthly;     // history keeps its own amounts
        const credited = active.filter(r=>this.isConfirmed(r)).reduce((a,r)=>a+LU.toCents(r.amountPaid),0);
        const dueDate = (dueRec && dueRec.dueDate) || LU.dueDate(p, dueDay);
        let status;
        if(recs.length && !active.length) status = 'cancelled';
        else if(credited>0 && (dueC===0 || credited>=dueC)) status = 'paid';
        else if(credited>0) status = 'partial';
        else status = dueDate < today ? 'overdue' : 'pending';
        periods.push({period:p, dueDate, dueC, credited, remainingDue: Math.max(0, dueC-credited), status, late: status!=='paid' && status!=='cancelled' && dueDate<today, recs:recs.length});
      }
    }
    const installmentsPaid = periods.filter(x=>x.status==='paid').length;
    const overdue = periods.filter(x=>x.status==='overdue');
    const partial = periods.filter(x=>x.status==='partial');
    const outstanding = overdue.length + partial.length;
    const next = complete ? null : (periods.find(x=>x.status==='pending'||x.status==='overdue'||x.status==='partial') || null);

    // ---- remaining installments / payoff (clearly estimates unless a term is set) ----
    let remainingInstallments = null, remainingEstimated = true, payoffDate = '';
    if(complete){ remainingInstallments = 0; remainingEstimated = false; }
    else if(term && firstP){ remainingInstallments = Math.max(0, term - installmentsPaid); remainingEstimated = false; }
    else if(monthly>0){ remainingInstallments = Math.ceil(remaining/monthly); }
    if(!complete && remainingInstallments>0 && next){
      payoffDate = LU.dueDate(LU.addMonths(next.period, remainingInstallments-1), dueDay);
    }
    if(!complete && loan.expectedEndDate && !payoffDate) payoffDate = loan.expectedEndDate;

    // ---- period / year totals & series ---------------------------------
    const byMonth = {}, byYear = {}, principalByMonth = {};
    confirmed.forEach(p=>{
      const d = this.effDate(p); if(!d) return;
      const c = LU.toCents(p.amountPaid);
      byMonth[d.slice(0,7)] = (byMonth[d.slice(0,7)]||0) + c;
      byYear[d.slice(0,4)] = (byYear[d.slice(0,4)]||0) + c;
      const pr = mode==='A' ? c : (known.includes(p) ? LU.toCents(p.principal) : 0);
      principalByMonth[d.slice(0,7)] = (principalByMonth[d.slice(0,7)]||0) + pr;
    });
    const recent = confirmed.slice().sort((a,b)=> (this.effDate(b)+b.period).localeCompare(this.effDate(a)+a.period)).slice(0,5);
    const missingReceipts = confirmed.filter(p=>!p.receiptFileId && !p.receiptLink);

    return {
      cur: loan.currency||'SAR', orig, monthly, term, mode, calcMode: opts.calcMode||'auto',
      totalPaid, principalRepaid, unallocated, remaining, progress, complete, confirmedCount: confirmed.length,
      periods, installmentsPaid, overdue, partial, outstanding, next, remainingInstallments, remainingEstimated, payoffDate,
      thisMonth: byMonth[curP]||0, thisYear: byYear[today.slice(0,4)]||0, byMonth, byYear, principalByMonth,
      recent, missingReceipts, dueDay, firstP
    };
  },
};

/* ======================================================================
   GOOGLE SHEETS — ledger / loan / docs / metadata
   ====================================================================== */
const LoanSheet = {
  base(id){ return 'https://sheets.googleapis.com/v4/spreadsheets/'+id; },
  isMissingTab(e){ return /Unable to parse range|Requested entity was not found|not found/i.test((e&&e.message)||''); },

  async tabs(id){
    const r = await gfetch(this.base(id)+'?fields=sheets.properties(title,sheetId,gridProperties)', {headers:Auth.authHeaders()});
    return (r.sheets||[]).map(s=>({title:s.properties.title, sheetId:s.properties.sheetId, rows:(s.properties.gridProperties||{}).rowCount||0, cols:(s.properties.gridProperties||{}).columnCount||0}));
  },
  async ensureTabs(cfg){
    const tabs = await this.tabs(cfg.spreadsheetId);
    const missing = [LOAN_TAB.details, LOAN_TAB.meta, LOAN_TAB.docs].filter(n=>!tabs.some(t=>t.title===n));
    if(missing.length){
      await gfetch(this.base(cfg.spreadsheetId)+':batchUpdate', {method:'POST', headers:{...Auth.authHeaders(),'Content-Type':'application/json'},
        body: JSON.stringify({requests: missing.map(title=>({addSheet:{properties:{title}}}))})});
    }
    return missing;
  },
  // Finds the tab that holds the existing ledger ("Month - Year" in A1) without changing anything.
  async inspect(id){
    const tabs = await this.tabs(id);
    const own = Object.values(LOAN_TAB);
    let ledger = null;
    for(const t of tabs){
      if(own.includes(t.title)) continue;
      try{ const v = await GSheets.getValues(id, rng(t.title,'A1:E1')); if(/month/i.test((v[0]||[])[0]||'')){ ledger = t.title; break; } }catch(e){}
    }
    if(!ledger){ const first = tabs.find(t=>!own.includes(t.title)); ledger = first ? first.title : ''; }
    let d2e2 = [null,null];
    if(ledger){ try{ const v = await GSheets.getValues(id, rng(ledger,'D2:E2')); d2e2 = [LU.num((v[0]||[])[0]), LU.num((v[0]||[])[1])]; }catch(e){} }
    return {tabs, ledgerTab: ledger, d2e2, hasLoanTab: tabs.some(t=>t.title===LOAN_TAB.details)};
  },
  async ensureHeaders(cfg){
    const v = await GSheets.getValues(cfg.spreadsheetId, rng(cfg.ledgerTab,'G1:X1'));
    const row = v[0] || [];
    if(!row.some(x=>x)){ await GSheets.batchUpdateValues(cfg.spreadsheetId, [{range:rng(cfg.ledgerTab,'G1:X1'), values:[LOAN_APP_HEAD]}]); return 'written'; }
    if(row[0]==='Payment ID') return 'ok';
    throw new Error('ledger_headers_conflict');   // something else lives in G1:X1 — never overwrite it
  },
  async ensureGrid(cfg, led, neededRow){
    const g = led.gridProps || {}; const reqs = [];
    if((g.columnCount||0) < 24) reqs.push({appendDimension:{sheetId:led.sheetId, dimension:'COLUMNS', length:24-(g.columnCount||0)}});
    if((g.rowCount||0) < neededRow+2) reqs.push({appendDimension:{sheetId:led.sheetId, dimension:'ROWS', length:Math.max(50, neededRow+50-(g.rowCount||0))}});
    if(reqs.length) await gfetch(this.base(cfg.spreadsheetId)+':batchUpdate', {method:'POST', headers:{...Auth.authHeaders(),'Content-Type':'application/json'}, body:JSON.stringify({requests:reqs})});
  },

  /* ----- ledger read ----- */
  async readLedger(cfg){
    const fields = 'sheets(properties(title,sheetId,gridProperties),data(startRow,rowData(values(formattedValue,effectiveValue,hyperlink))))';
    const url = this.base(cfg.spreadsheetId)+'?includeGridData=true&ranges='+encodeURIComponent(rng(cfg.ledgerTab,'A1:X'+LOAN_MAX_ROWS))+'&fields='+encodeURIComponent(fields);
    const r = await gfetch(url, {headers:Auth.authHeaders()});
    const sh = (r.sheets||[])[0];
    if(!sh || !sh.properties) throw new Error('ledger_tab_not_found');
    const data = (sh.data||[])[0] || {}; const start = data.startRow||0;
    const rows = []; let header = null;
    (data.rowData||[]).forEach((rd,i)=>{
      const rowNo = start+i+1, cells = rd.values||[];
      const cell = k => cells[k] || {};
      const text = k => LU.untxt(cell(k).formattedValue || '');
      const numv = k => { const e = cell(k).effectiveValue; return e && typeof e.numberValue==='number' ? e.numberValue : null; };
      if(rowNo===1){ header = {a:text(0), app:Array.from({length:18},(_,j)=>text(6+j))}; return; }
      const app = Array.from({length:18},(_,j)=>({s:text(6+j), n:numv(6+j)}));
      const o = {row:rowNo, a:text(0), b:{text:text(1), link:cell(1).hyperlink||''}, c:{n:numv(2), s:text(2)}, app};
      o.used = !!(o.a || o.b.text || o.b.link || o.c.s || app[0].s);
      if(o.used) rows.push(o);
    });
    return {rows, header, gridProps:sh.properties.gridProperties, sheetId:sh.properties.sheetId};
  },
  toRecord(o, d){
    const A = o.app;
    const dueN = LU.normDate(A[3].s);
    const period = LU.parsePeriodLabel(o.a) || (dueN ? dueN.slice(0,7) : '');
    const amountPaid = o.c.n!=null ? o.c.n : (LU.num(o.c.s) ?? 0);
    const rec = {
      id:A[0].s, loanId:A[1].s || d.loanId, period, type:(A[2].s==='extra'?'extra':'installment'),
      dueDate:dueN, paymentDate:LU.normDate(A[4].s), amountDue:A[5].n, amountPaid,
      status: LOAN_STATUSES.includes(A[6].s) ? A[6].s : (amountPaid>0 ? 'paid' : 'pending'),
      principal:A[7].n!=null?A[7].n:'', interest:A[8].n!=null?A[8].n:'', fees:A[9].n!=null?A[9].n:'',
      reference:A[10].s, receiptFileId:A[11].s, receiptName:A[12].s, receiptLink:A[13].s,
      notes:A[14].s, createdAt:A[15].s, updatedAt:A[16].s, version:A[17].n!=null?A[17].n:1, _row:o.row
    };
    // The visible Evidence cell wins when it has a link (so a link edited directly in Sheets is honoured).
    // An empty Evidence cell never erases a receipt the app already knows about.
    if(o.b.link && o.b.link!==rec.receiptLink){
      rec.receiptLink = o.b.link; const fid = LU.driveId(o.b.link); if(fid) rec.receiptFileId = fid;
      if(!rec.receiptName) rec.receiptName = o.b.text || '';
    }
    return rec;
  },
  // d = {loanId, dueDay, monthly}. Rows that already have an ID are left exactly as they are.
  parse(cfg, led, d){
    const records = [], needIds = []; let skipped = 0;
    const used = new Set(); led.rows.forEach(o=>{ if(o.app[0].s) used.add(o.app[0].s); });
    led.rows.forEach(o=>{
      const rec = this.toRecord(o, d);
      if(!rec.id){
        if(!rec.period){ if(o.a || o.c.s || o.b.link) skipped++; return; }
        let n = 1, id; while(used.has(id = 'pay_'+rec.period+'_'+n)) n++;     // deterministic: same on every device
        used.add(id); rec.id = id; rec.loanId = d.loanId;
        if(rec.amountDue==null) rec.amountDue = rec.amountPaid>0 ? rec.amountPaid : (d.monthly||0);
        if(!rec.dueDate) rec.dueDate = LU.dueDate(rec.period, d.dueDay);
        rec.createdAt = rec.updatedAt = LU.nowISO(); rec.version = 1;
        needIds.push({row:o.row, rec});
      }
      if(rec.amountDue==null) rec.amountDue = rec.amountPaid>0 ? rec.amountPaid : (d.monthly||0);
      records.push(rec);
    });
    return {records, needIds, skipped};
  },
  appCells(rec){
    return [LU.txt(rec.id), LU.txt(rec.loanId), rec.type||'installment', LU.txt(rec.dueDate), LU.txt(rec.paymentDate), LU.blankNum(rec.amountDue), rec.status,
      LU.blankNum(rec.principal), LU.blankNum(rec.interest), LU.blankNum(rec.fees), LU.txt(rec.reference), LU.txt(rec.receiptFileId), LU.txt(rec.receiptName), LU.txt(rec.receiptLink),
      LU.txt(rec.notes), LU.txt(rec.createdAt), LU.txt(rec.updatedAt), rec.version||1];
  },
  evidence(rec){ return rec.receiptLink ? '=HYPERLINK("'+String(rec.receiptLink).replace(/"/g,'%22')+'","Transaction Details")' : ''; },
  async assignIds(cfg, needIds){
    if(!needIds.length) return;
    await GSheets.batchUpdateValues(cfg.spreadsheetId, needIds.map(x=>({range:rng(cfg.ledgerTab,`G${x.row}:X${x.row}`), values:[this.appCells(x.rec)]})));
  },
  async writeRow(cfg, row, rec, writeB){
    const tab = cfg.ledgerTab;
    const data = [
      {range:rng(tab,'A'+row), values:[[LU.txt(LU.periodLabel(rec.period))]]},
      {range:rng(tab,'C'+row), values:[[LoanCalc.isConfirmed(rec) ? LU.num(rec.amountPaid) : '']]},
      {range:rng(tab,`G${row}:X${row}`), values:[this.appCells(rec)]},
    ];
    if(writeB) data.push({range:rng(tab,'B'+row), values:[[this.evidence(rec)]]});
    await GSheets.batchUpdateValues(cfg.spreadsheetId, data);
  },

  /* ----- idempotent upsert / delete, always by payment ID ----- */
  async upsert(cfg, rec, d, baseHash, force){
    const led = await this.readLedger(cfg);
    const parsed = this.parse(cfg, led, d);
    const cur = parsed.records.find(x=>x.id===rec.id);
    if(cur){
      const ch = LU.hash(cur);
      if(ch === LU.hash(rec)) return {ok:true, noop:true};                       // already applied: a retry changes nothing
      if(!force && ch !== baseHash) return {conflict:true, cloud:cur};          // changed elsewhere since the user started editing
    }
    const row = cur ? cur._row : Math.max(1, ...led.rows.map(r=>r.row)) + 1;
    await this.ensureGrid(cfg, led, row);
    const curObj = cur ? led.rows.find(r=>r.row===cur._row) : null;
    const writeB = (rec.receiptLink||'') !== (curObj ? (curObj.b.link||'') : '');
    await this.writeRow(cfg, row, rec, writeB);
    const back = this.parse(cfg, await this.readLedger(cfg), d).records.find(x=>x.id===rec.id);
    if(!back || LU.hash(back) !== LU.hash(rec)) throw new Error('verify_failed');
    return {ok:true, row};
  },
  async remove(cfg, id, d, baseHash, force){
    const led = await this.readLedger(cfg);
    const cur = this.parse(cfg, led, d).records.find(x=>x.id===id);
    if(!cur) return {ok:true, noop:true};
    if(!force && LU.hash(cur) !== baseHash) return {conflict:true, cloud:cur};
    // Clear only this app's cells. Rows are never deleted/shifted, so columns D:E stay intact.
    await GSheets.clearRanges(cfg.spreadsheetId, [rng(cfg.ledgerTab,`A${cur._row}:C${cur._row}`), rng(cfg.ledgerTab,`G${cur._row}:X${cur._row}`)]);
    const back = this.parse(cfg, await this.readLedger(cfg), d).records.find(x=>x.id===id);
    if(back) throw new Error('verify_failed');
    return {ok:true};
  },

  /* ----- loan details (single record) ----- */
  loanRow(l){
    return [LU.txt(l.id), l.name||'', LU.blankNum(l.originalAmount), l.currency||'SAR', LU.txt(l.startDate), LU.txt(l.firstInstallmentDate), LU.blankNum(l.monthlyInstallment),
      l.frequency||'monthly', LU.blankNum(l.rate), l.method||'', LU.blankNum(l.termMonths), LU.txt(l.expectedEndDate), LU.blankNum(l.extraFees), l.notes||'', LU.txt(l.createdAt), LU.txt(l.updatedAt), l.version||1];
  },
  fromLoanRow(r){
    const g = i => LU.untxt(r[i]);
    return {id:g(0)||'loan_1', name:g(1), originalAmount:LU.num(r[2])??'', currency:g(3)||'SAR', startDate:LU.normDate(g(4)), firstInstallmentDate:LU.normDate(g(5)), monthlyInstallment:LU.num(r[6])??'',
      frequency:g(7)||'monthly', rate:LU.num(r[8])??'', method:g(9), termMonths:LU.num(r[10])??'', expectedEndDate:LU.normDate(g(11)), extraFees:LU.num(r[12])??'', notes:g(13), createdAt:g(14), updatedAt:g(15), version:LU.num(r[16])||1};
  },
  async readLoan(cfg){
    let v; try{ v = await GSheets.getValues(cfg.spreadsheetId, rng(LOAN_TAB.details,'A1:Q3')); }catch(e){ if(this.isMissingTab(e)) return null; throw e; }
    if(v.length<2 || !(v[1]||[])[0]) return null;
    const r = v[1].slice(); while(r.length<17) r.push('');
    return this.fromLoanRow(r);
  },
  async writeLoan(cfg, loan, baseHash, force){
    loan.id = loan.id || 'loan_1';                    // a loan record is located by a non-empty ID
    const cloud = await this.readLoan(cfg);
    if(cloud && LU.hashLoan(cloud)===LU.hashLoan(loan)) return {ok:true, noop:true};
    if(cloud && !force && baseHash!=null && LU.hashLoan(cloud)!==baseHash) return {conflict:true, cloud};
    if(cloud && !force && baseHash==null) return {conflict:true, cloud};          // never silently replace an existing loan record
    await GSheets.batchUpdateValues(cfg.spreadsheetId, [
      {range:rng(LOAN_TAB.details,'A1:Q1'), values:[LOAN_DETAIL_HEAD]},
      {range:rng(LOAN_TAB.details,'A2:Q2'), values:[this.loanRow(loan)]},
    ]);
    const back = await this.readLoan(cfg);
    if(!back || LU.hashLoan(back)!==LU.hashLoan(loan)) throw new Error('verify_failed');
    return {ok:true};
  },

  /* ----- metadata & write test ----- */
  async writeMeta(cfg, extra){
    const rows = [['Schema Version',LOAN_SCHEMA],['Spreadsheet ID',cfg.spreadsheetId],['Ledger Tab',cfg.ledgerTab],['Drive Folder ID',cfg.rootFolderId||''],['Drive Folder Name',cfg.rootFolderName||''],
      ['Month Folder Pattern',cfg.monthPattern],['Year Folders',JSON.stringify(cfg.yearFolders||{})],['Calculation Mode',cfg.calcMode||'auto'],['Last Successful Sync',extra.lastSync||''],['Last Sync Status',extra.lastStatus||''],['Pending Operations',extra.pending||0],['Written By','Wifaq']];
    await GSheets.batchUpdateValues(cfg.spreadsheetId, [{range:rng(LOAN_TAB.meta,'A1:B1'), values:[['Setting','Value']]},{range:rng(LOAN_TAB.meta,`A2:B${rows.length+1}`), values:rows.map(r=>[r[0], typeof r[1]==='number'?r[1]:LU.txt(String(r[1]))])}]);
  },
  async connectionTest(cfg){
    const stamp = 'test-'+LU.uid8();
    await GSheets.batchUpdateValues(cfg.spreadsheetId, [{range:rng(LOAN_TAB.meta,'A40:B40'), values:[['Connection Test', LU.txt(stamp)]]}]);
    const v = await GSheets.getValues(cfg.spreadsheetId, rng(LOAN_TAB.meta,'A40:B40'));
    await GSheets.clearRanges(cfg.spreadsheetId, [rng(LOAN_TAB.meta,'A40:B40')]);
    if(LU.untxt(((v[0]||[])[1])||'') !== stamp) throw new Error('write_test_failed');
    return true;
  },

  /* ----- extra loan documents (contract, statements...) ----- */
  async readDocs(cfg){
    let v; try{ v = await GSheets.getValues(cfg.spreadsheetId, rng(LOAN_TAB.docs,'A2:H500')); }catch(e){ if(this.isMissingTab(e)) return []; throw e; }
    return v.filter(r=>r[0]).map((r,i)=>({id:LU.untxt(r[0]), fileId:LU.untxt(r[1]), name:LU.untxt(r[2]), type:LU.untxt(r[3]), size:LU.num(r[4])||0, uploadedAt:LU.untxt(r[5]), link:LU.untxt(r[6]), notes:LU.untxt(r[7]), _row:i+2}));
  },
  async upsertDoc(cfg, doc){
    const docs = await this.readDocs(cfg); const cur = docs.find(d=>d.id===doc.id);
    let row = cur ? cur._row : (docs.length ? Math.max(...docs.map(d=>d._row)) : 1) + 1;
    await GSheets.batchUpdateValues(cfg.spreadsheetId, [{range:rng(LOAN_TAB.docs,'A1:H1'), values:[LOAN_DOC_HEAD]},{range:rng(LOAN_TAB.docs,`A${row}:H${row}`), values:[[LU.txt(doc.id),LU.txt(doc.fileId),LU.txt(doc.name),doc.type||'',doc.size||0,LU.txt(doc.uploadedAt),LU.txt(doc.link),LU.txt(doc.notes)]]}]);
    return {ok:true};
  },
  async removeDoc(cfg, id){
    const docs = await this.readDocs(cfg); const cur = docs.find(d=>d.id===id);
    if(cur) await GSheets.clearRanges(cfg.spreadsheetId, [rng(LOAN_TAB.docs,`A${cur._row}:H${cur._row}`)]);
    return {ok:true};
  },
};

/* ======================================================================
   GOOGLE DRIVE — receipts (inside the folder you picked)
   ====================================================================== */
const LoanDrive = {
  validate(file){
    const ext = (file.name.split('.').pop()||'').toLowerCase();
    const okType = ['application/pdf','image/jpeg','image/png','image/webp'].includes(file.type) || ['pdf','jpg','jpeg','png','webp'].includes(ext);
    if(!okType) return 'ln_err_type';
    if(file.size > LOAN_FILE_MAX) return 'ln_err_size';
    if(file.size === 0) return 'ln_err_empty';
    return null;
  },
  ext(file){ const e=(file.name.split('.').pop()||'').toLowerCase(); if(file.type==='application/pdf') return 'pdf'; if(file.type==='image/png') return 'png'; if(file.type==='image/webp') return 'webp'; if(file.type==='image/jpeg') return 'jpg'; return e==='jpeg'?'jpg':e; },
  fmtMonth(pattern, period){
    const [y,m] = period.split('-'); const d = new Date(+y, +m-1, 1);
    return (pattern||'{MM} - {YYYY}').replace(/\{YYYY\}/g,y).replace(/\{MM\}/g,m).replace(/\{M\}/g,String(+m))
      .replace(/\{MMMM\}/g,d.toLocaleString('en-GB',{month:'long'})).replace(/\{MMM\}/g,d.toLocaleString('en-GB',{month:'short'}));
  },
  fileName(rec, file, n){
    const kind = rec.type==='extra' ? 'Additional_Payment' : 'Installment';
    return 'Mortgage_'+rec.period+'_'+kind+'_Receipt'+(n>1?'_'+n:'')+'.'+this.ext(file);
  },
  // Reuses a folder you picked or that the app made earlier; only creates what is genuinely missing.
  async folderFor(cfg, period){
    if(!cfg.rootFolderId) throw new Error('no_receipts_folder');
    const [y] = period.split('-');
    let yearId = cfg.yearFolders[y];
    if(!yearId){ const f = await GDrive.findChild(y, cfg.rootFolderId, LOAN_FOLDER_MIME); yearId = f ? f.id : await GDrive.ensureFolder(y, cfg.rootFolderId); cfg.yearFolders[y] = yearId; }
    let monthId = cfg.monthFolders[period];
    if(!monthId){ const name = this.fmtMonth(cfg.monthPattern, period); const f = await GDrive.findChild(name, yearId, LOAN_FOLDER_MIME); monthId = f ? f.id : await GDrive.ensureFolder(name, yearId); cfg.monthFolders[period] = monthId; }
    return monthId;
  },
  async docsFolder(cfg){
    if(!cfg.rootFolderId) throw new Error('no_receipts_folder');
    if(!cfg.docsFolderId){ const f = await GDrive.findChild('Loan Documents', cfg.rootFolderId, LOAN_FOLDER_MIME); cfg.docsFolderId = f ? f.id : await GDrive.ensureFolder('Loan Documents', cfg.rootFolderId); }
    return cfg.docsFolderId;
  },
  async upload(folderId, file, filename){
    const base64 = await new Promise((res,rej)=>{ const rd=new FileReader(); rd.onload=()=>res(String(rd.result).split(',')[1]); rd.onerror=rej; rd.readAsDataURL(file); });
    const boundary = 'ln_'+LU.uid8();
    const mime = file.type || 'application/octet-stream';
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name:filename, parents:[folderId]})}\r\n--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64}\r\n--${boundary}--`;
    const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink', {method:'POST', headers:{...Auth.authHeaders(),'Content-Type':'multipart/related; boundary='+boundary}, body});
    return {id:r.id, name:r.name||filename, mimeType:r.mimeType||mime, size:Number(r.size)||file.size, link:r.webViewLink || 'https://drive.google.com/file/d/'+r.id+'/view'};
  },
  async blob(fileId){
    const res = await fetch('https://www.googleapis.com/drive/v3/files/'+fileId+'?alt=media', {headers:Auth.authHeaders()});
    if(!res.ok) throw new Error('file_not_accessible');
    return res.blob();
  },
};

/* ======================================================================
   GOOGLE PICKER — the only way a drive.file-scoped app can be granted
   access to a spreadsheet / folder it did not create.
   ====================================================================== */
const LoanPicker = {
  keysReady(){ return !/^YOUR_/.test(CONFIG.GOOGLE_API_KEY||'YOUR_') && !/^YOUR_/.test(CONFIG.GOOGLE_APP_ID||'YOUR_'); },
  _p: null,
  load(){
    if(this._p) return this._p;
    this._p = new Promise((res,rej)=>{
      const go = () => window.gapi.load('picker', {callback:res, onerror:()=>rej(new Error('picker_load_failed'))});
      if(window.gapi && window.gapi.load){ go(); return; }
      const s = document.createElement('script'); s.src = 'https://apis.google.com/js/api.js'; s.onload = go; s.onerror = ()=>{ this._p=null; rej(new Error('picker_load_failed')); };
      document.head.appendChild(s);
    });
    return this._p;
  },
  // kind: 'spreadsheet' | 'folder' | 'folders'; parentId optional (start inside that folder)
  async pick(kind, parentId){
    if(!this.keysReady()) throw new Error('picker_keys_missing');
    if(!(await Auth.ensureFreshToken())) throw new Error('auth_expired');
    await this.load();
    const g = window.google.picker;
    let view;
    if(kind==='spreadsheet') view = new g.DocsView(g.ViewId.SPREADSHEETS);
    else { view = new g.DocsView(g.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(LOAN_FOLDER_MIME); if(parentId) view.setParent(parentId); }
    return new Promise((resolve)=>{
      const b = new g.PickerBuilder().setOAuthToken(Auth.accessToken).setDeveloperKey(CONFIG.GOOGLE_API_KEY).setAppId(CONFIG.GOOGLE_APP_ID)
        .setOrigin(location.protocol+'//'+location.host).addView(view).setLocale(Lang.cur==='ar'?'ar':'en')
        .setCallback(d=>{
          if(d.action===g.Action.PICKED) resolve((d.docs||[]).map(x=>({id:x.id, name:x.name, mimeType:x.mimeType, url:x.url})));
          else if(d.action===g.Action.CANCEL) resolve(null);
        });
      if(kind==='folders') b.enableFeature(g.Feature.MULTISELECT_ENABLED);
      b.build().setVisible(true);
    });
  },
};

/* ======================================================================
   STRINGS (English + Saudi Arabic) — merged into the app's own dictionary
   ====================================================================== */
const LN_EN = {
  ln_title:'Mortgage loan', ln_nav_home:'Home', ln_nav_details:'Details', ln_nav_payments:'Payments', ln_nav_history:'History', ln_nav_docs:'Documents',
  ln_sched_attention:'Needs attention', ln_sched_all:'All installments', ln_sched_unpaid:'Unpaid only', ln_sched_due:'Due', ln_sched_paid:'Paid', ln_sched_left:'left', ln_sched_empty:'No installments to show.', ln_period_tx:'Transactions', ln_period_none:'No payments recorded for this month.', ln_period_add:'Record payment for this month', ln_tab_overview:'Overview', ln_tab_payments:'Payments', ln_tab_analytics:'Analytics', ln_tab_docs:'Receipts', ln_tab_loan:'Loan', ln_tab_settings:'Settings & backup',
  ln_st_synced:'Synced', ln_st_syncing:'Syncing…', ln_st_pending:'Pending changes', ln_st_failed:'Sync failed', ln_st_offline:'Offline', ln_st_idle:'Not connected',
  ln_last_sync:'Last sync', ln_never:'never', ln_sync_now:'Sync now',
  ln_stale:'Showing the last saved data — it may be out of date. {msg}',
  ln_estimate:'Estimate', ln_confirmed:'Confirmed',
  ln_setup_title:'Set up your mortgage tracker', ln_setup_intro:'Your existing spreadsheet and Drive folder are reused as they are. Nothing is changed until you press “Save and initialise”.',
  ln_step_google:'Google account', ln_step_sheet:'Ledger spreadsheet', ln_step_folder:'Receipts folder', ln_step_loan:'Loan details',
  ln_need_signin:'Connect your Google account first (Settings → Google Drive & Sheets).',
  ln_need_keys:'To choose your existing files, add GOOGLE_API_KEY and GOOGLE_APP_ID to CONFIG in index.html (see the setup notes), then reload.',
  ln_pick_sheet:'Choose spreadsheet', ln_pick_folder:'Choose folder', ln_pick_years:'Choose year folders', ln_change:'Change',
  ln_found_tab:'Ledger tab: {tab} · {n} payment rows found', ln_found_infer:'Detected from your sheet: total paid {paid}; original amount {orig}.',
  ln_folder_optional:'Needed for uploading new receipts. Existing receipts keep opening from their saved links.',
  ln_years_hint:'Pick your existing year folders (e.g. 2025, 2026) so new receipts go into them instead of new folders.',
  ln_save_init:'Save and initialise', ln_working:'Working…',
  ln_init_ok:'Tracker is ready', ln_err_hdr_missing:'The app columns (G:X) are missing from your ledger tab, so nothing was written. Nothing was deleted.', ln_cf_resolve:'Resolve', ln_err_headers:'Columns G:X of your ledger tab already contain other data. Nothing was changed — move or clear them and try again.',
  ln_err_keys:'GOOGLE_API_KEY / GOOGLE_APP_ID are not set in CONFIG.', ln_err_picker:'Google file picker could not load. Check your connection.', ln_err_auth:'Your Google sign-in expired. Your data is safe — reconnect and it will sync.',
  ln_err_nofolder:'Choose your receipts folder first (Settings & backup).', ln_err_type:'Use a PDF, JPG, PNG or WebP file.', ln_err_size:'File is larger than 15 MB.', ln_err_empty:'The file is empty.',
  ln_err_verify:'The sheet did not confirm the change. It will be retried.', ln_err_nocloud:'Could not read your spreadsheet.', ln_err_noledger:'No ledger tab with “Month - Year” in A1 was found.',
  ln_c_original:'Original loan', ln_c_paid:'Total paid', ln_c_principal:'Principal repaid', ln_c_remaining:'Remaining balance', ln_c_progress:'Repayment progress',
  ln_c_inst_paid:'Installments paid', ln_c_next:'Next payment', ln_c_outstanding:'Outstanding installments', ln_c_month:'Paid this month', ln_c_year:'Paid this year',
  ln_of_term:'{n} of {term}', ln_est_left:'≈ {n} left', ln_none_due:'—',
  ln_note_a:'Simplified model: every payment is treated as reducing the principal. Interest/profit, fees and insurance are not included, so this is an estimate — not the bank’s balance.',
  ln_note_b:'Based on the principal portions you entered ({n} payment(s) have no breakdown and are not counted yet).',
  ln_complete:'Loan fully repaid', ln_complete_sub:'The remaining balance is zero.',
  ln_alert_overdue:'{n} overdue installment(s)', ln_alert_partial:'{n} partially paid installment(s)', ln_alert_missing:'{n} payment(s) have no receipt',
  ln_recent:'Recent payments', ln_upcoming:'Upcoming', ln_nothing:'Nothing yet', ln_payoff:'Estimated payoff', ln_payoff_note:'Estimate based on the current installment — not a bank figure.',
  ln_add_payment:'+ Add payment', ln_search:'Search…', ln_f_all:'All', ln_f_year:'Year', ln_f_month:'Month', ln_f_status:'Status', ln_f_receipt:'Receipt', ln_f_kind:'Type',
  ln_f_with:'With receipt', ln_f_without:'Missing receipt', ln_f_partial:'Partial payments', ln_f_extra:'Additional payments',
  ln_sort:'Sort', ln_sort_date_desc:'Newest first', ln_sort_date_asc:'Oldest first', ln_sort_amt_desc:'Amount ↓', ln_sort_amt_asc:'Amount ↑', ln_sort_status:'Status',
  ln_status_paid:'Paid', ln_status_partial:'Partial', ln_status_pending:'Pending', ln_status_overdue:'Overdue', ln_status_cancelled:'Cancelled',
  ln_results:'{n} record(s) · paid {sum}', ln_empty_payments:'No payments recorded yet. Your saved history appears here after the first sync.',
  ln_receipt_has:'Receipt', ln_receipt_missing:'Receipt missing', ln_extra:'Additional',
  ln_form_add:'Add payment', ln_form_edit:'Edit payment', ln_f_period:'Installment month', ln_f_type:'Type', ln_type_inst:'Regular installment', ln_type_extra:'Additional / early payment',
  ln_f_due:'Due date', ln_f_paydate:'Payment date', ln_f_amount_due:'Amount due', ln_f_amount_paid:'Amount paid', ln_f_principal:'Principal portion', ln_f_interest:'Interest / profit portion',
  ln_f_fees:'Fees', ln_f_ref:'Transaction reference', ln_f_notes:'Notes', ln_f_file:'Receipt (PDF, JPG, PNG, WebP)', ln_advanced:'Breakdown (optional)',
  ln_save:'Save', ln_cancel:'Cancel', ln_delete:'Delete', ln_edit:'Edit', ln_close:'Close', ln_view:'View', ln_download:'Download', ln_replace:'Replace', ln_attach:'Attach receipt', ln_remove:'Remove',
  ln_saved:'Saved', ln_err_period:'Choose the installment month (YYYY-MM).', ln_err_amount:'Enter the amount paid.', ln_err_amount_due:'Enter a valid amount.',
  ln_err_status_paid:'A paid payment needs an amount greater than zero.', ln_dup:'A payment with the same month, amount, date and reference already exists. Save anyway?',
  ln_confirm_delete:'Delete this payment record? Its receipt file stays in Google Drive.', ln_confirm_remove_receipt:'Remove the receipt from this payment? The file itself stays in Google Drive.',
  ln_upload_failed:'The receipt could not be uploaded ({msg}). Save the payment without it?', ln_uploading:'Uploading receipt…', ln_receipt_saved:'Receipt attached',
  ln_detail_remaining:'Remaining on installment', ln_created:'Created', ln_updated:'Last updated', ln_id:'Payment ID',
  ln_open_drive:'Open in Drive', ln_preview_fail:'Preview is not available here — open it in Drive.',
  ln_a_progress:'Loan repayment progress', ln_a_monthly:'Monthly payments (last 12 months)', ln_a_yearly:'Annual totals', ln_a_expected:'Expected vs actual (by installment)',
  ln_a_counts:'Installments paid vs outstanding', ln_a_principal:'Principal repaid over time', ln_a_payoff:'Estimated payoff date',
  ln_legend_actual:'Actual', ln_legend_expected:'Expected', ln_legend_paid:'Paid', ln_legend_outstanding:'Outstanding', ln_legend_remaining:'Remaining (estimate)',
  ln_proj:'Projection', ln_hist:'Recorded history', ln_no_data:'Not enough data yet.',
  ln_d_receipts:'Receipt status', ln_d_with:'{n} with receipt', ln_d_without:'{n} missing a receipt', ln_d_docs:'Loan documents', ln_d_upload_doc:'+ Upload document', ln_d_none:'No documents yet.',
  ln_d_all_ok:'Every confirmed payment has a receipt.',
  ln_l_name:'Loan name / reference', ln_l_amount:'Original loan amount', ln_l_currency:'Currency', ln_l_start:'Loan start date', ln_l_first:'First installment date', ln_l_monthly:'Monthly installment',
  ln_l_freq:'Payment frequency', ln_l_freq_m:'Monthly', ln_l_term:'Loan term', ln_l_months:'months', ln_l_years:'years', ln_l_rate:'Annual interest / profit rate (%)', ln_l_rate_hint:'Leave blank if unknown or interest-free.',
  ln_l_method:'Interest calculation method', ln_l_end:'Expected final payment date', ln_l_fees:'Additional fees or insurance', ln_l_notes:'Notes', ln_l_saved_note:'Changing the installment amount affects future installments only — recorded payments never change.',
  ln_l_err_amount:'Enter the original loan amount.', ln_l_err_monthly:'Enter the monthly installment.', ln_l_err_first:'Enter the first installment date.',
  ln_s_conn:'Connections', ln_s_sheet:'Spreadsheet', ln_s_tab:'Ledger tab', ln_s_folder:'Receipts folder', ln_s_open:'Open', ln_s_pattern:'Month folder name', ln_s_pattern_hint:'Tokens: {MM} {MMM} {MMMM} {YYYY}. Used only when a month folder has to be created.',
  ln_s_calc:'Calculation', ln_s_calc_auto:'Automatic (recommended)', ln_s_calc_simple:'Always simplified (payments reduce principal)', ln_s_theme:'Appearance', ln_s_light:'Light', ln_s_dark:'Dark', ln_s_auto:'Match device',
  ln_s_sync:'Synchronisation', ln_s_test:'Test connection', ln_s_test_ok:'Reading and writing both work', ln_s_pending:'Pending changes: {n}',
  ln_s_backup:'Backup & export', ln_s_backup_json:'Download backup (JSON)', ln_s_restore:'Restore from backup file', ln_s_csv:'Export payments (CSV, opens in Excel)', ln_s_snap:'Automatic safety copies', ln_s_snap_none:'None yet',
  ln_s_disconnect:'Disconnect on this device', ln_s_disconnect_confirm:'Remove the mortgage tracker setup from this device? Your spreadsheet and Drive files are not touched.',
  ln_restore_bad:'This file is not a valid backup: {msg}', ln_restore_plan:'The backup has {total} payment(s): {add} new, {diff} different from current, {same} identical.\n\nAdd the {add} new payment(s)?',
  ln_restore_replace:'Also replace the {diff} existing payment(s) that differ with the backup versions?', ln_restore_loan:'Replace the current loan details with the ones in the backup?', ln_restore_done:'Restore queued — syncing',
  ln_cf_title:'Changed in Google Sheets', ln_cf_desc:'This record was changed in the spreadsheet after you started editing it. Choose which version to keep — nothing is overwritten until you decide.',
  ln_cf_sheet:'Use the Google Sheets version', ln_cf_mine:'Keep my version', ln_cf_cancel:'Cancel, decide later', ln_cf_in_sheet:'In Google Sheets', ln_cf_on_device:'On this device',
  ln_cf_loan:'Loan details', ln_cf_resolved:'Resolved',
  ln_eg_title:'Spreadsheet shows no payments', ln_eg_desc:'Your spreadsheet has no payment rows, but this device has {n} confirmed payment(s). Nothing was deleted. What should happen?',
  ln_eg_restore:'Restore them to the spreadsheet', ln_eg_accept:'Accept the empty sheet (backup first)',
  ln_skipped:'{n} row(s) in your sheet could not be read as a payment and were left untouched.',
  ln_disc:'Disconnected', ln_connected:'Connected', ln_no_sheet:'Not selected',
};
const LN_AR = {
  ln_title:'القرض العقاري', ln_nav_home:'الرئيسية', ln_nav_details:'تفاصيل القرض', ln_nav_payments:'الدفعات', ln_nav_history:'سجل المدفوعات', ln_nav_docs:'المستندات',
  ln_sched_attention:'يحتاج انتباه', ln_sched_all:'كل الأقساط', ln_sched_unpaid:'غير المسددة فقط', ln_sched_due:'يستحق', ln_sched_paid:'المدفوع', ln_sched_left:'باقي', ln_sched_empty:'ما فيه أقساط للعرض.', ln_period_tx:'العمليات', ln_period_none:'ما فيه دفعات مسجّلة لهالشهر.', ln_period_add:'سجّل دفعة لهالشهر', ln_tab_overview:'نظرة عامة', ln_tab_payments:'الدفعات', ln_tab_analytics:'التحليلات', ln_tab_docs:'الإيصالات', ln_tab_loan:'القرض', ln_tab_settings:'الإعدادات والنسخ',
  ln_st_synced:'مزامن', ln_st_syncing:'يزامن الحين…', ln_st_pending:'تغييرات معلّقة', ln_st_failed:'المزامنة ما زبطت', ln_st_offline:'ماكو نت', ln_st_idle:'مو متصل',
  ln_last_sync:'آخر مزامنة', ln_never:'ما صارت', ln_sync_now:'زامن الحين',
  ln_stale:'تشوف آخر بيانات محفوظة — ممكن تكون قديمة. {msg}',
  ln_estimate:'تقدير', ln_confirmed:'مؤكد',
  ln_setup_title:'جهّز متابعة القرض العقاري', ln_setup_intro:'نستخدم نفس الشيت ومجلد درايف الموجودين عندك بدون تغيير. ما يتغيّر شي لين تضغط «احفظ وجهّز».',
  ln_step_google:'حساب قوقل', ln_step_sheet:'شيت السجل', ln_step_folder:'مجلد الإيصالات', ln_step_loan:'تفاصيل القرض',
  ln_need_signin:'وصّل حساب قوقل أول (الإعدادات ← قوقل درايف وشيتس).',
  ln_need_keys:'عشان تختار ملفاتك الموجودة، ضيف GOOGLE_API_KEY و GOOGLE_APP_ID في CONFIG داخل index.html (شوف خطوات الإعداد) وبعدها رفرش.',
  ln_pick_sheet:'اختر الشيت', ln_pick_folder:'اختر المجلد', ln_pick_years:'اختر مجلدات السنوات', ln_change:'غيّر',
  ln_found_tab:'تبويب السجل: {tab} · لقينا {n} صف دفعة', ln_found_infer:'اللي لقيناه في شيتك: إجمالي المدفوع {paid}؛ أصل القرض {orig}.',
  ln_folder_optional:'تحتاجه لرفع الإيصالات الجديدة. الإيصالات القديمة تظل تنفتح من روابطها المحفوظة.',
  ln_years_hint:'اختر مجلدات السنوات الموجودة (مثل 2025 و2026) عشان الإيصالات الجديدة تنحط فيها بدل ما نسوي مجلدات جديدة.',
  ln_save_init:'احفظ وجهّز', ln_working:'يشتغل…',
  ln_init_ok:'التطبيق جاهز', ln_err_hdr_missing:'أعمدة التطبيق (G:X) مفقودة من تبويب السجل، فما انكتب شي. وما انحذف شي.', ln_cf_resolve:'حل', ln_err_headers:'الأعمدة G:X في تبويب السجل فيها بيانات ثانية. ما تغيّر شي — انقلها أو امسحها وجرّب مرة ثانية.',
  ln_err_keys:'GOOGLE_API_KEY / GOOGLE_APP_ID مو مضبوطين في CONFIG.', ln_err_picker:'ما قدرنا نحمّل أداة اختيار الملفات من قوقل. تأكد من النت.', ln_err_auth:'انتهت جلسة قوقل. بياناتك محفوظة — وصّل من جديد وتتزامن.',
  ln_err_nofolder:'اختر مجلد الإيصالات أول (الإعدادات والنسخ).', ln_err_type:'استخدم ملف PDF أو JPG أو PNG أو WebP.', ln_err_size:'الملف أكبر من 15 ميجا.', ln_err_empty:'الملف فاضي.',
  ln_err_verify:'الشيت ما أكّد التغيير. بنعيد المحاولة.', ln_err_nocloud:'ما قدرنا نقرا الشيت.', ln_err_noledger:'ما لقينا تبويب سجل فيه «Month - Year» في A1.',
  ln_c_original:'أصل القرض', ln_c_paid:'إجمالي المدفوع', ln_c_principal:'المسدّد من الأصل', ln_c_remaining:'الرصيد المتبقي', ln_c_progress:'نسبة السداد',
  ln_c_inst_paid:'الأقساط المدفوعة', ln_c_next:'الدفعة الجاية', ln_c_outstanding:'أقساط متأخرة/ناقصة', ln_c_month:'مدفوع هالشهر', ln_c_year:'مدفوع هالسنة',
  ln_of_term:'{n} من {term}', ln_est_left:'≈ باقي {n}', ln_none_due:'—',
  ln_note_a:'نموذج مبسّط: كل دفعة تنحسب كأنها تنقص من أصل القرض. الفوائد/الأرباح والرسوم والتأمين مو محسوبة، فالرقم تقدير — مو رصيد البنك.',
  ln_note_b:'مبني على مبالغ الأصل اللي دخلتها ({n} دفعة بدون تفصيل وما انحسبت لين الحين).',
  ln_complete:'تم سداد القرض بالكامل', ln_complete_sub:'الرصيد المتبقي صفر.',
  ln_alert_overdue:'{n} قسط متأخر', ln_alert_partial:'{n} قسط مدفوع جزئياً', ln_alert_missing:'{n} دفعة بدون إيصال',
  ln_recent:'آخر الدفعات', ln_upcoming:'الجاي', ln_nothing:'ما فيه شي لين الحين', ln_payoff:'تاريخ السداد المتوقع', ln_payoff_note:'تقدير على حسب القسط الحالي — مو رقم من البنك.',
  ln_add_payment:'+ أضف دفعة', ln_search:'بحث…', ln_f_all:'الكل', ln_f_year:'السنة', ln_f_month:'الشهر', ln_f_status:'الحالة', ln_f_receipt:'الإيصال', ln_f_kind:'النوع',
  ln_f_with:'فيه إيصال', ln_f_without:'بدون إيصال', ln_f_partial:'دفعات جزئية', ln_f_extra:'دفعات إضافية',
  ln_sort:'الترتيب', ln_sort_date_desc:'الأحدث أول', ln_sort_date_asc:'الأقدم أول', ln_sort_amt_desc:'المبلغ ↓', ln_sort_amt_asc:'المبلغ ↑', ln_sort_status:'الحالة',
  ln_status_paid:'مدفوع', ln_status_partial:'جزئي', ln_status_pending:'قادم', ln_status_overdue:'متأخر', ln_status_cancelled:'ملغي',
  ln_results:'{n} سجل · المدفوع {sum}', ln_empty_payments:'ما فيه دفعات مسجّلة. سجلك المحفوظ يظهر هنا بعد أول مزامنة.',
  ln_receipt_has:'إيصال', ln_receipt_missing:'بدون إيصال', ln_extra:'إضافية',
  ln_form_add:'أضف دفعة', ln_form_edit:'عدّل الدفعة', ln_f_period:'شهر القسط', ln_f_type:'النوع', ln_type_inst:'قسط عادي', ln_type_extra:'دفعة إضافية / مبكرة',
  ln_f_due:'تاريخ الاستحقاق', ln_f_paydate:'تاريخ الدفع', ln_f_amount_due:'المبلغ المستحق', ln_f_amount_paid:'المبلغ المدفوع', ln_f_principal:'جزء الأصل', ln_f_interest:'جزء الفائدة / الربح',
  ln_f_fees:'الرسوم', ln_f_ref:'رقم العملية', ln_f_notes:'ملاحظات', ln_f_file:'الإيصال (PDF أو JPG أو PNG أو WebP)', ln_advanced:'التفصيل (اختياري)',
  ln_save:'احفظ', ln_cancel:'إلغاء', ln_delete:'احذف', ln_edit:'عدّل', ln_close:'سكّر', ln_view:'شوف', ln_download:'نزّل', ln_replace:'استبدل', ln_attach:'أرفق إيصال', ln_remove:'شيل',
  ln_saved:'تم الحفظ', ln_err_period:'اختر شهر القسط (YYYY-MM).', ln_err_amount:'دخّل المبلغ المدفوع.', ln_err_amount_due:'دخّل مبلغ صحيح.',
  ln_err_status_paid:'الدفعة المدفوعة لازم يكون مبلغها أكبر من صفر.', ln_dup:'فيه دفعة بنفس الشهر والمبلغ والتاريخ ورقم العملية. تبي تحفظها بعد؟',
  ln_confirm_delete:'تبي تحذف سجل الدفعة؟ ملف الإيصال يظل في قوقل درايف.', ln_confirm_remove_receipt:'تبي تشيل الإيصال من هالدفعة؟ الملف نفسه يظل في قوقل درايف.',
  ln_upload_failed:'ما قدرنا نرفع الإيصال ({msg}). تحفظ الدفعة بدونه؟', ln_uploading:'يرفع الإيصال…', ln_receipt_saved:'تم إرفاق الإيصال',
  ln_detail_remaining:'المتبقي من القسط', ln_created:'تاريخ الإنشاء', ln_updated:'آخر تعديل', ln_id:'رقم الدفعة',
  ln_open_drive:'افتحه في درايف', ln_preview_fail:'المعاينة مو متاحة هنا — افتحه في درايف.',
  ln_a_progress:'تقدّم سداد القرض', ln_a_monthly:'الدفعات الشهرية (آخر 12 شهر)', ln_a_yearly:'الإجمالي السنوي', ln_a_expected:'المتوقع مقابل الفعلي (لكل قسط)',
  ln_a_counts:'الأقساط المدفوعة مقابل المتبقية', ln_a_principal:'المسدّد من الأصل عبر الوقت', ln_a_payoff:'تاريخ السداد المتوقع',
  ln_legend_actual:'الفعلي', ln_legend_expected:'المتوقع', ln_legend_paid:'مدفوع', ln_legend_outstanding:'متأخر', ln_legend_remaining:'متبقي (تقدير)',
  ln_proj:'توقع', ln_hist:'سجل فعلي', ln_no_data:'ما فيه بيانات كافية لين الحين.',
  ln_d_receipts:'حالة الإيصالات', ln_d_with:'{n} فيها إيصال', ln_d_without:'{n} بدون إيصال', ln_d_docs:'مستندات القرض', ln_d_upload_doc:'+ ارفع مستند', ln_d_none:'ما فيه مستندات.',
  ln_d_all_ok:'كل دفعة مؤكدة عندها إيصال.',
  ln_l_name:'اسم القرض / المرجع', ln_l_amount:'أصل القرض', ln_l_currency:'العملة', ln_l_start:'تاريخ بداية القرض', ln_l_first:'تاريخ أول قسط', ln_l_monthly:'القسط الشهري',
  ln_l_freq:'تكرار الدفع', ln_l_freq_m:'شهري', ln_l_term:'مدة القرض', ln_l_months:'شهر', ln_l_years:'سنة', ln_l_rate:'نسبة الفائدة / الربح السنوية (%)', ln_l_rate_hint:'اتركها فاضية لو ما تعرفها أو القرض بدون فوائد.',
  ln_l_method:'طريقة احتساب الفائدة', ln_l_end:'تاريخ آخر دفعة المتوقع', ln_l_fees:'رسوم أو تأمين إضافي', ln_l_notes:'ملاحظات', ln_l_saved_note:'تغيير القسط يأثر على الأقساط الجاية بس — الدفعات المسجّلة ما تتغيّر أبداً.',
  ln_l_err_amount:'دخّل أصل القرض.', ln_l_err_monthly:'دخّل القسط الشهري.', ln_l_err_first:'دخّل تاريخ أول قسط.',
  ln_s_conn:'الاتصالات', ln_s_sheet:'الشيت', ln_s_tab:'تبويب السجل', ln_s_folder:'مجلد الإيصالات', ln_s_open:'افتح', ln_s_pattern:'اسم مجلد الشهر', ln_s_pattern_hint:'الرموز: {MM} {MMM} {MMMM} {YYYY}. تُستخدم بس لما نحتاج ننشئ مجلد شهر.',
  ln_s_calc:'الحساب', ln_s_calc_auto:'تلقائي (الأفضل)', ln_s_calc_simple:'مبسّط دايماً (الدفعات تنقص الأصل)', ln_s_theme:'المظهر', ln_s_light:'فاتح', ln_s_dark:'داكن', ln_s_auto:'حسب الجهاز',
  ln_s_sync:'المزامنة', ln_s_test:'اختبر الاتصال', ln_s_test_ok:'القراءة والكتابة شغّالين', ln_s_pending:'تغييرات معلّقة: {n}',
  ln_s_backup:'النسخ الاحتياطي والتصدير', ln_s_backup_json:'نزّل نسخة احتياطية (JSON)', ln_s_restore:'استرجع من ملف نسخة', ln_s_csv:'صدّر الدفعات (CSV، يفتح في إكسل)', ln_s_snap:'نسخ أمان تلقائية', ln_s_snap_none:'ما فيه',
  ln_s_disconnect:'افصل على هالجهاز', ln_s_disconnect_confirm:'تبي تشيل إعداد متابعة القرض من هالجهاز؟ الشيت وملفات درايف ما يتأثرون.',
  ln_restore_bad:'هالملف مو نسخة احتياطية صحيحة: {msg}', ln_restore_plan:'النسخة فيها {total} دفعة: {add} جديدة، {diff} تختلف عن الحالي، {same} مطابقة.\n\nتضيف الـ {add} الجديدة؟',
  ln_restore_replace:'تستبدل كمان الـ {diff} دفعة اللي تختلف بنسخة الباك أب؟', ln_restore_loan:'تستبدل تفاصيل القرض الحالية باللي في النسخة؟', ln_restore_done:'تم جدولة الاسترجاع — يزامن',
  ln_cf_title:'تغيّر في قوقل شيتس', ln_cf_desc:'هالسجل تغيّر في الشيت بعد ما بدأت تعدّله. اختر أي نسخة تحتفظ فيها — ما يتكتب فوق شي لين تقرر.',
  ln_cf_sheet:'استخدم نسخة قوقل شيتس', ln_cf_mine:'خلّي نسختي', ln_cf_cancel:'ألغِ، أقرر بعدين', ln_cf_in_sheet:'في قوقل شيتس', ln_cf_on_device:'على هالجهاز',
  ln_cf_loan:'تفاصيل القرض', ln_cf_resolved:'تم الحل',
  ln_eg_title:'الشيت ما فيه دفعات', ln_eg_desc:'شيتك ما فيه صفوف دفعات، لكن هالجهاز فيه {n} دفعة مؤكدة. ما انحذف شي. وش تبي نسوي؟',
  ln_eg_restore:'رجّعها للشيت', ln_eg_accept:'اقبل الشيت الفاضي (بعد نسخة احتياطية)',
  ln_skipped:'{n} صف في شيتك ما قدرنا نقراه كدفعة وتركناه كما هو.',
  ln_disc:'مفصول', ln_connected:'متصل', ln_no_sheet:'ما انختار',
};
if(typeof I18N !== 'undefined'){ Object.assign(I18N.en, LN_EN); Object.assign(I18N.ar, LN_AR); }

/* ======================================================================
   STYLES (loan-specific + dark mode for the whole app)
   ====================================================================== */
(function(){
  const css = `
html[data-theme="dark"]{--ink:#E9EFEA;--paper:#121815;--paper-2:#1C2420;--card:#19211D;--line:rgba(233,239,234,.13);--moss:#4F8560;--moss-deep:#3A6A4B;--clay:#E39A68;--gold:#D9B35F;--danger:#E8745C;--muted:#9BAAA1;}
html[data-theme="dark"] .banner{background:#2B2517;border-color:#5C4B22;color:#E6CC8C;}
html[data-theme="dark"] .badge.paid{background:#1E3A2A;color:#A5D8B4;}
html[data-theme="dark"] .badge.unpaid{background:#3B2219;color:#F2A892;}
html[data-theme="dark"] .icon-btn:active{background:#3B2219;}
html[data-theme="dark"] .ln-tab.active,html[data-theme="dark"] .btn-primary{color:#fff;}
.badge.partial{background:#F6EBD2;color:#7A5A1F;}.badge.overdue{background:#F3D9D2;color:#8B2E1B;}.badge.pending{background:#E7E9EE;color:#4A5568;}.badge.cancelled{background:#ECE8DC;color:#6B7A70;text-decoration:line-through;}
html[data-theme="dark"] .badge.partial{background:#3B3118;color:#E6CC8C;}html[data-theme="dark"] .badge.overdue{background:#3B2219;color:#F2A892;}html[data-theme="dark"] .badge.pending{background:#252C33;color:#B6C0CC;}html[data-theme="dark"] .badge.cancelled{background:#242B27;color:#9BAAA1;}
.ln-tabs{display:flex;gap:6px;overflow-x:auto;padding:4px 0 10px;scrollbar-width:none;}.ln-tabs::-webkit-scrollbar{display:none;}
.ln-tab{flex:none;border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:999px;padding:8px 14px;font:inherit;font-size:13px;font-weight:600;white-space:nowrap;}
.ln-tab.active{background:var(--moss);border-color:var(--moss);color:#fff;}
.ln-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0;flex-wrap:wrap;}
.ln-sub{font-size:11.5px;color:var(--muted);}
.ln-note{font-size:12px;color:var(--muted);line-height:1.55;margin:4px 2px 12px;}
.ln-s .value{font-size:18px;}.ln-s .label{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.ln-tag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:var(--paper-2);color:var(--muted);}
.ln-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.ln-filters{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px;}
.ln-filters select{width:auto;flex:1 1 30%;min-width:96px;height:40px;padding:6px 8px;font-size:13px;}
.ln-search{margin-bottom:8px;}
.ln-chip{font-size:11px;border:1px solid var(--moss);color:var(--moss);border-radius:999px;padding:1px 7px;}
.ln-chip.warn{border-color:var(--clay);color:var(--clay);}
.ln-step{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line);}.ln-step:last-child{border-bottom:none;}
.ln-step .ic{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);flex:none;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;}
.ln-step .ic.ok{background:var(--moss);border-color:var(--moss);}
.ln-step .bd{flex:1;min-width:0;}.ln-step .tt{font-weight:600;font-size:14px;}.ln-step .ds{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.5;}
.ln-chart{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);padding:14px;margin-bottom:12px;}
.ln-chart h3{margin:0 0 8px;font-size:14.5px;}.ln-legend{display:flex;gap:12px;font-size:11.5px;color:var(--muted);flex-wrap:wrap;margin-top:6px;}
.ln-sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:5px;vertical-align:-1px;}
.ln-err{color:var(--danger);font-size:12.5px;margin:6px 0;min-height:16px;}
.ln-row-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}.ln-row-actions .btn{flex:1;min-width:110px;}
.ln-img{max-width:100%;border-radius:12px;display:block;margin:10px auto;}
.ln-details summary{cursor:pointer;font-weight:600;font-size:13px;margin:6px 0 10px;color:var(--moss);}
.ln-ring{display:block;margin:0 auto;}
.ln-pre{white-space:pre-wrap;font-size:13px;line-height:1.5;}
`;
  const st = document.createElement('style'); st.id = 'loanCSS'; st.textContent = css; document.head.appendChild(st);
})();

const LoanTheme = {
  get(){ return localStorage.getItem(LOAN_THEME_KEY) || 'light'; },       // default keeps the app looking exactly as before
  apply(mode){
    mode = mode || this.get();
    const dark = mode==='dark' || (mode==='auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  },
  set(mode){ localStorage.setItem(LOAN_THEME_KEY, mode); this.apply(mode); },
};
LoanTheme.apply();

/* ======================================================================
   TINY SVG CHARTS (no libraries)
   ====================================================================== */
const LoanChart = {
  k(c){ const v=c/100; return v>=1000 ? (v/1000).toFixed(v>=10000?0:1)+'k' : String(Math.round(v)); },
  lab(p){ return p.slice(5)+'/'+p.slice(2,4); },
  ring(pct){
    const r=48, c=2*Math.PI*r, d=c*LU.clamp(pct,0,100)/100;
    return `<svg class="ln-ring" viewBox="0 0 120 120" width="130" height="130" role="img" aria-label="${pct.toFixed(2)}%"><circle cx="60" cy="60" r="${r}" style="fill:none;stroke:var(--paper-2);stroke-width:12"/><circle cx="60" cy="60" r="${r}" style="fill:none;stroke:var(--moss);stroke-width:12;stroke-linecap:round" stroke-dasharray="${d} ${c}" transform="rotate(-90 60 60)"/><text x="60" y="66" text-anchor="middle" style="fill:var(--ink);font-size:19px;font-weight:700">${pct.toFixed(2)}%</text></svg>`;
  },
  bars(items, grouped){
    if(!items.length) return '';
    const W=320,H=170,L=34,R=6,T=10,B=26, cw=W-L-R, ch=H-T-B, n=items.length, slot=cw/n;
    const max = Math.max(1, ...items.map(i=>Math.max(i.a||0,i.b||0)));
    const bw = Math.max(2, Math.min(18, slot*(grouped?0.4:0.6)));
    let g='';
    [0,.5,1].forEach(f=>{ const y=T+ch*(1-f); g+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" style="stroke:var(--line)"/><text x="${L-4}" y="${y+3}" text-anchor="end" style="fill:var(--muted);font-size:8px">${this.k(max*f)}</text>`; });
    const step = Math.ceil(n/8);
    items.forEach((it,i)=>{
      const cx = L+slot*i+slot/2, hA=ch*(it.a||0)/max, hB=ch*(it.b||0)/max;
      if(grouped){
        g+=`<rect x="${cx-bw}" y="${T+ch-hB}" width="${bw}" height="${hB}" rx="2" style="fill:var(--paper-2);stroke:var(--line)"/>`;
        g+=`<rect x="${cx}" y="${T+ch-hA}" width="${bw}" height="${hA}" rx="2" style="fill:var(--moss)"/>`;
      } else g+=`<rect x="${cx-bw/2}" y="${T+ch-hA}" width="${bw}" height="${hA}" rx="2" style="fill:var(--moss)"/>`;
      if(i%step===0) g+=`<text x="${cx}" y="${H-10}" text-anchor="middle" style="fill:var(--muted);font-size:8px">${it.label}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
  },
  line(pts){
    if(pts.length<2) return '';
    const W=320,H=170,L=34,R=8,T=10,B=26, cw=W-L-R, ch=H-T-B;
    const max = Math.max(1, ...pts.map(p=>p.v));
    const X = i => L+cw*i/(pts.length-1), Y = v => T+ch*(1-v/max);
    let g=''; [0,.5,1].forEach(f=>{ const y=T+ch*(1-f); g+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" style="stroke:var(--line)"/><text x="${L-4}" y="${y+3}" text-anchor="end" style="fill:var(--muted);font-size:8px">${this.k(max*f)}</text>`; });
    const path = pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p.v).toFixed(1)).join(' ');
    g+=`<path d="${path} L${X(pts.length-1)} ${T+ch} L${L} ${T+ch} Z" style="fill:var(--moss);opacity:.12"/><path d="${path}" style="fill:none;stroke:var(--moss);stroke-width:2"/>`;
    const step = Math.ceil(pts.length/6);
    pts.forEach((p,i)=>{ if(i%step===0||i===pts.length-1) g+=`<text x="${X(i)}" y="${H-10}" text-anchor="middle" style="fill:var(--muted);font-size:8px">${p.label}</text>`; });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
  },
  stack(segs){
    const tot = segs.reduce((a,s)=>a+s.v,0) || 1; let x=0, g='';
    segs.forEach(s=>{ const w=300*s.v/tot; g+=`<rect x="${x}" y="0" width="${w}" height="22" style="fill:${s.color}"/>`; x+=w; });
    return `<svg viewBox="0 0 300 22" width="100%" height="22" style="border-radius:8px;overflow:hidden" role="img">${g}</svg>`;
  },
};

/* ======================================================================
   QUEUE of unsent changes (survives reloads; every op is idempotent by ID)
   ====================================================================== */
const LoanQ = {
  items(){ try{ return JSON.parse(localStorage.getItem(LOAN_QUEUE_KEY)) || []; }catch(e){ return []; } },
  set(a){ localStorage.setItem(LOAN_QUEUE_KEY, JSON.stringify(a)); },
  count(){ return this.items().length; },
  key(o){ return o.type==='loan' ? 'loan' : o.type+':'+((o.rec&&o.rec.id)||o.id||(o.doc&&o.doc.id)||''); },
  put(op){
    const a = this.items(), k = this.key(op), i = a.findIndex(o=>this.key(o)===k);
    if(i>=0){ if(op.baseHash===undefined) op.baseHash = a[i].baseHash; op.qid = a[i].qid; a[i] = op; }   // keep the ORIGINAL base: it's what the sheet looked like when editing began
    else { op.qid = 'q_'+LU.uid8(); a.push(op); }
    this.set(a); return op;
  },
  drop(pred){ this.set(this.items().filter(o=>!pred(o))); },
  remove(qid){ this.drop(o=>o.qid===qid); },
};

/* ======================================================================
   LOAN — state, synchronisation, actions and screens
   ====================================================================== */
const Loan = {
  s: null,
  ui: {tab:'home', sub:{home:'overview', details:'loan'}, q:'', fYear:'', fMonth:'', fStatus:'', fReceipt:'', fKind:'', sort:'date-desc', statusTouched:false, sYear:'', sUnpaid:false},
  syncing:false, lastError:'', conflicts:[], emptyGuard:0, setupBusy:false, setupErr:'', _saving:false, _blobUrl:null, _t:null, _lastBackup:{},

  /* ---------- state ---------- */
  defaults(){ return {
    cfg:{spreadsheetId:'', spreadsheetName:'', ledgerTab:'', rootFolderId:'', rootFolderName:'', yearFolders:{}, monthFolders:{}, docsFolderId:'', monthPattern:'{MM} - {YYYY}', calcMode:'auto', layout:0, linkSaved:false},
    loan:null, payments:[], docs:[], cloudHash:{}, cloudLoanHash:null, inferred:null, skipped:0,
    meta:{lastSync:'', lastStatus:'', stale:false, lastMetaWrite:0} }; },
  init(){
    const d0 = this.defaults(); let d = null;
    try{ d = JSON.parse(localStorage.getItem(LOAN_CACHE_KEY)); }catch(e){}
    this.s = Object.assign(d0, d||{}); this.s.cfg = Object.assign(d0.cfg, (d&&d.cfg)||{}); this.s.meta = Object.assign(this.defaults().meta, (d&&d.meta)||{});
    this.s.cfg.yearFolders = this.s.cfg.yearFolders||{}; this.s.cfg.monthFolders = this.s.cfg.monthFolders||{};
  },
  save(){ try{ localStorage.setItem(LOAN_CACHE_KEY, JSON.stringify(this.s)); }catch(e){} },
  cfgReady(){ const c=this.s.cfg; return !!(c.spreadsheetId && c.ledgerTab && c.layout===LOAN_SCHEMA); },
  ready(){ return this.cfgReady() && !!this.s.loan; },
  dflt(loan){
    loan = loan || this.s.loan || {}; const f = loan.firstInstallmentDate || '';
    return {loanId: loan.id || 'loan_1', dueDay: f ? (Number(f.slice(8,10))||1) : 1, monthly: LU.num(loan.monthlyInstallment)||0};
  },
  metrics(){ return LoanCalc.compute(this.s.loan || {originalAmount:0, monthlyInstallment:0}, this.s.payments, {calcMode:this.s.cfg.calcMode}); },
  status(){
    if(this.syncing) return 'syncing';
    if(!Auth.signedIn) return 'idle';
    if(navigator.onLine===false) return 'offline';
    if(this.lastError) return 'failed';
    if(LoanQ.count()>0 || this.conflicts.length) return 'pending';
    return this.s.meta.lastSync ? 'synced' : 'idle';
  },
  errMsg(e){
    const m = (e&&e.message) || String(e);
    if(/^ln_/.test(m)) return t(m);
    const map = {no_receipts_folder:'ln_err_nofolder', ledger_headers_conflict:'ln_err_headers', ledger_headers_missing:'ln_err_hdr_missing', picker_keys_missing:'ln_err_keys', picker_load_failed:'ln_err_picker',
      auth_expired:'ln_err_auth', verify_failed:'ln_err_verify', ledger_tab_not_found:'ln_err_noledger', write_test_failed:'ln_err_verify'};
    return map[m] ? t(map[m]) : m;
  },
  renderIfVisible(){ if(typeof Shell!=='undefined' && Shell.current==='loan') this.render(); },
  onModalClose(){ if(this._blobUrl){ URL.revokeObjectURL(this._blobUrl); this._blobUrl=null; } },
  openModal(html){ $('modalBody').innerHTML = html; $('modalBackdrop').classList.add('open'); },

  /* ---------- backups (local safety copies; the sheet itself stays the source of truth) ---------- */
  exportObj(){
    const c = this.s.cfg; const clean = p => { const x = Object.assign({}, p); delete x._row; delete x._pending; return x; };
    return {app:'wifaq-loan', schema:LOAN_SCHEMA, exportedAt:LU.nowISO(), loan:this.s.loan, payments:this.s.payments.map(clean), documents:this.s.docs.map(d=>{ const x=Object.assign({},d); delete x._row; return x; }),
      config:{spreadsheetId:c.spreadsheetId, ledgerTab:c.ledgerTab, rootFolderId:c.rootFolderId, rootFolderName:c.rootFolderName, yearFolders:c.yearFolders, monthPattern:c.monthPattern, calcMode:c.calcMode},
      receiptManifest:this.s.payments.filter(p=>p.receiptFileId||p.receiptLink).map(p=>({paymentId:p.id, period:p.period, fileId:p.receiptFileId, filename:p.receiptName, link:p.receiptLink}))};
  },
  backup(reason, extra){
    const now = Date.now(); if(this._lastBackup[reason] && now-this._lastBackup[reason] < 60000) return; this._lastBackup[reason] = now;
    try{
      const arr = JSON.parse(localStorage.getItem(LOAN_BACKUP_KEY)||'[]');
      arr.unshift({at:LU.nowISO(), reason, data:Object.assign(this.exportObj(), extra||{})});
      localStorage.setItem(LOAN_BACKUP_KEY, JSON.stringify(arr.slice(0,3)));
    }catch(e){}
  },
  download(name, content, mime){
    const blob = content instanceof Blob ? content : new Blob([content], {type:mime});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  },
  exportJSON(){ this.download('wifaq-loan-backup-'+LU.today()+'.json', JSON.stringify(this.exportObj(), null, 2), 'application/json'); },
  exportCSV(){
    const q = v => { let s = String(v==null?'':v); if(/^[=+\-@]/.test(s)) s = "'"+s; return '"'+s.replace(/"/g,'""')+'"'; };
    const head = ['Installment Month','Type','Due Date','Payment Date','Amount Due','Amount Paid','Status','Principal','Interest/Profit','Fees','Reference','Receipt','Receipt Link','Notes','Payment ID'];
    const rows = this.s.payments.slice().sort((a,b)=>(a.period+a.paymentDate).localeCompare(b.period+b.paymentDate)).map(p=>[p.period,p.type,p.dueDate,p.paymentDate,LU.toCents(p.amountDue)/100,LU.toCents(p.amountPaid)/100,p.status,p.principal,p.interest,p.fees,p.reference,p.receiptName||(p.receiptFileId?'yes':''),p.receiptLink,p.notes,p.id]);
    this.download('wifaq-loan-payments-'+LU.today()+'.csv', '\ufeff'+[head].concat(rows).map(r=>r.map(q).join(',')).join('\r\n'), 'text/csv');
  },
  validateBackup(o){
    const errs = [];
    if(!o || o.app!=='wifaq-loan') errs.push('not a Wifaq loan backup');
    else {
      if(!(o.schema<=LOAN_SCHEMA)) errs.push('newer schema '+o.schema);
      if(!Array.isArray(o.payments)) errs.push('payments missing');
      else o.payments.forEach((p,i)=>{
        if(!p || typeof p.id!=='string' || !p.id) errs.push('payment '+(i+1)+': id'); else {
          if(!/^\d{4}-\d{2}$/.test(p.period||'')) errs.push(p.id+': period');
          if(!['installment','extra'].includes(p.type)) errs.push(p.id+': type');
          if(!LOAN_STATUSES.includes(p.status)) errs.push(p.id+': status');
          if(!(Number.isFinite(Number(p.amountPaid)) && Number(p.amountPaid)>=0)) errs.push(p.id+': amount');
        }});
    }
    return errs.slice(0,5);
  },
  restoreFile(){
    const inp = document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
    inp.onchange = async ()=>{
      const f = inp.files[0]; if(!f) return;
      let o; try{ o = JSON.parse(await f.text()); }catch(e){ toast(t('ln_restore_bad',{msg:'JSON'})); return; }
      const errs = this.validateBackup(o); if(errs.length){ alert(t('ln_restore_bad',{msg:errs.join(', ')})); return; }
      const cur = new Map(this.s.payments.map(p=>[p.id,p]));
      const add = o.payments.filter(p=>!cur.has(p.id)), diff = o.payments.filter(p=>cur.has(p.id) && LU.hash(cur.get(p.id))!==LU.hash(p));
      const same = o.payments.length - add.length - diff.length;
      if(!confirm(t('ln_restore_plan',{total:o.payments.length, add:add.length, diff:diff.length, same}))) return;
      this.backup('before-restore');
      const queue = p => { const rec = Object.assign({}, p); delete rec._row; delete rec._pending; this.savePayment(rec, !cur.has(p.id), true); };
      add.forEach(queue);
      if(diff.length && confirm(t('ln_restore_replace',{diff:diff.length}))) diff.forEach(queue);
      if(o.loan && (!this.s.loan || LU.hashLoan(o.loan)!==LU.hashLoan(this.s.loan)) && (!this.s.loan || confirm(t('ln_restore_loan')))){
        const base = this.s.cloudLoanHash; this.s.loan = o.loan; LoanQ.put({type:'loan', loan:o.loan, baseHash:base===undefined?null:base});
      }
      this.save(); toast(t('ln_restore_done')); this.render(); this.schedule();
    };
    inp.click();
  },

  /* ---------- link to this setup, kept in the building spreadsheet so a cleared browser can reconnect ---------- */
  async saveLink(){
    const bs = Cache.data.settings.sheetId; if(!bs) return false;
    const c = this.s.cfg;
    const tabs = await LoanSheet.tabs(bs);
    if(!tabs.some(x=>x.title===LOAN_TAB.link)){
      await gfetch('https://sheets.googleapis.com/v4/spreadsheets/'+bs+':batchUpdate', {method:'POST', headers:{...Auth.authHeaders(),'Content-Type':'application/json'}, body:JSON.stringify({requests:[{addSheet:{properties:{title:LOAN_TAB.link}}}]})});
    }
    const rows = [['Loan Spreadsheet ID',c.spreadsheetId],['Loan Spreadsheet Name',c.spreadsheetName],['Ledger Tab',c.ledgerTab],['Receipts Folder ID',c.rootFolderId],['Receipts Folder Name',c.rootFolderName],
      ['Year Folders',JSON.stringify(c.yearFolders||{})],['Month Folder Pattern',c.monthPattern],['Calculation Mode',c.calcMode],['Schema',String(c.layout||0)]];
    await GSheets.batchUpdateValues(bs, [{range:rng(LOAN_TAB.link,'A1:B1'), values:[['Setting','Value']]},{range:rng(LOAN_TAB.link,`A2:B${rows.length+1}`), values:rows.map(r=>[r[0], LU.txt(String(r[1]||''))])}]);
    c.linkSaved = true; this.save(); return true;
  },
  async trySaveLink(){ try{ return await this.saveLink(); }catch(e){ this.s.cfg.linkSaved=false; return false; } },
  async restoreLink(){
    const bs = Cache.data.settings.sheetId; if(!bs) return false;
    let v; try{ v = await GSheets.getValues(bs, rng(LOAN_TAB.link,'A2:B30')); }catch(e){ return false; }
    const m = {}; v.forEach(r=>{ if(r[0]) m[r[0]] = LU.untxt(r[1]); });
    if(!m['Loan Spreadsheet ID'] || !m['Ledger Tab']) return false;
    const c = this.s.cfg; let years = {}; try{ years = JSON.parse(m['Year Folders']||'{}'); }catch(e){}
    Object.assign(c, {spreadsheetId:m['Loan Spreadsheet ID'], spreadsheetName:m['Loan Spreadsheet Name']||'', ledgerTab:m['Ledger Tab'], rootFolderId:m['Receipts Folder ID']||'', rootFolderName:m['Receipts Folder Name']||'',
      yearFolders:years, monthPattern:m['Month Folder Pattern']||c.monthPattern, calcMode:m['Calculation Mode']||'auto', layout:Number(m['Schema'])||0, linkSaved:true});
    this.save(); return true;
  },

  /* ---------- sign-in / scheduling ---------- */
  async onSignedIn(){
    try{ if(!this.s.cfg.spreadsheetId) await this.restoreLink(); }catch(e){}
    if(this.cfgReady()) await this.sync(); else this.renderIfVisible();
  },
  schedule(){ clearTimeout(this._t); this._t = setTimeout(()=>this.maybeSync(true), 600); },
  maybeSync(force){
    if(!this.cfgReady() || !Auth.signedIn || this.syncing || navigator.onLine===false) return;
    const old = Date.now() - (Date.parse(this.s.meta.lastSync)||0) > 300000;
    if(force || LoanQ.count()>0 || this.s.meta.stale || old) this.sync();
  },
  syncNow(){ if(!Auth.signedIn){ toast(t('ln_err_auth')); return; } if(!this.cfgReady()){ this.renderIfVisible(); return; } this.sync({manual:true}); },

  /* ---------- the sync cycle: read everything -> validate -> reconcile -> write queued changes -> re-read ---------- */
  async pull(){
    const c = this.s.cfg;
    const led = await LoanSheet.readLedger(c);
    if(!led.header || led.header.app[0] !== 'Payment ID') throw new Error('ledger_headers_missing');
    const parsed = LoanSheet.parse(c, led, this.dflt());
    if(parsed.needIds.length){ this.backup('before-normalise', {rawLedger:led.rows.map(r=>({row:r.row,a:r.a,link:r.b.link,c:r.c.s,id:r.app[0].s}))}); await LoanSheet.assignIds(c, parsed.needIds); }
    const cloud = parsed.records; this.s.skipped = parsed.skipped;
    // An empty answer is NEVER taken as permission to forget what we have.
    // (payments that already have an unsent upsert queued are not "at risk": they are about to be written)
    const queued = new Set(LoanQ.items().filter(o=>o.type==='upsert').map(o=>o.rec.id));
    const atRisk = this.s.payments.filter(p=>LoanCalc.isConfirmed(p) && !queued.has(p.id)).length;
    if(cloud.length===0 && atRisk>0 && !LoanQ.items().some(o=>o.type==='delete')){ this.emptyGuard = atRisk; throw new Error('empty_guard'); }
    this.emptyGuard = 0;
    this.s.cloudHash = {}; cloud.forEach(r=>{ this.s.cloudHash[r.id] = LU.hash(r); });
    let list = cloud.slice();
    LoanQ.items().forEach(op=>{
      if(op.type==='upsert'){ const r = Object.assign({}, op.rec, {_pending:true}); const i = list.findIndex(x=>x.id===op.rec.id); if(i>=0) list[i]=r; else list.push(r); }
      else if(op.type==='delete') list = list.filter(x=>x.id!==op.id);
    });
    this.s.payments = list;
    const cl = await LoanSheet.readLoan(c), pl = LoanQ.items().find(o=>o.type==='loan');
    if(cl){ this.s.cloudLoanHash = LU.hashLoan(cl); if(!pl) this.s.loan = cl; }
    else if(this.s.loan && !pl){ LoanQ.put({type:'loan', loan:this.s.loan, baseHash:null}); }
    let docs = await LoanSheet.readDocs(c);
    LoanQ.items().forEach(op=>{ if(op.type==='doc' && !docs.some(d=>d.id===op.doc.id)) docs.push(op.doc); if(op.type==='doc-remove') docs = docs.filter(d=>d.id!==op.id); });
    this.s.docs = docs; this.save();
  },
  async applyOp(op){
    const c = this.s.cfg, d = this.dflt();
    if(op.type==='upsert') return LoanSheet.upsert(c, op.rec, d, op.baseHash, !!op.force);
    if(op.type==='delete') return LoanSheet.remove(c, op.id, d, op.baseHash, !!op.force);
    if(op.type==='loan') return LoanSheet.writeLoan(c, op.loan, op.baseHash, !!op.force);
    if(op.type==='doc') return LoanSheet.upsertDoc(c, op.doc);
    if(op.type==='doc-remove') return LoanSheet.removeDoc(c, op.id);
    return {ok:true};
  },
  async flush(){
    let changed = false; this.conflicts = [];
    const ops = LoanQ.items(); if(ops.length) this.backup('before-sync-write');
    for(const op of ops){
      const res = await this.applyOp(op);           // a thrown error stops here and leaves every unsent change queued
      if(res && res.conflict){ this.conflicts.push({op, cloud:res.cloud}); continue; }
      LoanQ.remove(op.qid); changed = true;
    }
    return {changed};
  },
  async sync(opts){
    opts = opts || {};
    if(this.syncing || !this.cfgReady() || !Auth.signedIn || navigator.onLine===false){ this.renderIfVisible(); return; }
    this.syncing = true; this.lastError = ''; this.renderIfVisible();
    try{
      if(!(await Auth.ensureFreshToken())) throw new Error('auth_expired');
      await this.pull();
      const f = await this.flush();
      if(f.changed) await this.pull();
      if(f.changed || opts.manual || Date.now()-(this.s.meta.lastMetaWrite||0) > 3600000){
        try{ await LoanSheet.writeMeta(this.s.cfg, {lastSync:LU.nowISO(), lastStatus:'ok', pending:LoanQ.count()}); this.s.meta.lastMetaWrite = Date.now(); }catch(e){}
      }
      if(!this.s.cfg.linkSaved) await this.trySaveLink();
      this.s.meta.lastSync = LU.nowISO(); this.s.meta.lastStatus = 'ok'; this.s.meta.stale = false;
    }catch(e){
      this.lastError = e.message==='empty_guard' ? 'empty_guard' : this.errMsg(e);
      this.s.meta.lastStatus = 'failed'; this.s.meta.stale = true;
    }finally{
      this.syncing = false; this.save(); this.renderIfVisible();
      if(this.conflicts.length && typeof Shell!=='undefined' && Shell.current==='loan') this.showConflict(this.conflicts[0]);
    }
  },

  /* ---------- conflicts ---------- */
  showConflict(cf){
    const op = cf.op, cl = cf.cloud || {};
    const F = c => LU.fmt(LU.toCents(c), (this.s.loan||{}).currency);
    let rows = '';
    if(op.type==='upsert'){
      const mine = op.rec;
      const line = (label, a, b) => `<div class="kv"><span class="k">${label}</span><span class="v" style="text-align:end">${esc(a)}<br><span class="ln-sub">${esc(b)}</span></span></div>`;
      rows = line(t('ln_f_period'), monthName(cl.period||mine.period), monthName(mine.period))
        + line(t('ln_f_status'), t('ln_status_'+(cl.status||'pending')), t('ln_status_'+mine.status))
        + line(t('ln_f_amount_paid'), F(cl.amountPaid), F(mine.amountPaid))
        + line(t('ln_f_paydate'), cl.paymentDate||'—', mine.paymentDate||'—')
        + line(t('ln_f_notes'), cl.notes||'—', mine.notes||'—');
      rows = `<div class="ln-sub">${t('ln_cf_in_sheet')} / ${t('ln_cf_on_device')}</div>` + rows;
    } else if(op.type==='loan'){
      rows = `<div class="kv"><span class="k">${t('ln_cf_loan')}</span><span class="v">${esc(cl.name||'')} · ${F(cl.originalAmount)}</span></div><div class="kv"><span class="k">${t('ln_cf_on_device')}</span><span class="v">${esc(op.loan.name||'')} · ${F(op.loan.originalAmount)}</span></div>`;
    } else rows = `<div class="kv"><span class="k">${t('ln_id')}</span><span class="v">${esc(op.id||'')}</span></div>`;
    this.openModal(`<div class="modal-handle"></div><h2 class="serif">${t('ln_cf_title')}</h2><p class="ln-note">${t('ln_cf_desc')}</p>${rows}
      <button class="btn btn-primary btn-block" style="margin-top:14px" data-q="${esc(op.qid)}" onclick="Loan.resolveConflict(this.dataset.q,'sheet')">${t('ln_cf_sheet')}</button>
      <button class="btn btn-danger btn-block" style="margin-top:10px" data-q="${esc(op.qid)}" onclick="Loan.resolveConflict(this.dataset.q,'mine')">${t('ln_cf_mine')}</button>
      <button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="App.closeModal()">${t('ln_cf_cancel')}</button>`);
  },
  async resolveConflict(qid, choice){
    App.closeModal();
    const ops = LoanQ.items(), op = ops.find(o=>o.qid===qid); if(!op) return;
    this.backup('before-resolve');
    if(choice==='sheet') LoanQ.remove(qid);
    else { op.force = true; LoanQ.set(ops); }
    this.conflicts = this.conflicts.filter(c=>c.op.qid!==qid);
    toast(t('ln_cf_resolved')); await this.sync({manual:true});
  },
  resolveEmpty(choice){
    this._lastBackup['before-empty-resolve'] = 0; this.backup('before-empty-resolve');
    if(choice==='restore'){ this.s.payments.forEach(p=>{ const rec = Object.assign({}, p); delete rec._row; delete rec._pending; LoanQ.put({type:'upsert', rec, baseHash:null}); }); }
    else { this.s.payments = []; }
    this.emptyGuard = 0; this.lastError = ''; this.save(); this.sync({manual:true});
  },

  /* ---------- setup ---------- */
  infer(led, d2e2){
    const parsed = LoanSheet.parse(this.s.cfg, led, {loanId:'loan_1', dueDay:1, monthly:0}), recs = parsed.records;
    const periods = recs.map(r=>r.period).filter(Boolean).sort(), freq = {};
    recs.forEach(r=>{ const c = LU.toCents(r.amountPaid); if(c>0) freq[c] = (freq[c]||0)+1; });
    const modeC = Object.keys(freq).sort((a,b)=>freq[b]-freq[a])[0];
    return {count:recs.length, firstPeriod:periods[0]||'', lastPeriod:periods[periods.length-1]||'', monthlyC:modeC?Number(modeC):0,
      paidC:recs.reduce((a,r)=>a+LU.toCents(r.amountPaid),0), origC:(d2e2[0]!=null && d2e2[1]!=null) ? Math.round((d2e2[0]+d2e2[1])*100) : null, skipped:parsed.skipped};
  },
  async inspectSheet(){
    const c = this.s.cfg, ins = await LoanSheet.inspect(c.spreadsheetId);
    if(!ins.ledgerTab) throw new Error('ledger_tab_not_found');
    c.ledgerTab = ins.ledgerTab;
    const existing = ins.hasLoanTab ? await LoanSheet.readLoan(c) : null;
    if(existing){                                   // already set up (e.g. on another device): adopt it, change nothing
      this.s.loan = existing; this.s.cloudLoanHash = LU.hashLoan(existing); c.layout = LOAN_SCHEMA; this.s.inferred = null; this.save();
      await this.trySaveLink(); this.sync({manual:true}); return;
    }
    this.s.inferred = this.infer(await LoanSheet.readLedger(c), ins.d2e2); this.save();
  },
  async pickSpreadsheet(){
    this.setupErr = '';
    try{
      const docs = await LoanPicker.pick('spreadsheet'); if(!docs || !docs[0]){ return; }
      if(this.ready() && !confirm(t('ln_s_disconnect_confirm'))) return;
      if(this.ready()) this.backup('before-change-sheet');
      const c = this.s.cfg; Object.assign(c, {spreadsheetId:docs[0].id, spreadsheetName:docs[0].name, ledgerTab:'', layout:0, linkSaved:false});
      this.s.loan = null; this.s.payments = []; this.s.docs = []; this.s.cloudHash = {}; LoanQ.set([]);
      await this.inspectSheet();
    }catch(e){ this.setupErr = this.errMsg(e); }
    this.save(); this.render();
  },
  async pickFolder(){
    try{
      const docs = await LoanPicker.pick('folder'); if(!docs || !docs[0]) return;
      const c = this.s.cfg; Object.assign(c, {rootFolderId:docs[0].id, rootFolderName:docs[0].name, yearFolders:{}, monthFolders:{}, docsFolderId:'', linkSaved:false});
      this.save(); await this.trySaveLink();
    }catch(e){ toast(this.errMsg(e)); }
    this.render();
  },
  async pickYears(){
    try{
      const c = this.s.cfg; if(!c.rootFolderId) return;
      const docs = await LoanPicker.pick('folders', c.rootFolderId); if(!docs) return;
      docs.forEach(d=>{ if(/^\d{4}$/.test(d.name)) c.yearFolders[d.name] = d.id; });
      c.linkSaved = false; this.save(); await this.trySaveLink();
    }catch(e){ toast(this.errMsg(e)); }
    this.render();
  },
  async initialize(loan){
    if(this.setupBusy) return; this.setupBusy = true; this.setupErr = ''; this.render();
    const c = this.s.cfg;
    try{
      if(!(await Auth.ensureFreshToken())) throw new Error('auth_expired');
      await LoanSheet.ensureTabs(c);
      await LoanSheet.ensureHeaders(c);                         // refuses to write over anything that isn't ours
      const led = await LoanSheet.readLedger(c);
      this.backup('before-initialise', {rawLedger:led.rows.map(r=>({row:r.row,a:r.a,link:r.b.link,c:r.c.s,id:r.app[0].s}))});
      const parsed = LoanSheet.parse(c, led, this.dflt(loan));
      await LoanSheet.assignIds(c, parsed.needIds);             // only fills our own G:X cells; your A:E cells are not touched
      loan.createdAt = loan.updatedAt = LU.nowISO(); loan.version = 1;
      const w = await LoanSheet.writeLoan(c, loan, null, false);
      if(w.conflict) loan = w.cloud;                            // a loan record already exists: adopt it, never overwrite
      await LoanSheet.connectionTest(c);
      this.s.loan = loan; this.s.cloudLoanHash = LU.hashLoan(loan); c.layout = LOAN_SCHEMA; this.s.inferred = null; this.save();
      await this.trySaveLink();
      this.setupBusy = false;
      await this.sync({manual:true});
      toast(t('ln_init_ok'));
    }catch(e){ this.setupErr = this.errMsg(e); }
    finally{ this.setupBusy = false; this.save(); this.render(); }
  },

  /* ---------- loan details ---------- */
  readLoanForm(){
    const v = id => { const e = $(id); return e ? e.value.trim() : ''; };
    const amount = LU.num(v('lf_amount')), monthly = LU.num(v('lf_monthly')), first = v('lf_first');
    if(!(amount>0)) return {err:'ln_l_err_amount'}; if(!(monthly>0)) return {err:'ln_l_err_monthly'}; if(!first) return {err:'ln_l_err_first'};
    let term = LU.num(v('lf_term')); if(term!=null && v('lf_unit')==='years') term = term*12;
    const old = this.s.loan || {};
    const loan = Object.assign({}, old, {id:old.id||'loan_1', name:v('lf_name')||'Mortgage', originalAmount:amount, currency:(v('lf_cur')||'SAR').toUpperCase(), startDate:v('lf_start')||first, firstInstallmentDate:first,
      monthlyInstallment:monthly, frequency:'monthly', rate:LU.blankNum(v('lf_rate')), method:v('lf_method'), termMonths:term>0?Math.round(term):'', expectedEndDate:v('lf_end'), extraFees:LU.blankNum(v('lf_fees')), notes:v('lf_notes')});
    if(!loan.expectedEndDate && loan.termMonths) loan.expectedEndDate = LU.dueDate(LU.addMonths(first.slice(0,7), loan.termMonths-1), Number(first.slice(8,10))||1);
    return {loan};
  },
  async saveLoan(){
    if(this._saving) return;
    const r = this.readLoanForm(); if(r.err){ const e=$('lfErr'); if(e) e.textContent = t(r.err); return; }
    if(!this.ready()){ await this.initialize(r.loan); return; }
    const loan = r.loan, old = this.s.loan;
    loan.createdAt = old.createdAt; loan.updatedAt = LU.nowISO(); loan.version = (old.version||0)+1;
    const pend = LoanQ.items().find(o=>o.type==='loan');
    LoanQ.put({type:'loan', loan, baseHash: pend ? undefined : (this.s.cloudLoanHash===undefined ? null : this.s.cloudLoanHash)});
    this.s.loan = loan; this.save(); toast(t('ln_saved')); this.render(); this.schedule();
  },

  /* ---------- payments ---------- */
  savePayment(rec, isNew, quiet){
    const now = LU.nowISO(); rec.updatedAt = now;
    if(isNew){ rec.createdAt = now; rec.version = 1; } else rec.version = (rec.version||1)+1;
    rec.loanId = rec.loanId || (this.s.loan && this.s.loan.id) || 'loan_1';
    if(!LoanCalc.isConfirmed(rec)) rec.amountPaid = 0;           // pending / overdue / cancelled never count as paid
    const clean = Object.assign({}, rec); delete clean._pending; delete clean._row;
    const has = LoanQ.items().some(o=>o.type==='upsert' && o.rec.id===rec.id);
    LoanQ.put({type:'upsert', rec:clean, baseHash: has ? undefined : (this.s.cloudHash[rec.id] ?? null)});
    const shown = Object.assign({}, clean, {_pending:true}), i = this.s.payments.findIndex(x=>x.id===rec.id);
    if(i>=0) this.s.payments[i] = shown; else this.s.payments.push(shown);
    this.save(); if(!quiet){ this.renderIfVisible(); this.schedule(); }
  },
  deletePayment(id){
    if(!confirm(t('ln_confirm_delete'))) return;
    const pend = LoanQ.items().find(o=>o.type==='upsert' && o.rec.id===id);
    const base = pend ? pend.baseHash : (this.s.cloudHash[id] ?? null);
    LoanQ.drop(o=>o.type==='upsert' && o.rec.id===id);
    this.s.payments = this.s.payments.filter(x=>x.id!==id);
    if(base!==null && base!==undefined) LoanQ.put({type:'delete', id, baseHash:base});   // never reached the sheet -> nothing to delete there
    this.save(); App.closeModal(); this.render(); this.schedule();
  },
  formErr(key){ const e=$('pfErr'); if(e) e.textContent = typeof key==='string' && key.startsWith('ln_') ? t(key) : key; return false; },
  openPaymentForm(id, period){
    const edit = id ? this.s.payments.find(p=>p.id===id) : null, m = this.metrics(), l = this.s.loan || {}, today = LU.today();
    const per = edit ? edit.period : (period || (m.next ? m.next.period : today.slice(0,7)));
    const info = m.periods.find(x=>x.period===per);
    const r = edit || {id:'', type:'installment', period:per, dueDate: info ? info.dueDate : LU.dueDate(per, m.dueDay), paymentDate:today,
      amountDue: info&&info.dueC ? info.dueC/100 : (LU.num(l.monthlyInstallment)||''), amountPaid: info&&info.remainingDue ? info.remainingDue/100 : (LU.num(l.monthlyInstallment)||''), status:'paid', principal:'', interest:'', fees:'', reference:'', notes:'', receiptFileId:'', receiptLink:'', receiptName:''};
    this.ui.statusTouched = !!edit;
    const fld = (label, inner) => `<label class="field"><span>${label}</span>${inner}</label>`;
    const sel = (idn, opts, cur, extra) => `<select id="pf_${idn}" ${extra||''}>${opts.map(o=>`<option value="${o[0]}" ${o[0]===cur?'selected':''}>${o[1]}</option>`).join('')}</select>`;
    const num = (idn, v) => `<input type="number" dir="ltr" step="0.01" min="0" id="pf_${idn}" value="${v===''||v==null?'':v}" oninput="Loan.onPayInput()">`;
    this.openModal(`<div class="modal-handle"></div><h2 class="serif">${t(edit?'ln_form_edit':'ln_form_add')}</h2>
      ${fld(t('ln_f_period'), `<input type="month" dir="ltr" id="pf_period" value="${esc(r.period)}" placeholder="YYYY-MM">`)}
      ${fld(t('ln_f_type'), sel('type',[['installment',t('ln_type_inst')],['extra',t('ln_type_extra')]], r.type))}
      <div class="ln-grid2">${fld(t('ln_f_due'), `<input type="date" dir="ltr" id="pf_due" value="${esc(r.dueDate||'')}">`)}${fld(t('ln_f_paydate'), `<input type="date" dir="ltr" id="pf_paydate" value="${esc(r.paymentDate||'')}">`)}</div>
      <div class="ln-grid2">${fld(t('ln_f_amount_due'), num('due_amt', r.amountDue))}${fld(t('ln_f_amount_paid'), num('paid', r.amountPaid||''))}</div>
      ${fld(t('ln_f_status'), sel('status', LOAN_STATUSES.map(s=>[s,t('ln_status_'+s)]), r.status, 'onchange="Loan.ui.statusTouched=true"'))}
      <details class="ln-details"><summary>${t('ln_advanced')}</summary><div class="ln-grid2">${fld(t('ln_f_principal'), num('principal', r.principal))}${fld(t('ln_f_interest'), num('interest', r.interest))}</div>${fld(t('ln_f_fees'), num('fees', r.fees))}</details>
      ${fld(t('ln_f_ref'), `<input type="text" dir="auto" id="pf_ref" value="${esc(r.reference||'')}">`)}
      ${fld(t('ln_f_notes'), `<textarea dir="auto" id="pf_notes">${esc(r.notes||'')}</textarea>`)}
      ${fld(t('ln_f_file'), `<input type="file" id="pf_file" accept=".pdf,.jpg,.jpeg,.png,.webp" style="height:auto">`)}
      <div class="ln-err" id="pfErr"></div>
      <button class="btn btn-primary btn-block" id="pfSave" data-id="${esc(id||'')}" onclick="Loan.submitPayment(this.dataset.id)">${t('ln_save')}</button>
      <button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="App.closeModal()">${t('ln_cancel')}</button>`);
  },
  onPayInput(){
    if(this.ui.statusTouched) return;
    const paid = LU.toCents($('pf_paid').value), due = LU.toCents($('pf_due_amt').value), s = $('pf_status');
    if(paid>0) s.value = (due>0 && paid<due) ? 'partial' : 'paid';
  },
  async submitPayment(id){
    if(this._saving) return;
    const g = k => $('pf_'+k), edit = id ? this.s.payments.find(p=>p.id===id) : null;
    const period = g('period').value.trim();
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return this.formErr('ln_err_period');
    const status = g('status').value, paid = LU.num(g('paid').value), due = LU.num(g('due_amt').value);
    if((paid!=null && paid<0) || (due!=null && due<0)) return this.formErr('ln_err_amount_due');
    if((status==='paid'||status==='partial') && !(paid>0)) return this.formErr('ln_err_status_paid');
    const rec = Object.assign({}, edit||{}, {id:id||LU.newId(period), loanId:(this.s.loan||{}).id||'loan_1', period, type:g('type').value, dueDate:g('due').value, paymentDate:g('paydate').value,
      amountDue:due==null?0:due, amountPaid:paid||0, status, principal:LU.blankNum(g('principal').value), interest:LU.blankNum(g('interest').value), fees:LU.blankNum(g('fees').value), reference:g('ref').value.trim(), notes:g('notes').value.trim()});
    if(!id && this.s.payments.some(p=>p.status!=='cancelled' && p.period===rec.period && p.type===rec.type && LU.toCents(p.amountPaid)===LU.toCents(rec.amountPaid) && (p.paymentDate||'')===(rec.paymentDate||'') && (p.reference||'')===(rec.reference||'')) && !confirm(t('ln_dup'))) return;
    const file = g('file').files[0];
    if(file){ const er = LoanDrive.validate(file); if(er) return this.formErr(er); if(!this.s.cfg.rootFolderId) return this.formErr('ln_err_nofolder'); }
    this._saving = true; const btn = $('pfSave'); if(btn) btn.disabled = true;
    try{
      if(file){
        this.formErr(t('ln_uploading'));
        try{ Object.assign(rec, await this.uploadReceipt(rec, file)); }
        catch(e){ if(!confirm(t('ln_upload_failed',{msg:this.errMsg(e)}))){ return; } }
      }
      this.savePayment(rec, !edit); App.closeModal(); toast(t('ln_saved'));
    } finally { this._saving = false; if(btn) btn.disabled = false; }
  },

  /* ---------- receipts ---------- */
  async uploadReceipt(rec, file){
    const er = LoanDrive.validate(file); if(er) throw new Error(er);
    const c = this.s.cfg;
    const n = this.s.payments.filter(p=>p.period===rec.period && p.type===rec.type && p.id!==rec.id && (p.receiptFileId||p.receiptLink)).length + 1;
    const name = LoanDrive.fileName(rec, file, n); let meta;
    for(let attempt=0; attempt<2; attempt++){
      try{ const folder = await LoanDrive.folderFor(c, rec.period); meta = await LoanDrive.upload(folder, file, name); break; }
      catch(e){ if(attempt===0 && /not found|404/i.test(e.message||'')){ delete c.monthFolders[rec.period]; continue; } throw e; }
    }
    this.save();
    return {receiptFileId:meta.id, receiptName:meta.name, receiptLink:meta.link};
  },
  attachReceipt(id){
    const p = this.s.payments.find(x=>x.id===id); if(!p) return;
    if(!this.s.cfg.rootFolderId){ toast(t('ln_err_nofolder')); return; }
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,.jpg,.jpeg,.png,.webp';
    inp.onchange = async ()=>{
      const f = inp.files[0]; if(!f || this._saving) return; this._saving = true; toast(t('ln_uploading'));
      try{ const r = await this.uploadReceipt(p, f); this.savePayment(Object.assign({}, this.s.payments.find(x=>x.id===id), r), false); toast(t('ln_receipt_saved')); this.openDetail(id); }
      catch(e){ toast(this.errMsg(e)); } finally { this._saving = false; }
    };
    inp.click();
  },
  removeReceipt(id){
    if(!confirm(t('ln_confirm_remove_receipt'))) return;      // the Drive file is kept (retention policy: never delete automatically)
    const p = this.s.payments.find(x=>x.id===id); if(!p) return;
    this.savePayment(Object.assign({}, p, {receiptFileId:'', receiptName:'', receiptLink:''}), false); this.openDetail(id);
  },
  linkOf(p){ return p.receiptLink || (p.receiptFileId ? 'https://drive.google.com/file/d/'+p.receiptFileId+'/view' : ''); },
  async previewReceipt(id){
    const p = this.s.payments.find(x=>x.id===id); if(!p) return; const link = this.linkOf(p); if(!link) return;
    const isImg = /\.(png|jpe?g|webp)$/i.test(p.receiptName||'') && p.receiptFileId;
    if(!isImg){ window.open(link, '_blank', 'noopener'); return; }
    try{
      const b = await LoanDrive.blob(p.receiptFileId); this.onModalClose(); this._blobUrl = URL.createObjectURL(b);
      this.openModal(`<div class="modal-handle"></div><img class="ln-img" src="${this._blobUrl}" alt="${esc(p.receiptName||'')}"><div class="ln-row-actions"><a class="btn btn-ghost" href="${esc(link)}" target="_blank" rel="noopener">${t('ln_open_drive')}</a><button class="btn btn-primary" data-id="${esc(id)}" onclick="Loan.openDetail(this.dataset.id)">${t('ln_close')}</button></div>`);
    }catch(e){
      this.openModal(`<div class="modal-handle"></div><p class="ln-note">${t('ln_preview_fail')}</p><div class="ln-row-actions"><a class="btn btn-primary" href="${esc(link)}" target="_blank" rel="noopener">${t('ln_open_drive')}</a></div>`);
    }
  },
  async downloadReceipt(id){
    const p = this.s.payments.find(x=>x.id===id); if(!p) return;
    try{ const b = await LoanDrive.blob(p.receiptFileId); this.download(p.receiptName || 'receipt', b); }
    catch(e){ const l = this.linkOf(p); if(l) window.open(l, '_blank', 'noopener'); }
  },
  uploadDoc(){
    if(!this.s.cfg.rootFolderId){ toast(t('ln_err_nofolder')); return; }
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,.jpg,.jpeg,.png,.webp';
    inp.onchange = async ()=>{
      const f = inp.files[0]; if(!f || this._saving) return; const er = LoanDrive.validate(f); if(er){ toast(t(er)); return; }
      this._saving = true; toast(t('ln_uploading'));
      try{
        const folder = await LoanDrive.docsFolder(this.s.cfg), meta = await LoanDrive.upload(folder, f, f.name);
        const doc = {id:'doc_'+LU.uid8(), fileId:meta.id, name:meta.name, type:meta.mimeType, size:meta.size, uploadedAt:LU.nowISO(), link:meta.link, notes:''};
        LoanQ.put({type:'doc', doc}); this.s.docs.push(doc); this.save(); this.render(); this.schedule(); toast(t('ln_saved'));
      }catch(e){ toast(this.errMsg(e)); } finally { this._saving = false; }
    };
    inp.click();
  },
  removeDoc(id){
    if(!confirm(t('ln_confirm_remove_receipt'))) return;
    LoanQ.drop(o=>o.type==='doc' && o.doc.id===id); LoanQ.put({type:'doc-remove', id});
    this.s.docs = this.s.docs.filter(d=>d.id!==id); this.save(); this.render(); this.schedule();
  },

  /* ---------- settings actions ---------- */
  setCalc(v){ this.s.cfg.calcMode = v; this.s.cfg.linkSaved = false; this.save(); this.render(); this.trySaveLink(); },
  setPattern(v){ this.s.cfg.monthPattern = v.trim() || '{MM} - {YYYY}'; this.s.cfg.linkSaved = false; this.save(); this.trySaveLink(); },
  setTheme(v){ LoanTheme.set(v); },
  async testConnection(){
    try{ if(!(await Auth.ensureFreshToken())) throw new Error('auth_expired'); await LoanSheet.connectionTest(this.s.cfg); toast(t('ln_s_test_ok')); }
    catch(e){ toast(this.errMsg(e)); }
  },
  disconnect(){
    if(!confirm(t('ln_s_disconnect_confirm'))) return;
    this.backup('before-disconnect'); localStorage.removeItem(LOAN_CACHE_KEY); LoanQ.set([]); this.init(); this.render();
  },
  goFilter(k, v){ this.ui.fStatus=''; this.ui.fReceipt=''; this.ui.fKind=''; this.ui[k]=v; Shell.go('loan','history'); },
  show(tab){ this.ui.tab = tab; this.render(); this.maybeSync(); },        // called by the shell for the loan module's bottom-nav tabs
  setSub(tab, sub){ this.ui.sub[tab] = sub; this.render(); },
};

/* ======================================================================
   SCREENS
   ====================================================================== */
Object.assign(Loan, {
  subsFor(tab){ return {home:[['overview','ln_tab_overview'],['analytics','ln_tab_analytics']], details:[['loan','ln_nav_details'],['settings','ln_tab_settings']]}[tab] || null; },
  render(){
    const root = $('loanRoot'); if(!root) return;
    const tab = this.ui.tab, subs = this.subsFor(tab), cur = this.ui.sub[tab];
    root.innerHTML = `<div id="lnHeadWrap">${this.headHTML()}</div>`
      + (subs ? `<div class="seg sm" role="tablist" style="margin:0 0 12px">${subs.map(x=>`<button role="tab" aria-selected="${cur===x[0]}" class="${cur===x[0]?'active':''}" onclick="Loan.setSub('${tab}','${x[0]}')">${t(x[1])}</button>`).join('')}</div>` : '')
      + `<div id="lnBody"></div>`;
    this.renderBody();
    if(typeof Shell!=='undefined'){ Shell.renderHeader(); this.paintPill(); }   // loan name + status in the app header
  },
  // The header pill (same element and place as Building's) shows the loan tracker's status while Loans is open.
  paintPill(){
    if(typeof Shell==='undefined' || Shell.current!=='loan') return;
    const st = this.status(), dot = $('syncDot'), txt = $('syncText'); if(!dot || !txt) return;
    dot.className = 'dot ' + ({synced:'green',syncing:'sync',pending:'sync',failed:'red',offline:'offline',idle:'offline'}[st]);
    txt.textContent = t('ln_st_'+st);
  },
  pillTap(){ if(!Auth.signedIn){ App.onSyncPillTap(); return; } this.syncNow(); },
  renderBody(){
    const b = $('lnBody'); if(!b) return;
    const tab = this.ui.tab; let h;
    if(!this.ready() && tab!=='details') h = this.setupHTML();            // nothing to show until the tracker is set up
    else if(tab==='home') h = this.ui.sub.home==='analytics' ? this.view_analytics() : this.view_overview();
    else if(tab==='details') h = this.ui.sub.details==='settings' ? this.view_settings() : this.view_loan();
    else if(tab==='payments') h = this.view_schedule();
    else if(tab==='history') h = this.view_history();
    else h = this.view_docs();
    b.innerHTML = h;
    if(tab==='history' && this.ready()) this.renderList();
  },
  headHTML(){
    const last = this.s.meta.lastSync ? new Date(this.s.meta.lastSync).toLocaleString(Lang.cur==='ar'?'ar-SA-u-ca-gregory-nu-latn':'en-GB') : t('ln_never');
    let h = `<div class="ln-head"><span class="ln-sub">${t('ln_last_sync')}: ${last}</span></div>`;
    if(this.emptyGuard) h += `<div class="banner"><b>${t('ln_eg_title')}</b><br>${t('ln_eg_desc',{n:this.emptyGuard})}<div class="ln-row-actions"><button class="btn btn-primary btn-sm" onclick="Loan.resolveEmpty('restore')">${t('ln_eg_restore')}</button><button class="btn btn-ghost btn-sm" onclick="Loan.resolveEmpty('accept')">${t('ln_eg_accept')}</button></div></div>`;
    else if(this.s.meta.stale && (this.s.payments.length || this.s.loan)) h += `<div class="banner">${t('ln_stale',{msg: esc(this.lastError||'')})}</div>`;
    if(this.conflicts.length) h += `<div class="banner"><b>${t('ln_cf_title')}</b> (${this.conflicts.length})<div class="ln-row-actions"><button class="btn btn-primary btn-sm" onclick="Loan.showConflict(Loan.conflicts[0])">${t('ln_cf_resolve')}</button></div></div>`;
    return h;
  },
  F(c){ return LU.fmt(c, (this.s.loan||{}).currency); },

  /* ----- overview ----- */
  view_overview(){
    if(!this.ready()) return this.setupHTML();
    const m = this.metrics(), F = c=>LU.fmt(c, m.cur), est = (m.mode==='A' || m.unallocated>0);
    const tag = `<span class="ln-tag">${t(est?'ln_estimate':'ln_confirmed')}</span>`;
    const card = (label, val, sub, extra, cls) => `<div class="stat ln-s ${cls||''}"><div class="label">${label}${extra||''}</div><div class="value">${val}</div>${sub?`<div class="ln-sub">${sub}</div>`:''}</div>`;
    let h = '';
    if(m.complete) h += `<div class="card" style="border-color:var(--moss)"><b>✓ ${t('ln_complete')}</b><div class="ln-sub">${t('ln_complete_sub')}</div></div>`;
    const alert = (n, key, k, v) => n ? `<div class="banner" style="cursor:pointer" onclick="Loan.goFilter('${k}','${v}')">${t(key,{n})} ›</div>` : '';
    h += alert(m.overdue.length,'ln_alert_overdue','fStatus','overdue') + alert(m.partial.length,'ln_alert_partial','fStatus','partial') + alert(m.missingReceipts.length,'ln_alert_missing','fReceipt','without');
    if(this.s.skipped) h += `<div class="ln-note">${t('ln_skipped',{n:this.s.skipped})}</div>`;
    h += `<div class="card"><div style="text-align:center">${LoanChart.ring(m.progress)}</div><div class="progress-track" style="margin-top:12px"><div class="progress-fill" style="width:${m.progress}%"></div></div>
      <div class="ln-sub" style="margin-top:8px;text-align:center">${t('ln_c_progress')} ${tag}${m.term?` · ${t('ln_c_inst_paid')}: ${t('ln_of_term',{n:m.installmentsPaid, term:m.term})}`:''}</div></div>`;
    const nextVal = m.next ? prettyDate(m.next.dueDate) : t('ln_none_due');
    const nextSub = m.next ? F(m.next.remainingDue || m.monthly) : '';
    h += `<div class="stat-grid">`
      + card(t('ln_c_original'), F(m.orig))
      + card(t('ln_c_paid'), F(m.totalPaid), `${m.confirmedCount}`)
      + card(t('ln_c_principal'), F(m.principalRepaid), '', tag)
      + card(t('ln_c_remaining'), F(m.remaining), '', tag, 'warn')
      + card(t('ln_c_progress'), m.progress.toFixed(2)+'%', '', tag)
      + card(t('ln_c_inst_paid'), String(m.installmentsPaid), m.term ? t('ln_of_term',{n:m.installmentsPaid, term:m.term}) : (m.remainingInstallments!=null ? t('ln_est_left',{n:m.remainingInstallments}) : ''))
      + card(t('ln_c_next'), nextVal, nextSub)
      + card(t('ln_c_outstanding'), String(m.outstanding))
      + card(t('ln_c_month'), F(m.thisMonth)) + card(t('ln_c_year'), F(m.thisYear)) + `</div>`;
    h += `<div class="ln-note">${m.mode==='A' ? t('ln_note_a') : t('ln_note_b',{n:m.unallocated})}</div>`;
    if(m.payoffDate && !m.complete) h += `<div class="card"><div class="ln-sub">${t('ln_payoff')} ${m.remainingEstimated?`<span class="ln-tag">${t('ln_estimate')}</span>`:''}</div><div class="serif" style="font-size:18px;font-weight:600">${prettyDate(m.payoffDate)}</div><div class="ln-sub">${t('ln_payoff_note')}</div></div>`;
    const row = x => `<div class="apt-row" data-id="${esc(x.id)}" onclick="Loan.openDetail(this.dataset.id)" style="cursor:pointer"><div class="apt-check paid">✓</div><div class="apt-body"><div class="apt-name">${monthName(x.period)}</div><div class="apt-meta">${x.paymentDate?prettyDate(x.paymentDate):''} ${(x.receiptFileId||x.receiptLink)?'<span class="ln-chip">📎</span>':`<span class="ln-chip warn">${t('ln_receipt_missing')}</span>`}</div></div><div class="apt-amount">${F(LU.toCents(x.amountPaid))}</div></div>`;
    h += `<div class="section-title">${t('ln_recent')}</div>` + (m.recent.length ? m.recent.map(row).join('') : `<div class="empty">${t('ln_nothing')}</div>`);
    const up = m.periods.filter(x=>x.status==='pending'||x.status==='overdue'||x.status==='partial').slice(0,3);
    h += `<div class="section-title">${t('ln_upcoming')}</div>` + (m.complete||!up.length ? `<div class="empty">${t('ln_nothing')}</div>` : up.map(x=>`<div class="apt-row" data-period="${x.period}" onclick="Loan.openPaymentForm('',this.dataset.period)" style="cursor:pointer"><div class="apt-check"></div><div class="apt-body"><div class="apt-name">${monthName(x.period)}</div><div class="apt-meta"><span class="badge ${x.status}">${t('ln_status_'+x.status)}</span> ${prettyDate(x.dueDate)}</div></div><div class="apt-amount">${F(x.remainingDue||x.dueC)}</div></div>`).join(''));
    return h;
  },
  setupHTML(){
    const c = this.s.cfg, inf = this.s.inferred, signed = Auth.signedIn, keys = LoanPicker.keysReady();
    const step = (ok, title, desc, btn) => `<div class="ln-step"><div class="ic ${ok?'ok':''}">${ok?'✓':''}</div><div class="bd"><div class="tt">${title}</div><div class="ds">${desc}</div>${btn||''}</div></div>`;
    const b = (label, fn, dis, primary) => `<button class="btn ${primary?'btn-primary':'btn-ghost'} btn-sm" style="margin-top:8px" ${dis?'disabled':''} onclick="${fn}">${label}</button>`;
    let h = `<div class="card"><h2 class="serif" style="margin:0 0 6px">${t('ln_setup_title')}</h2><p class="ln-note">${t('ln_setup_intro')}</p>`;
    h += step(signed, t('ln_step_google'), signed ? esc(Auth.email||t('ln_connected')) : t('ln_need_signin'), signed ? '' : b(t('google_connect'), 'Auth.signIn()', false, true));
    const foundTxt = c.ledgerTab && inf ? t('ln_found_tab',{tab:esc(c.ledgerTab), n:inf.count}) + (inf.origC!=null ? '<br>'+t('ln_found_infer',{paid:LU.fmt(inf.paidC), orig:LU.fmt(inf.origC)}) : '') : (c.spreadsheetName ? esc(c.spreadsheetName) : t('ln_no_sheet'));
    h += step(!!c.ledgerTab, t('ln_step_sheet'), (keys ? '' : t('ln_need_keys')+'<br>') + foundTxt, b(t(c.ledgerTab?'ln_change':'ln_pick_sheet'), 'Loan.pickSpreadsheet()', !signed||!keys, !c.ledgerTab));
    h += step(!!c.rootFolderId, t('ln_step_folder'), c.rootFolderId ? esc(c.rootFolderName) : t('ln_folder_optional'), b(t(c.rootFolderId?'ln_change':'ln_pick_folder'), 'Loan.pickFolder()', !signed||!keys||!c.ledgerTab)
      + (c.rootFolderId ? '<div class="ds" style="margin-top:6px">'+t('ln_years_hint')+'</div>'+b(t('ln_pick_years'), 'Loan.pickYears()', false) : ''));
    h += step(false, t('ln_step_loan'), '', '');
    h += `</div>`;
    if(this.setupErr) h += `<div class="banner">${esc(this.setupErr)}</div>`;
    if(c.ledgerTab) h += this.loanFormHTML();
    return h;
  },
  loanFormHTML(){
    const l = this.s.loan, inf = this.s.inferred || {}, fld = (label, inner, hint) => `<label class="field"><span>${label}</span>${inner}${hint?`<span class="ln-sub">${hint}</span>`:''}</label>`;
    const v = l || {name:'Mortgage', originalAmount: inf.origC!=null ? inf.origC/100 : '', currency:'SAR', startDate: inf.firstPeriod ? inf.firstPeriod+'-01' : '', firstInstallmentDate: inf.firstPeriod ? inf.firstPeriod+'-01' : '',
      monthlyInstallment: inf.monthlyC ? inf.monthlyC/100 : '', rate:'', method:'', termMonths:'', expectedEndDate:'', extraFees:'', notes:''};
    const inp = (id, val, type, extra) => `<input type="${type||'text'}" id="${id}" ${type==='number'||type==='date'?'dir="ltr"':'dir="auto"'} ${type==='number'?'step="0.01" min="0"':''} value="${esc(val==null?'':val)}" ${extra||''}>`;
    return `<div class="card" id="lnForm"><div class="section-title" style="margin-top:0">${t('ln_step_loan')}</div>
      ${fld(t('ln_l_name'), inp('lf_name', v.name))}
      <div class="ln-grid2">${fld(t('ln_l_amount'), inp('lf_amount', v.originalAmount, 'number'))}${fld(t('ln_l_currency'), inp('lf_cur', v.currency))}</div>
      <div class="ln-grid2">${fld(t('ln_l_start'), inp('lf_start', v.startDate, 'date'))}${fld(t('ln_l_first'), inp('lf_first', v.firstInstallmentDate, 'date'))}</div>
      <div class="ln-grid2">${fld(t('ln_l_monthly'), inp('lf_monthly', v.monthlyInstallment, 'number'))}${fld(t('ln_l_freq'), `<select id="lf_freq" disabled><option>${t('ln_l_freq_m')}</option></select>`)}</div>
      <div class="ln-grid2">${fld(t('ln_l_term'), inp('lf_term', v.termMonths, 'number'))}${fld('&nbsp;', `<select id="lf_unit"><option value="months">${t('ln_l_months')}</option><option value="years">${t('ln_l_years')}</option></select>`)}</div>
      ${fld(t('ln_l_rate'), inp('lf_rate', v.rate, 'number'), t('ln_l_rate_hint'))}
      ${fld(t('ln_l_method'), inp('lf_method', v.method))}
      ${fld(t('ln_l_end'), inp('lf_end', v.expectedEndDate, 'date'))}
      ${fld(t('ln_l_fees'), inp('lf_fees', v.extraFees, 'number'))}
      ${fld(t('ln_l_notes'), `<textarea id="lf_notes" dir="auto">${esc(v.notes||'')}</textarea>`)}
      <div class="ln-note">${t('ln_l_saved_note')}</div><div class="ln-err" id="lfErr"></div>
      <button class="btn btn-primary btn-block" ${this.setupBusy?'disabled':''} onclick="Loan.saveLoan()">${this.setupBusy ? t('ln_working') : t(this.ready()?'ln_save':'ln_save_init')}</button></div>`;
  },
  view_loan(){ return this.ready() ? this.loanFormHTML() : this.setupHTML(); },

  /* ----- payments list ----- */
  items(){
    const m = this.metrics(), today = LU.today(), out = [];
    this.s.payments.forEach(p=>{
      const per = p.type!=='extra' ? m.periods.find(x=>x.period===p.period) : null, conf = LoanCalc.isConfirmed(p);
      let st = p.status; if(conf && per) st = per.status==='paid' ? 'paid' : (per.status==='partial' ? 'partial' : st);
      if(st==='pending' && p.dueDate && p.dueDate<today) st = 'overdue';
      out.push({kind:'rec', id:p.id, p, period:p.period, status:st, due:LU.toCents(p.amountDue), paid:LU.toCents(p.amountPaid), remaining:per?per.remainingDue:0, date:LoanCalc.effDate(p), receipt:!!(p.receiptFileId||p.receiptLink), confirmed:conf, extra:p.type==='extra'});
    });
    if(!m.complete) m.periods.forEach(x=>{ if(!x.recs && (x.status==='pending'||x.status==='overdue')) out.push({kind:'sched', id:'', period:x.period, status:x.status, due:x.dueC, paid:0, remaining:x.remainingDue, date:x.dueDate, receipt:false, confirmed:false, extra:false}); });
    return out;
  },
  view_history(){
    const all = this.items(), years = [...new Set(all.map(i=>(i.period||'').slice(0,4)).filter(Boolean))].sort().reverse(), u = this.ui;
    const sel = (k, opts) => `<select aria-label="${k}" onchange="Loan.onFilter('${k}',this.value)">${opts.map(o=>`<option value="${o[0]}" ${String(u[k])===String(o[0])?'selected':''}>${o[1]}</option>`).join('')}</select>`;
    const months = [['',t('ln_f_month')]].concat(Array.from({length:12},(_,i)=>[LU.pad(i+1), new Date(2000,i,1).toLocaleString(Lang.cur==='ar'?'ar-SA-u-ca-gregory-nu-latn':'en-GB',{month:'long'})]));
    return `<button class="btn btn-primary btn-block" onclick="Loan.openPaymentForm()">${t('ln_add_payment')}</button>
      <input type="text" class="ln-search" id="lnQ" dir="auto" style="margin-top:10px" placeholder="${t('ln_search')}" value="${esc(u.q)}" oninput="Loan.onFilter('q',this.value)">
      <div class="ln-filters">${sel('fYear',[['',t('ln_f_year')]].concat(years.map(y=>[y,y])))}${sel('fMonth',months)}${sel('fStatus',[['',t('ln_f_status')]].concat(LOAN_STATUSES.map(s=>[s,t('ln_status_'+s)])))}
        ${sel('fReceipt',[['',t('ln_f_receipt')],['with',t('ln_f_with')],['without',t('ln_f_without')]])}${sel('fKind',[['',t('ln_f_kind')],['partial',t('ln_f_partial')],['extra',t('ln_f_extra')]])}
        ${sel('sort',[['date-desc',t('ln_sort_date_desc')],['date-asc',t('ln_sort_date_asc')],['amt-desc',t('ln_sort_amt_desc')],['amt-asc',t('ln_sort_amt_asc')],['status',t('ln_sort_status')]])}</div>
      <div class="ln-sub" id="lnSum" style="margin-bottom:8px"></div><div id="lnList"></div>`;
  },
  onFilter(k, v){ this.ui[k] = v; this.renderList(); },
  /* ----- Payments: one row per installment month, chronological ----- */
  view_schedule(){
    const m = this.metrics(), F = c=>LU.fmt(c, m.cur), u = this.ui, curYear = LU.today().slice(0,4);
    const years = [...new Set(m.periods.map(x=>x.period.slice(0,4)))].sort().reverse();
    if(u.sYear==='') u.sYear = years.includes(curYear) ? curYear : 'all';
    const row = x => `<div class="apt-row" data-period="${x.period}" onclick="Loan.openPeriod(this.dataset.period)" style="cursor:pointer"><div class="apt-check ${x.status==='paid'?'paid':''}">${x.status==='paid'?'✓':''}</div>
      <div class="apt-body"><div class="apt-name">${monthName(x.period)}</div><div class="apt-meta"><span class="badge ${x.status}">${t('ln_status_'+x.status)}</span><span>${t('ln_sched_due')} ${prettyDate(x.dueDate)}</span></div>
      ${x.status!=='pending'&&x.status!=='cancelled'?`<div class="ln-sub">${t('ln_sched_paid')} ${F(x.credited)}${x.remainingDue?` · ${t('ln_sched_left')} ${F(x.remainingDue)}`:''}</div>`:''}</div><div class="apt-amount">${F(x.dueC)}</div></div>`;
    const attn = m.periods.filter(x=>x.status==='overdue'||x.status==='partial');
    const up = m.complete ? [] : m.periods.filter(x=>x.status==='pending').slice(0,3);
    const all = m.periods.filter(x=>(u.sYear==='all'||x.period.startsWith(u.sYear)) && (!u.sUnpaid || x.status!=='paid'));
    let h = `<button class="btn btn-primary btn-block" onclick="Loan.openPaymentForm()">${t('ln_add_payment')}</button>`;
    if(attn.length) h += `<div class="section-title">${t('ln_sched_attention')}</div>` + attn.map(row).join('');
    if(up.length) h += `<div class="section-title">${t('ln_upcoming')}</div>` + up.map(row).join('');
    h += `<div class="section-title">${t('ln_sched_all')}</div><div class="ln-filters">
      <select aria-label="${t('ln_f_year')}" onchange="Loan.onSched('sYear',this.value)"><option value="all" ${u.sYear==='all'?'selected':''}>${t('ln_f_all')}</option>${years.map(y=>`<option value="${y}" ${u.sYear===y?'selected':''}>${y}</option>`).join('')}</select>
      <select aria-label="${t('ln_f_status')}" onchange="Loan.onSched('sUnpaid',this.value==='1')"><option value="0" ${!u.sUnpaid?'selected':''}>${t('ln_f_all')}</option><option value="1" ${u.sUnpaid?'selected':''}>${t('ln_sched_unpaid')}</option></select></div>`;
    h += all.length ? all.map(row).join('') : `<div class="empty">${t('ln_sched_empty')}</div>`;
    return h;
  },
  onSched(k, v){ this.ui[k] = v; this.renderBody(); },
  openPeriod(period){
    const m = this.metrics(), x = m.periods.find(p=>p.period===period); if(!x){ this.openPaymentForm('', period); return; }
    const F = c=>LU.fmt(c, m.cur), kv = (k,v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const tx = this.s.payments.filter(p=>p.period===period && p.type!=='extra').sort((a,b)=>(a.paymentDate||'').localeCompare(b.paymentDate||''));
    this.openModal(`<div class="modal-handle"></div><h2 class="serif">${monthName(period)}</h2>
      ${kv(t('ln_f_status'), `<span class="badge ${x.status}">${t('ln_status_'+x.status)}</span>`)}${kv(t('ln_f_due'), prettyDate(x.dueDate))}${kv(t('ln_f_amount_due'), F(x.dueC))}${kv(t('ln_sched_paid'), F(x.credited))}${kv(t('ln_detail_remaining'), F(x.remainingDue))}
      <div class="section-title">${t('ln_period_tx')}</div>
      ${tx.length ? tx.map(p=>`<div class="apt-row" data-id="${esc(p.id)}" onclick="Loan.openDetail(this.dataset.id)" style="cursor:pointer"><div class="apt-body"><div class="apt-name">${F(LU.toCents(p.amountPaid))}</div><div class="apt-meta"><span class="badge ${p.status}">${t('ln_status_'+p.status)}</span>${p.paymentDate?prettyDate(p.paymentDate):''}</div></div></div>`).join('') : `<div class="ln-note">${t('ln_period_none')}</div>`}
      <button class="btn btn-primary btn-block" style="margin-top:12px" data-period="${period}" onclick="Loan.openPaymentForm('',this.dataset.period)">${t('ln_period_add')}</button>
      <button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="App.closeModal()">${t('ln_close')}</button>`);
  },
  renderList(){
    const u = this.ui, q = (u.q||'').toLowerCase().trim(), order = {overdue:0, partial:1, pending:2, paid:3, cancelled:4};
    let list = this.items().filter(i=>{
      if(u.fYear && !i.period.startsWith(u.fYear)) return false;
      if(u.fMonth && i.period.slice(5,7)!==u.fMonth) return false;
      if(u.fStatus && i.status!==u.fStatus) return false;
      if(u.fReceipt==='with' && !i.receipt) return false;
      if(u.fReceipt==='without' && !(i.kind==='rec' && i.confirmed && !i.receipt)) return false;
      if(u.fKind==='partial' && i.status!=='partial') return false;
      if(u.fKind==='extra' && !i.extra) return false;
      if(q){ const p = i.p||{}; const hay = [monthName(i.period), LU.periodLabel(i.period), p.reference, p.notes, LU.fmtNum(i.paid), LU.fmtNum(i.due), t('ln_status_'+i.status)].join(' ').toLowerCase(); if(!hay.includes(q)) return false; }
      return true;
    });
    const sorters = {'date-desc':(a,b)=>(b.date+b.period).localeCompare(a.date+a.period), 'date-asc':(a,b)=>(a.date+a.period).localeCompare(b.date+b.period), 'amt-desc':(a,b)=>(b.paid||b.due)-(a.paid||a.due), 'amt-asc':(a,b)=>(a.paid||a.due)-(b.paid||b.due), 'status':(a,b)=>order[a.status]-order[b.status]};
    list.sort(sorters[u.sort] || sorters['date-desc']);
    const sum = list.filter(i=>i.confirmed).reduce((a,i)=>a+i.paid,0), el = $('lnList'), s = $('lnSum'); if(!el) return;
    s.textContent = t('ln_results',{n:list.length, sum:this.F(sum)});
    el.innerHTML = list.length ? list.map(i=>this.rowHTML(i)).join('') : `<div class="empty">${t('ln_empty_payments')}</div>`;
  },
  rowHTML(it){
    const badge = `<span class="badge ${it.status}">${t('ln_status_'+it.status)}</span>`;
    const chip = it.kind==='rec' && it.confirmed ? (it.receipt ? `<span class="ln-chip">📎 ${t('ln_receipt_has')}</span>` : `<span class="ln-chip warn">${t('ln_receipt_missing')}</span>`) : '';
    const act = it.kind==='rec' ? `data-id="${esc(it.id)}" onclick="Loan.openDetail(this.dataset.id)"` : `data-period="${it.period}" onclick="Loan.openPaymentForm('',this.dataset.period)"`;
    return `<div class="apt-row" ${act} style="cursor:pointer"><div class="apt-check ${it.status==='paid'?'paid':''}">${it.status==='paid'?'✓':''}</div><div class="apt-body"><div class="apt-name">${monthName(it.period)}</div>
      <div class="apt-meta">${badge}${it.extra?` <span class="ln-chip">${t('ln_extra')}</span>`:''} ${chip}<span>${it.date?prettyDate(it.date):''}</span></div></div><div class="apt-amount">${this.F(it.kind==='rec' && it.paid>0 ? it.paid : it.due)}</div></div>`;
  },
  openDetail(id){
    const it = this.items().find(x=>x.id===id); if(!it) return; const p = it.p, kv = (k,v) => `<div class="kv"><span class="k">${k}</span><span class="v" style="text-align:end;word-break:break-word">${v}</span></div>`;
    const has = !!(p.receiptFileId||p.receiptLink);
    const rec = has ? `${kv(t('ln_f_file').split(' (')[0], '📎 '+esc(p.receiptName||'receipt'))}<div class="ln-row-actions"><button class="btn btn-ghost btn-sm" data-id="${esc(id)}" onclick="Loan.previewReceipt(this.dataset.id)">${t('ln_view')}</button><button class="btn btn-ghost btn-sm" data-id="${esc(id)}" onclick="Loan.downloadReceipt(this.dataset.id)">${t('ln_download')}</button><button class="btn btn-ghost btn-sm" data-id="${esc(id)}" onclick="Loan.attachReceipt(this.dataset.id)">${t('ln_replace')}</button><button class="btn btn-danger btn-sm" data-id="${esc(id)}" onclick="Loan.removeReceipt(this.dataset.id)">${t('ln_remove')}</button></div>`
      : `${kv(t('ln_f_receipt'), `<span class="ln-chip warn">${t('ln_receipt_missing')}</span>`)}<div class="ln-row-actions"><button class="btn btn-primary btn-sm" data-id="${esc(id)}" onclick="Loan.attachReceipt(this.dataset.id)">${t('ln_attach')}</button></div>`;
    this.openModal(`<div class="modal-handle"></div><h2 class="serif">${monthName(p.period)}</h2>
      ${kv(t('ln_f_status'), `<span class="badge ${it.status}">${t('ln_status_'+it.status)}</span>`)}${kv(t('ln_f_type'), t(p.type==='extra'?'ln_type_extra':'ln_type_inst'))}
      ${kv(t('ln_f_due'), p.dueDate?prettyDate(p.dueDate):'—')}${kv(t('ln_f_paydate'), p.paymentDate?prettyDate(p.paymentDate):'—')}
      ${kv(t('ln_f_amount_due'), this.F(it.due))}${kv(t('ln_f_amount_paid'), this.F(it.paid))}${it.kind==='rec'&&!it.extra?kv(t('ln_detail_remaining'), this.F(it.remaining)):''}
      ${p.principal!==''?kv(t('ln_f_principal'), this.F(LU.toCents(p.principal))):''}${p.interest!==''?kv(t('ln_f_interest'), this.F(LU.toCents(p.interest))):''}${p.fees!==''?kv(t('ln_f_fees'), this.F(LU.toCents(p.fees))):''}
      ${p.reference?kv(t('ln_f_ref'), esc(p.reference)):''}${p.notes?kv(t('ln_f_notes'), esc(p.notes)):''}
      ${kv(t('ln_created'), p.createdAt?esc(p.createdAt.slice(0,10)):'—')}${kv(t('ln_updated'), p.updatedAt?esc(p.updatedAt.slice(0,10)):'—')}${kv(t('ln_id'), `<span class="ln-sub">${esc(p.id)}</span>`)}
      ${rec}
      <div class="ln-row-actions" style="margin-top:14px"><button class="btn btn-primary" data-id="${esc(id)}" onclick="Loan.openPaymentForm(this.dataset.id)">${t('ln_edit')}</button><button class="btn btn-danger" data-id="${esc(id)}" onclick="Loan.deletePayment(this.dataset.id)">${t('ln_delete')}</button></div>
      <button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="App.closeModal()">${t('ln_close')}</button>`);
  },

  /* ----- analytics ----- */
  view_analytics(){
    if(!this.ready()) return this.setupHTML();
    const m = this.metrics(), curP = LU.today().slice(0,7), card = (title, inner, legend) => `<div class="ln-chart"><h3>${title}</h3>${inner||`<div class="empty">${t('ln_no_data')}</div>`}${legend||''}</div>`;
    const lg = items => `<div class="ln-legend">${items.map(i=>`<span><span class="ln-sw" style="background:${i[0]}"></span>${i[1]}</span>`).join('')}</div>`;
    const last12 = Array.from({length:12}, (_,i)=>LU.addMonths(curP, i-11));
    const monthly = last12.map(p=>({label:LoanChart.lab(p), a:m.byMonth[p]||0}));
    const years = Object.keys(m.byYear).sort().map(y=>({label:y, a:m.byYear[y]}));
    const exp = m.periods.filter(x=>x.period<=curP && x.status!=='cancelled').slice(-12).map(x=>({label:LoanChart.lab(x.period), a:x.credited, b:x.dueC}));
    let cum = 0; const prin = Object.keys(m.principalByMonth).sort().map(p=>{ cum += m.principalByMonth[p]; return {label:LoanChart.lab(p), v:cum}; });
    const outstanding = m.outstanding, remInst = m.remainingInstallments!=null ? Math.max(0, m.remainingInstallments - outstanding) : 0;
    const counts = LoanChart.stack([{v:m.installmentsPaid, color:'var(--moss)'},{v:outstanding, color:'var(--clay)'},{v:remInst, color:'var(--paper-2)'}]);
    return card(t('ln_a_progress'), `<div style="text-align:center">${LoanChart.ring(m.progress)}</div>`, `<div class="ln-note" style="text-align:center">${m.mode==='A'?t('ln_estimate'):t('ln_confirmed')} · ${t('ln_hist')}</div>`)
      + card(t('ln_a_monthly'), LoanChart.bars(monthly,false))
      + card(t('ln_a_yearly'), LoanChart.bars(years,false))
      + card(t('ln_a_expected'), LoanChart.bars(exp,true), lg([['var(--paper-2)',t('ln_legend_expected')],['var(--moss)',t('ln_legend_actual')]]))
      + card(t('ln_a_counts'), counts, lg([['var(--moss)',t('ln_legend_paid')+' '+m.installmentsPaid],['var(--clay)',t('ln_legend_outstanding')+' '+outstanding],['var(--paper-2)',t('ln_legend_remaining')+' '+remInst]]))
      + card(t('ln_a_principal'), LoanChart.line(prin), `<div class="ln-note">${t('ln_hist')}</div>`)
      + card(t('ln_a_payoff'), m.payoffDate && !m.complete ? `<div class="serif" style="font-size:20px;font-weight:600">${prettyDate(m.payoffDate)}</div><div class="ln-note">${t('ln_proj')} — ${t('ln_payoff_note')}</div>` : (m.complete?`<b>✓ ${t('ln_complete')}</b>`:''));
  },

  /* ----- receipts & documents ----- */
  view_docs(){
    if(!this.ready()) return this.setupHTML();
    const m = this.metrics(), conf = this.s.payments.filter(p=>LoanCalc.isConfirmed(p)), missing = conf.filter(p=>!p.receiptFileId && !p.receiptLink), withR = conf.length - missing.length;
    let h = `<div class="card"><div class="section-title" style="margin-top:0">${t('ln_d_receipts')}</div><div class="ln-grid2"><div class="stat ln-s"><div class="label">${t('ln_receipt_has')}</div><div class="value">${withR}</div></div><div class="stat ln-s warn"><div class="label">${t('ln_receipt_missing')}</div><div class="value">${missing.length}</div></div></div>${missing.length?'':`<div class="ln-note">${t('ln_d_all_ok')}</div>`}</div>`;
    h += missing.sort((a,b)=>b.period.localeCompare(a.period)).slice(0,30).map(p=>`<div class="apt-row"><div class="apt-body"><div class="apt-name">${monthName(p.period)}</div><div class="apt-meta"><span class="ln-chip warn">${t('ln_receipt_missing')}</span></div></div><button class="btn btn-primary btn-sm" data-id="${esc(p.id)}" onclick="Loan.attachReceipt(this.dataset.id)">${t('ln_attach')}</button></div>`).join('');
    h += `<div class="section-title">${t('ln_d_docs')}<button class="btn btn-ghost btn-sm" onclick="Loan.uploadDoc()">${t('ln_d_upload_doc')}</button></div>`;
    h += this.s.docs.length ? this.s.docs.map(d=>`<div class="apt-row"><div class="apt-body"><div class="apt-name" style="word-break:break-word">${esc(d.name)}</div><div class="apt-meta">${esc((d.uploadedAt||'').slice(0,10))}</div></div><a class="btn btn-ghost btn-sm" href="${esc(d.link)}" target="_blank" rel="noopener">${t('ln_view')}</a><button class="icon-btn" aria-label="${t('ln_remove')}" data-id="${esc(d.id)}" onclick="Loan.removeDoc(this.dataset.id)">🗑</button></div>`).join('') : `<div class="empty">${t('ln_d_none')}</div>`;
    return h;
  },

  /* ----- settings & backup ----- */
  view_settings(){
    const c = this.s.cfg, th = LoanTheme.get(), snaps = (()=>{ try{ return JSON.parse(localStorage.getItem(LOAN_BACKUP_KEY)||'[]'); }catch(e){ return []; } })();
    const kv = (k,v) => `<div class="kv"><span class="k">${k}</span><span class="v" style="text-align:end;word-break:break-word">${v}</span></div>`;
    const sel = (opts, cur, fn) => `<select onchange="${fn}">${opts.map(o=>`<option value="${o[0]}" ${o[0]===cur?'selected':''}>${o[1]}</option>`).join('')}</select>`;
    let h = '';
    if(c.spreadsheetId) h += `<div class="card"><div class="section-title" style="margin-top:0">${t('ln_s_conn')}</div>
      ${kv(t('ln_s_sheet'), esc(c.spreadsheetName||c.spreadsheetId)+` <a class="linklike" href="https://docs.google.com/spreadsheets/d/${esc(c.spreadsheetId)}" target="_blank" rel="noopener">${t('ln_s_open')}</a>`)}${kv(t('ln_s_tab'), esc(c.ledgerTab))}
      ${kv(t('ln_s_folder'), c.rootFolderId ? esc(c.rootFolderName)+` <a class="linklike" href="https://drive.google.com/drive/folders/${esc(c.rootFolderId)}" target="_blank" rel="noopener">${t('ln_s_open')}</a>` : t('ln_no_sheet'))}
      <div class="ln-row-actions"><button class="btn btn-ghost btn-sm" onclick="Loan.pickSpreadsheet()">${t('ln_s_sheet')}: ${t('ln_change')}</button><button class="btn btn-ghost btn-sm" onclick="Loan.pickFolder()">${t('ln_s_folder')}: ${t('ln_change')}</button>${c.rootFolderId?`<button class="btn btn-ghost btn-sm" onclick="Loan.pickYears()">${t('ln_pick_years')}</button>`:''}</div>
      <label class="field" style="margin-top:12px"><span>${t('ln_s_pattern')}</span><input type="text" dir="ltr" value="${esc(c.monthPattern)}" onchange="Loan.setPattern(this.value)"><span class="ln-sub">${t('ln_s_pattern_hint')}</span></label></div>
      <div class="card"><div class="section-title" style="margin-top:0">${t('ln_s_calc')}</div>${sel([['auto',t('ln_s_calc_auto')],['simple',t('ln_s_calc_simple')]], c.calcMode, 'Loan.setCalc(this.value)')}<div class="ln-note">${t('ln_note_a')}</div></div>
      <div class="card"><div class="section-title" style="margin-top:0">${t('ln_s_sync')}</div>${kv(t('ln_last_sync'), this.s.meta.lastSync?esc(this.s.meta.lastSync.replace('T',' ').slice(0,16)):t('ln_never'))}${kv(t('ln_f_status'), t('ln_st_'+this.status()))}${kv('', t('ln_s_pending',{n:LoanQ.count()}))}
      <div class="ln-row-actions"><button class="btn btn-primary btn-sm" onclick="Loan.syncNow()">${t('ln_sync_now')}</button><button class="btn btn-ghost btn-sm" onclick="Loan.testConnection()">${t('ln_s_test')}</button></div></div>`;
    h += `<div class="card"><div class="section-title" style="margin-top:0">${t('ln_s_theme')}</div>${sel([['light',t('ln_s_light')],['dark',t('ln_s_dark')],['auto',t('ln_s_auto')]], th, 'Loan.setTheme(this.value)')}</div>
      <div class="card"><div class="section-title" style="margin-top:0">${t('ln_s_backup')}</div><div class="ln-row-actions"><button class="btn btn-ghost" onclick="Loan.exportJSON()">${t('ln_s_backup_json')}</button><button class="btn btn-ghost" onclick="Loan.restoreFile()">${t('ln_s_restore')}</button><button class="btn btn-ghost" onclick="Loan.exportCSV()">${t('ln_s_csv')}</button></div>
      <div class="ln-sub" style="margin-top:12px">${t('ln_s_snap')}: ${snaps.length ? snaps.map((s,i)=>`<a class="linklike" href="#" onclick="Loan.downloadSnap(${i});return false">${esc(s.at.slice(0,16).replace('T',' '))} (${esc(s.reason)})</a>`).join(' · ') : t('ln_s_snap_none')}</div></div>`;
    if(c.spreadsheetId) h += `<button class="btn btn-danger btn-block" onclick="Loan.disconnect()">${t('ln_s_disconnect')}</button>`;
    return h;
  },
  downloadSnap(i){ try{ const s = JSON.parse(localStorage.getItem(LOAN_BACKUP_KEY)||'[]')[i]; if(s) this.download('wifaq-loan-snapshot-'+s.at.slice(0,10)+'.json', JSON.stringify(s.data,null,2), 'application/json'); }catch(e){} },
});

/* ---------- start-up ---------- */
Loan.init();
if(typeof Shell !== 'undefined'){
  const ic = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${d}</svg>`;
  Shell.register({
    id:'loan', icon:'🏦', labelKey:'mod_loans', defaultTab:'home', chrome:{monthRow:false, syncPill:true},
    paintSync: () => Loan.paintPill(),
    onSyncTap: () => Loan.pillTap(),
    tabs:[
      {id:'home',     labelKey:'ln_nav_home',     svg:ic('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="11" width="8" height="10" rx="2"/><rect x="3" y="14" width="8" height="7" rx="2"/>')},
      {id:'details',  labelKey:'ln_nav_details',  svg:ic('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M9.5 20v-5.5h5V20"/>')},
      {id:'payments', labelKey:'ln_nav_payments', svg:ic('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>')},
      {id:'history',  labelKey:'ln_nav_history',  svg:ic('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v5l3 2"/>')},
      {id:'docs',     labelKey:'ln_nav_docs',     svg:ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>')},
    ],
    screenId: () => 'screen-loan',
    header: () => ({label:t('mod_loans'), name:(Loan.s.loan && Loan.s.loan.name) || t('ln_title')}),
    show: tab => Loan.show(tab),
  });
}
window.addEventListener('online', ()=>{ Loan.maybeSync(); Loan.paintPill(); });
window.addEventListener('offline', ()=>Loan.paintPill());
setInterval(()=>{ if(typeof Auth!=='undefined' && Auth.signedIn) Loan.maybeSync(); }, 120000);
