// دفتر الصندوق: the shop's daily till book for two branches, kept by Alaa and Yazan.
// People type the amounts; every sum, the box balance and profit/loss are computed here.
import { firebaseConfig } from "./firebase-config.js";

const $ = s => document.querySelector(s);
const APP_VERSION = "1";
const BRANCHES = ["b1", "b2"];
const DEFAULT_NAMES = { b1: "قديم", b2: "جديد" };
const WORKERS = ["w1", "w2", "w3"];
const IN = ["s1", "s2", "s3", "card"], OUT = ["back", "ware", "sonst"];

// ---------------------------------------------------------------- numbers

// typed as 1234,5 / 1.234,50 / 1234.5 → 1234.5 ; empty → null
function parseNum(s) {
  s = String(s ?? "").trim().replace(/\s|€/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const fmt = n => (n == null || n === 0) ? "" : n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const fmt0 = n => (n ?? 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const fmtIn = n => n == null ? "" : n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const v = x => (typeof x === "number" && Number.isFinite(x)) ? x : 0;

// number fields take digits and one decimal mark only; letters never get in
function numberField(input) {
  input.addEventListener("beforeinput", e => {
    if (e.inputType && e.inputType.startsWith("delete")) return;
    if (e.data == null) return;
    if (!/^[\d.,]+$/.test(e.data)) { e.preventDefault(); return; }
    const next = input.value.slice(0, input.selectionStart) + e.data + input.value.slice(input.selectionEnd);
    if ((next.match(/[.,]/g) || []).length > 1 && !/^\d{1,3}(\.\d{3})+(,\d{0,2})?$/.test(next)) e.preventDefault();
  });
  input.addEventListener("input", () => { const c = input.value.replace(/[^\d.,]/g, ""); if (c !== input.value) input.value = c; });
}

// ---------------------------------------------------------------- dates

const pad = n => String(n).padStart(2, "0");
const monthKey = (y, m) => y + "-" + pad(m);
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const arDay = new Intl.DateTimeFormat("ar-u-nu-latn", { weekday: "long", day: "numeric", month: "long" });
const arMonth = new Intl.DateTimeFormat("ar-u-nu-latn", { month: "long", year: "numeric" });
const arWeekday = new Intl.DateTimeFormat("ar-u-nu-latn", { weekday: "long" });
const arMonthOnly = new Intl.DateTimeFormat("ar-u-nu-latn", { month: "long" });

// ---------------------------------------------------------------- storage: Firebase, or this browser when not yet connected

let store;
async function makeStore() {
  if (!firebaseConfig.apiKey) {
    $("#demoBar").hidden = false;
    const read = k => { try { return JSON.parse(localStorage.getItem("kb-" + k) || "null"); } catch (e) { return null; } };
    const subs = {};
    const merge = (a, b) => { for (const [k, x] of Object.entries(b)) { if (x && typeof x === "object" && !Array.isArray(x)) a[k] = merge(a[k] && typeof a[k] === "object" ? a[k] : {}, x); else a[k] = x; } return a; };
    return {
      user: { email: "demo" },
      watch(k, cb) { (subs[k] = subs[k] || []).push(cb); cb(read(k)); return () => {}; },
      async get(k) { return read(k); },
      async write(k, patch) { const d = merge(read(k) || {}, patch); try { localStorage.setItem("kb-" + k, JSON.stringify(d)); } catch (e) {} (subs[k] || []).forEach(cb => cb(d)); },
      signOut() {},
    };
  }
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const A = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const F = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  const ref = k => { const [c, id] = k.split("/"); return F.doc(db, c, id); };
  const user = await new Promise(res => {
    const off = A.onAuthStateChanged(auth, u => { if (u) { off(); res(u); } else showLogin(); });
    $("#lGo").onclick = async () => {
      $("#lStatus").textContent = "";
      try { await A.signInWithEmailAndPassword(auth, $("#lEmail").value.trim(), $("#lPass").value); }
      catch (e) { $("#lStatus").textContent = "الإيميل أو كلمة المرور غير صحيحة"; }
    };
    $("#lPass").addEventListener("keydown", e => { if (e.key === "Enter") $("#lGo").click(); });
  });
  return {
    user,
    watch(k, cb) { return F.onSnapshot(ref(k), s => cb(s.exists() ? s.data() : null), e => status("تعذّر التحميل: " + e.message, true)); },
    async get(k) { const s = await F.getDoc(ref(k)); return s.exists() ? s.data() : null; },
    // merge: true merges nested maps, so two people editing different days never overwrite each other
    write(k, patch) { return F.setDoc(ref(k), Object.assign(patch, { updatedAt: new Date().toISOString(), by: user.email }), { merge: true }); },
    signOut() { return A.signOut(auth); },
  };
}
function showLogin() { $("#loginView").hidden = false; $("#appView").hidden = true; }
function status(t, warn) { const el = $("#status"); el.textContent = t || ""; el.classList.toggle("warn", !!warn); }

// ---------------------------------------------------------------- state

const now = new Date();
const S = { branch: "b1", y: now.getFullYear(), m: now.getMonth() + 1, doc: null, carry: null, names: { ...DEFAULT_NAMES }, unwatch: null };
try { const saved = JSON.parse(localStorage.getItem("kb-view") || "null"); if (saved && BRANCHES.includes(saved.branch)) S.branch = saved.branch; } catch (e) {}
const docKey = () => "months/" + S.branch + "_" + monthKey(S.y, S.m);

// a field path like "days.05.s1" → { days: { "05": { s1: value } } }
const nest = (path, value) => path.split(".").reduceRight((acc, k) => ({ [k]: acc }), value);
const timers = {};
function save(path, value) {
  // the month's first write also stores the workers carried over from last month
  if (!S.doc && S.carry) { store.write(docKey(), { workers: S.carry }); S.doc = { workers: S.carry }; }
  setLocal(path, value);
  clearTimeout(timers[path]);
  timers[path] = setTimeout(() => {
    delete timers[path];
    Promise.resolve(store.write(docKey(), nest(path, value))).catch(e => status("لم يُحفظ: " + (e && e.message || e), true));
  }, 450);
}
function setLocal(path, value) {
  S.doc = S.doc || {};
  const ks = path.split("."); let o = S.doc;
  ks.slice(0, -1).forEach(k => { o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}; o = o[k]; });
  o[ks[ks.length - 1]] = value;
}

// ---------------------------------------------------------------- calculations

function dayCalc(d) {
  d = d || {};
  const ges = IN.reduce((a, k) => a + v(d[k]), 0);
  const aus = OUT.reduce((a, k) => a + v(d[k]), 0);
  return { ges, aus, rest: ges - aus };
}
function monthCalc() {
  const days = (S.doc && S.doc.days) || {};
  const t = { s1: 0, s2: 0, s3: 0, card: 0, back: 0, ware: 0, sonst: 0, ges: 0, aus: 0, rest: 0 };
  for (let i = 1; i <= daysIn(S.y, S.m); i++) {
    const d = days[pad(i)] || {}, c = dayCalc(d);
    [...IN, ...OUT].forEach(k => t[k] += v(d[k]));
    t.ges += c.ges; t.aus += c.aus; t.rest += c.rest;
  }
  const w = workers();
  const salaries = WORKERS.reduce((a, k) => a + v(w[k] && w[k].salary), 0);
  const cash = v(S.doc && S.doc.cashStart);
  return { t, salaries, cash, box: cash + t.rest - salaries, result: t.rest - salaries };
}
const workers = () => (S.doc && S.doc.workers) || S.carry || {};

// ---------------------------------------------------------------- render

function renderTabs() {
  const tabs = $("#tabs"); tabs.textContent = "";
  BRANCHES.forEach(b => {
    const t = document.createElement("button"); t.type = "button"; t.className = "tab"; t.setAttribute("role", "tab");
    t.setAttribute("aria-selected", String(b === S.branch)); t.textContent = S.names[b] || DEFAULT_NAMES[b];
    t.onclick = () => { if (S.branch !== b) { S.branch = b; open(); } };
    tabs.append(t);
  });
  $("#mLabel").textContent = arMonth.format(new Date(S.y, S.m - 1, 1));
}

function renderWorkers() {
  const box = $("#workers");
  if (box.contains(document.activeElement)) { renderWorkerNets(); return; }   // don't rebuild under someone's typing
  box.textContent = "";
  const head = document.createElement("div"); head.className = "wrow whead";
  ["العامل", "الراتب", "السلف", "أخرى", "الصافي"].forEach(h => { const d = document.createElement("div"); d.textContent = h; head.append(d); });
  box.append(head);
  const w = workers();
  const labels = { salary: "الراتب", advance: "السلف", other: "أخرى" };
  WORKERS.forEach((k, i) => {
    const x = w[k] || {};
    const row = document.createElement("div"); row.className = "wrow";
    const name = document.createElement("input"); name.className = "t wname"; name.placeholder = "عامل " + (i + 1); name.value = x.name || "";
    name.oninput = () => save("workers." + k + ".name", name.value.trim());
    row.append(name);
    ["salary", "advance", "other"].forEach(f => {
      const inp = document.createElement("input"); inp.className = "n w" + f; inp.inputMode = "decimal"; inp.autocomplete = "off";
      inp.value = fmtIn(x[f]); inp.placeholder = labels[f];
      inp.setAttribute("aria-label", labels[f] + " – " + (x.name || "عامل " + (i + 1)));
      numberField(inp);
      inp.oninput = () => { save("workers." + k + "." + f, parseNum(inp.value)); renderSummary(); renderWorkerNets(); };
      row.append(inp);
    });
    const net = document.createElement("div"); net.className = "cell auto wnet"; net.dataset.net = k; row.append(net);
    box.append(row);
  });
  const tot = document.createElement("div"); tot.className = "wrow wtot";
  const lbl = document.createElement("div"); lbl.className = "wname"; lbl.textContent = "المجموع"; tot.append(lbl);
  ["salary", "advance", "other", "net"].forEach(f => { const d = document.createElement("div"); d.className = "cell auto w" + f; d.dataset.sum = f; tot.append(d); });
  box.append(tot);
  renderWorkerNets();
}
// net = salary − advances − other; computed, never typed
function renderWorkerNets() {
  const w = workers(); const sum = { salary: 0, advance: 0, other: 0, net: 0 };
  WORKERS.forEach(k => {
    const x = w[k] || {}, net = v(x.salary) - v(x.advance) - v(x.other);
    sum.salary += v(x.salary); sum.advance += v(x.advance); sum.other += v(x.other); sum.net += net;
    const el = document.querySelector('[data-net="' + k + '"]'); if (el) { el.textContent = (x.salary != null || x.advance != null) ? fmt0(net) : ""; el.classList.toggle("neg", net < 0); }
  });
  Object.entries(sum).forEach(([f, n]) => { const el = document.querySelector('[data-sum="' + f + '"]'); if (el) el.textContent = fmt0(n); });
}

function renderSummary() {
  const c = monthCalc();
  $("#sRest").textContent = fmt0(c.t.rest);
  $("#sWorkers").textContent = fmt0(c.salaries);
  $("#sBox").textContent = fmt0(c.box);
  const r = $("#result");
  r.className = "result " + (c.result >= 0 ? "plus" : "minus");
  r.innerHTML = "";
  const a = document.createElement("span"); a.textContent = c.result >= 0 ? "ربح هذا الشهر" : "خسارة هذا الشهر";
  const b = document.createElement("span"); b.className = "num"; b.textContent = fmt0(c.result);
  r.append(a, b);
}

function renderDays() {
  const body = $("#days"); body.textContent = "";
  const days = (S.doc && S.doc.days) || {};
  for (let i = 1; i <= daysIn(S.y, S.m); i++) {
    const date = new Date(S.y, S.m - 1, i), d = days[pad(i)] || {}, c = dayCalc(d);
    const tr = document.createElement("tr"); tr.className = "day" + ((date.getDay() === 0 || date.getDay() === 6) ? " we" : "");
    const td0 = document.createElement("td"); td0.className = "date";
    td0.textContent = arWeekday.format(date) + " " + i;
    const mo = document.createElement("span"); mo.className = "long"; mo.textContent = " " + arMonthOnly.format(date); td0.append(mo);
    if (d.note) { const dot = document.createElement("span"); dot.className = "dot"; dot.title = d.note; td0.append(dot); }
    tr.append(td0);
    const cell = (n, calc, neg) => { const td = document.createElement("td"); td.className = "m" + (calc ? " calc" : "") + (neg ? " neg" : ""); td.textContent = fmt(n); tr.append(td); };
    IN.forEach(k => cell(d[k])); cell(c.ges, true);
    OUT.forEach(k => cell(d[k])); cell(c.aus, true); cell(c.rest, true, c.rest < 0);
    tr.onclick = () => openDay(i);
    body.append(tr);
  }
  const t = monthCalc().t, tf = $("#totals"); tf.textContent = "";
  const td0 = document.createElement("td"); td0.className = "date"; td0.textContent = "Total"; tf.append(td0);
  ["s1", "s2", "s3", "card", "ges", "back", "ware", "sonst", "aus", "rest"].forEach(k => {
    const td = document.createElement("td"); td.className = "m" + (k === "rest" && t.rest < 0 ? " neg" : ""); td.textContent = fmt0(t[k]); tf.append(td);
  });
}

function renderAll() {
  renderTabs(); renderSummary(); renderWorkers(); renderDays();
  const cs = $("#cashStart"); if (document.activeElement !== cs) cs.value = fmtIn(S.doc && S.doc.cashStart);
  const mn = $("#monthNotes"); if (document.activeElement !== mn) mn.value = (S.doc && S.doc.notes) || "";
}

// ---------------------------------------------------------------- day editor

let dayOpen = 0;
function openDay(i) {
  dayOpen = i;
  const d = ((S.doc && S.doc.days) || {})[pad(i)] || {};
  $("#dTitle").textContent = arDay.format(new Date(S.y, S.m - 1, i)) + " — " + (S.names[S.branch] || "");
  document.querySelectorAll("#dayDlg [data-f]").forEach(el => { el.value = el.dataset.f === "note" ? (d.note || "") : fmtIn(d[el.dataset.f]); });
  renderDaySums();
  $("#dayDlg").hidden = false;
}
function renderDaySums() {
  const d = ((S.doc && S.doc.days) || {})[pad(dayOpen)] || {}, c = dayCalc(d);
  $("#dGes").textContent = fmt0(c.ges); $("#dAus").textContent = fmt0(c.aus); $("#dRest").textContent = fmt0(c.rest);
  $("#dRest").style.color = c.rest < 0 ? "var(--minus)" : "";
}
document.querySelectorAll("#dayDlg [data-f]").forEach(el => {
  if (el.dataset.f !== "note") numberField(el);
  el.addEventListener("input", () => {
    const f = el.dataset.f;
    save("days." + pad(dayOpen) + "." + f, f === "note" ? el.value : parseNum(el.value));
    renderDaySums(); renderSummary(); renderDays();
  });
});
$("#dClose").onclick = () => { $("#dayDlg").hidden = true; };
$("#dPrev").onclick = () => { if (dayOpen > 1) openDay(dayOpen - 1); };
$("#dNext").onclick = () => { if (dayOpen < daysIn(S.y, S.m)) openDay(dayOpen + 1); };
$("#dayDlg").addEventListener("click", e => { if (e.target.id === "dayDlg") $("#dayDlg").hidden = true; });

// ---------------------------------------------------------------- month, branch, box, notes

numberField($("#cashStart"));
$("#cashStart").addEventListener("input", () => { save("cashStart", parseNum($("#cashStart").value)); renderSummary(); });
$("#monthNotes").addEventListener("input", () => save("notes", $("#monthNotes").value));
$("#mPrev").onclick = () => { S.m--; if (S.m < 1) { S.m = 12; S.y--; } open(); };
$("#mNext").onclick = () => { S.m++; if (S.m > 12) { S.m = 1; S.y++; } open(); };
$("#btnPrint").onclick = () => window.print();
$("#btnCols").onclick = () => { const on = $("#tableWrap").classList.toggle("full"); $("#btnCols").textContent = on ? "الأعمدة المختصرة" : "كل الأعمدة"; };
$("#btnNames").onclick = () => { $("#b1Name").value = S.names.b1 || ""; $("#b2Name").value = S.names.b2 || ""; $("#namesDlg").hidden = false; };
$("#nmClose").onclick = () => { $("#namesDlg").hidden = true; };
$("#nmSave").onclick = async () => {
  const names = { b1: $("#b1Name").value.trim() || DEFAULT_NAMES.b1, b2: $("#b2Name").value.trim() || DEFAULT_NAMES.b2 };
  S.names = names; renderTabs(); $("#namesDlg").hidden = true;
  try { await store.write("settings/branches", names); } catch (e) { status("لم تُحفظ الأسماء: " + e.message, true); }
};
$("#btnLogout").onclick = async () => { await store.signOut(); location.reload(); };

async function open() {
  try { localStorage.setItem("kb-view", JSON.stringify({ branch: S.branch })); } catch (e) {}
  if (S.unwatch) S.unwatch();
  S.doc = null; S.carry = null;
  renderAll();
  // a new month starts with last month's workers and salaries; advances start empty
  const py = S.m === 1 ? S.y - 1 : S.y, pm = S.m === 1 ? 12 : S.m - 1;
  const key = docKey();
  store.get("months/" + S.branch + "_" + monthKey(py, pm)).then(prev => {
    if (key !== docKey() || !prev || !prev.workers) return;
    const carry = {};
    WORKERS.forEach(k => { const x = prev.workers[k]; if (x && (x.name || x.salary != null)) carry[k] = { name: x.name || "", salary: x.salary ?? null }; });
    S.carry = Object.keys(carry).length ? carry : null;
    if (!S.doc) renderAll();
  }).catch(() => {});
  S.unwatch = store.watch(key, d => {
    if (key !== docKey()) return;
    if (Object.keys(timers).length) return;   // this device has unsaved typing; its own write will come back
    S.doc = d; renderAll();
    if (!$("#dayDlg").hidden) renderDaySums();
  });
}

// ---------------------------------------------------------------- start

(async () => {
  store = await makeStore();
  $("#loginView").hidden = true; $("#appView").hidden = false;
  $("#who").textContent = (store.user.email || "") + " · v" + APP_VERSION;
  store.watch("settings/branches", d => { if (d) { S.names = { ...DEFAULT_NAMES, ...d }; renderTabs(); } });
  open();
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
