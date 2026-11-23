"use strict";
// Thermostat web UI. Talks to the ESP32 over MQTT (WSS). All broker data is rendered with textContent only.
const $ = (id) => document.getElementById(id);
const DAYS = ["ned", "pon", "uto", "sri", "cet", "pet", "sub"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const PRESET_NAME = ["Udobno", "Eko", "Antifriz"];
const PRESET_VAR = ["--acc", "--eco", "--frost"];
const TSRC = ["nema", "RTC (DS3231)", "NTP", "postavljeno ručno"];
const MAXB = 6;

let client = null, base = "", online = false;
let st = null;                 // last state message
let sched = null;              // [7][] of {m, p}
let presets = [21, 18, 7];
let hist = null, histH = null, stats = null, histM = "b";   // histM: t | h | b
let curDay = new Date().getDay();
let schedEdited = false;

function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2200); }
function pad(n) { return String(n).padStart(2, "0"); }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function svgEl(name, attrs, text) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- schedule wire format: "min:preset,min:preset;..." (7 days, Sunday first) ----------
function parseSched(s) {
  const days = s.split(";");
  if (days.length !== 7) return null;
  const out = [];
  for (const d of days) {
    const bl = d.split(",").map((x) => { const [m, p] = x.split(":").map(Number); return { m, p }; });
    if (bl.some((b) => !Number.isInteger(b.m) || !Number.isInteger(b.p))) return null;
    out.push(bl);
  }
  return out;
}
function formatSched(s) { return s.map((d) => d.map((b) => b.m + ":" + b.p).join(",")).join(";"); }
function schedError(s) {
  for (let d = 0; d < 7; d++) {
    const bl = s[d];
    if (bl.length < 1 || bl.length > MAXB) return DAYS[d] + ": 1 do " + MAXB + " blokova";
    for (let i = 0; i < bl.length; i++) {
      if (bl[i].m < 0 || bl[i].m > 1439 || bl[i].p < 0 || bl[i].p > 2) return DAYS[d] + ": neispravan blok";
      if (i && bl[i].m <= bl[i - 1].m) return DAYS[d] + ": vremena moraju rasti";
    }
  }
  return "";
}

// ---------- connection ----------
function pub(sub, payload) {
  if (!client || !client.connected) { toast("Nema veze"); return false; }
  client.publish(base + "/cmd/" + sub, String(payload), { qos: 1, retain: false });
  return true;
}

function connect(url, user, pass, id) {
  base = "termostat/" + id;
  $("loginErr").textContent = "";
  if (client) client.end(true);
  if (!/^wss:\/\//.test(url) && !/^ws:\/\/(localhost|127\.0\.0\.1)/.test(url)) { $("loginErr").textContent = "Dopušten je samo wss:// (ws:// samo za localhost)"; return; }
  client = mqtt.connect(url, { username: user, password: pass, clientId: "web-" + Math.random().toString(16).slice(2, 10), reconnectPeriod: 3000, connectTimeout: 10000, clean: true });
  client.on("connect", () => {
    client.subscribe(base + "/#", { qos: 1 });
    $("login").hidden = true; $("app").hidden = false;
    try { sessionStorage.setItem("pass", pass); } catch (e) { /* storage unavailable */ }
    renderConn();
  });
  client.on("error", (e) => { $("loginErr").textContent = "Greška: " + e.message; if (!client.connected) { $("login").hidden = false; $("app").hidden = true; } });
  client.on("close", () => { renderConn(); if ($("app").hidden) $("login").hidden = false; });
  setTimeout(() => { if (client && !client.connected && $("app").hidden) { $("login").hidden = false; if (!$("loginErr").textContent) $("loginErr").textContent = "Nema veze s brokerom"; } }, 8000);
  client.on("message", (topic, payload) => onMessage(topic.slice(base.length + 1), payload.toString()));
}

function onMessage(sub, msg) {
  if (sub === "status") { online = msg === "online"; renderConn(); return; }
  try {
    if (sub === "state") { st = JSON.parse(msg); renderHome(); renderSet(); }
    else if (sub === "sched") { const s = parseSched(msg); if (s && !schedEdited) { sched = s; renderSched(); } }
    else if (sub === "presets") { const p = msg.split(",").map(Number); if (p.length === 3 && !schedEdited) { presets = p; renderSched(); } }
    else if (sub === "hist") { const v = msg.split(",").map(Number); hist = { ts: v[0], v: v.slice(1) }; renderStats(); }
    else if (sub === "histh") { const v = msg.split(",").map(Number); histH = { ts: v[0], v: v.slice(1) }; renderStats(); }
    else if (sub === "stats") { stats = msg.split(",").map(Number); renderStats(); }
  } catch (e) { /* ignore malformed message */ }
}

function renderConn() {
  const up = client && client.connected;
  $("dot").className = "dot" + (up && online ? " on" : "");
  $("conn").textContent = !up ? "Nema veze s brokerom" : online ? "Termostat online" : "Termostat offline";
  $("linkInfo").textContent = up ? "Broker: spojen. Termostat: " + (online ? "online" : "offline") : "Broker: nije spojen";
}

// ---------- home ----------
const CX = 120, CY = 120, R = 98;
function pt(a, r) { const t = a * Math.PI / 180; return [CX - r * Math.sin(t), CY + r * Math.cos(t)]; }
function angleFor(t) { return 30 + (Math.min(30, Math.max(10, t)) - 10) / 20 * 300; }
function arc(a0, a1) {
  const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
function renderHome() {
  if (!st) return;
  const svg = $("dialSvg"); svg.replaceChildren();
  svg.append(svgEl("path", { d: arc(30, 330), fill: "none", stroke: css("--line"), "stroke-width": 14, "stroke-linecap": "round" }));
  if (st.sensor && st.t > 10) svg.append(svgEl("path", { d: arc(30, Math.max(31, angleFor(st.t))), fill: "none", stroke: st.heat ? css("--acc") : css("--eco"), "stroke-width": 14, "stroke-linecap": "round" }));
  if (st.mode !== 0) { const [mx, my] = pt(angleFor(st.target), R); svg.append(svgEl("circle", { cx: mx, cy: my, r: 9, fill: css("--fg"), stroke: css("--card"), "stroke-width": 3 })); }
  $("tNow").textContent = st.sensor ? st.t.toFixed(1) : "--.-";
  $("tTarget").textContent = st.mode === 0 ? "isključeno" : "zadano " + st.target.toFixed(1) + " °C";
  $("tLine").textContent = statusLine();
  const hl = $("hLine"); hl.replaceChildren();
  const drop = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }); drop.append(svgEl("path", { d: "M12 2C12 2 5 10 5 15a7 7 0 0 0 14 0C19 10 12 2 12 2z" }));
  hl.append(drop, document.createTextNode(st.h + " %"));
  $("hState").textContent = st.heat ? "grije" : "miruje";
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", Number(b.dataset.mode) === st.mode));
  $("boost").classList.toggle("on", st.boost > 0); $("boost").textContent = st.boost > 0 ? "Pojačanje " + st.boost + " min (isključi)" : "Pojačaj 1 h";
  $("away").classList.toggle("on", st.away > 0); $("away").textContent = st.away > 0 ? "Odsutan (otkaži)" : "Odsutan";
  const adj = st.mode === 1 || (st.mode === 2 && !st.boost && !st.away);
  $("minus").disabled = $("plus").disabled = !adj;
  const f = [];
  if (!st.sensor) f.push("Senzor ne radi, grijanje je isključeno");
  if (!st.act) f.push("Nema veze s relejem kotla");
  if (st.norise) f.push("Grije već 30 min, a temperatura ne raste: provjeri kotao");
  if (st.pre) f.push("Predgrijavanje je aktivno");
  if (st.ov) f.push("Privremena izmjena do sljedećeg bloka");
  $("flags").textContent = f.join(" · ");
}
function statusLine() {
  if (st.mode === 0) return "";
  if (st.boost > 0) return "Pojačanje, još " + st.boost + " min";
  if (st.away > 0) return st.away === 4294967295 ? "Odsutan, antifriz" : "Odsutan do " + new Date(st.away * 1000).toLocaleDateString();
  if (st.mode === 1) return "Ručno";
  return st.pre ? "Predgrijavanje" : st.ov ? "Privremeno" : "Raspored";
}
function nudge(d) {
  if (!st) return;
  if (st.mode === 1) pub("set", Math.min(30, Math.max(5, st.set + d)).toFixed(1)), st.set += d;
  else if (st.mode === 2) { const t = Math.min(30, Math.max(5, st.target + d)); pub("ov", t.toFixed(1)); st.target = t; }
  renderHome();
}

// ---------- schedule editor ----------
function renderSched() {
  if (!sched) return;
  const tabs = $("dayTabs"); tabs.replaceChildren();
  for (const d of DAY_ORDER) {
    const b = document.createElement("button"); b.textContent = DAYS[d]; b.classList.toggle("on", d === curDay);
    b.onclick = () => { curDay = d; renderSched(); }; tabs.append(b);
  }
  const box = $("blocks"); box.replaceChildren();
  sched[curDay].forEach((blk, i) => {
    const row = document.createElement("div"); row.className = "block";
    const t = document.createElement("input"); t.type = "time"; t.value = pad(Math.floor(blk.m / 60)) + ":" + pad(blk.m % 60);
    t.onchange = () => { const [h, m] = t.value.split(":").map(Number); blk.m = h * 60 + m; edited(); };
    const sel = document.createElement("select");
    PRESET_NAME.forEach((n, k) => { const o = document.createElement("option"); o.value = k; o.textContent = n + " " + presets[k].toFixed(1) + "°"; sel.append(o); });
    sel.value = blk.p; sel.style.borderLeftColor = css(PRESET_VAR[blk.p]);
    sel.onchange = () => { blk.p = Number(sel.value); edited(); renderSched(); };
    const del = document.createElement("button"); del.textContent = "✕"; del.setAttribute("aria-label", "Obriši blok"); del.disabled = sched[curDay].length <= 1;
    del.onclick = () => { sched[curDay].splice(i, 1); edited(); renderSched(); };
    row.append(t, sel, del); box.append(row);
  });
  $("addBlock").disabled = sched[curDay].length >= MAXB;
  presets.forEach((p, k) => { $("p" + k).value = p; });
}
function edited() { schedEdited = true; $("schedMsg").textContent = "Nespremljene izmjene"; }

// ---------- statistics ----------
function renderStats() {
  const h = $("histSvg"); h.replaceChildren();
  document.querySelectorAll("#histMode button").forEach((b) => b.classList.toggle("on", b.dataset.m === histM));
  const tv = hist && hist.v.length > 1 ? hist.v : null, hv = histH && histH.v.length > 1 ? histH.v : null;
  const showT = histM !== "h" && tv, showH = histM !== "t" && hv;
  const sum = [];
  if (showT || showH) {
    // x = age in 10-min steps from the right edge (143 steps = 24 h), so both series line up
    const x = (i, n) => 330 - (n - 1 - i) * 300 / 143;
    const ref = showT ? tv : hv, newest = (showT ? hist : histH).ts * 1000;
    let lo = 0, hi = 1, hlo = 0, hhi = 1;
    if (showT) { lo = Math.floor(Math.min(...tv) - 0.5); hi = Math.ceil(Math.max(...tv) + 0.5); }
    if (showH) { hlo = Math.floor(Math.min(...hv) / 5) * 5 - 5; hhi = Math.ceil(Math.max(...hv) / 5) * 5 + 5; }
    const yT = (t) => 140 - (t - lo) / (hi - lo) * 120, yH = (t) => 140 - (t - hlo) / (hhi - hlo) * 120;
    for (let k = 0; k <= 4; k++) {
      const y = 140 - k * 30; h.append(svgEl("line", { x1: 30, x2: 330, y1: y, y2: y, stroke: css("--line") }));
      if (showT) h.append(svgEl("text", { x: 2, y: y + 3, fill: css("--acc") }, (lo + k * (hi - lo) / 4).toFixed(1) + "°"));
      if (showH) h.append(svgEl("text", { x: showT ? 334 : 2, y: y + 3, fill: css("--eco") }, Math.round(hlo + k * (hhi - hlo) / 4) + "%"));
    }
    const poly = (v, f, col) => h.append(svgEl("polyline", { points: v.map((t, i) => x(i, v.length).toFixed(1) + "," + f(t).toFixed(1)).join(" "), fill: "none", stroke: col, "stroke-width": 2 }));
    if (showT) { poly(tv, yT, css("--acc")); sum.push("Temp. " + Math.min(...tv).toFixed(1) + "–" + Math.max(...tv).toFixed(1) + " °C"); }
    if (showH) { poly(hv, yH, css("--eco")); sum.push("Vlaga " + Math.min(...hv) + "–" + Math.max(...hv) + " % (prosjek " + Math.round(hv.reduce((a, b) => a + b, 0) / hv.length) + " %)"); }
    for (let i = 0; i < 144; i += 36) {
      const j = ref.length - 1 - (143 - i); if (j < 0) continue;
      const d = new Date(newest - (ref.length - 1 - j) * 600000);
      h.append(svgEl("text", { x: x(j, ref.length) - 10, y: 160 }, pad(d.getHours()) + ":" + pad(d.getMinutes())));
    }
  } else h.append(svgEl("text", { x: 10, y: 80 }, histM === "h" ? "Vlaga: čeka se novi firmware / podaci" : "Još nema podataka (točka svakih 10 min)"));
  $("histSum").textContent = sum.join("  ·  ");
  const r = $("runSvg"); r.replaceChildren();
  if (stats) {
    const hrs = stats.map((m) => m / 60), max = Math.max(1, ...hrs);
    hrs.forEach((v, i) => {
      const bx = 330 - (i + 1) * 40, bh = v / max * 90;
      r.append(svgEl("rect", { x: bx + 4, y: 100 - bh, width: 28, height: bh, rx: 3, fill: i === 0 ? css("--acc") : css("--eco") }));
      r.append(svgEl("text", { x: bx + 8, y: 96 - bh }, v.toFixed(1)));
      r.append(svgEl("text", { x: bx + 6, y: 118 }, i === 0 ? "danas" : "-" + i + "d"));
    });
  }
  $("rateLine").textContent = st ? "Naučena brzina zagrijavanja: " + st.rate.toFixed(2) + " °C/h" : "";
}

// ---------- settings ----------
function renderSet() {
  if (!st) return;
  const d = new Date(st.ts * 1000);
  $("clockInfo").textContent = "Izvor: " + (TSRC[st.tsrc] || "?") + (st.fw ? " · firmware " + st.fw : "") + (st.ts > 1.7e9 ? " · zadnje javljanje " + d.toLocaleString() : "");
  $("clock").textContent = st.ts > 1.7e9 ? pad(d.getHours()) + ":" + pad(d.getMinutes()) : "";
}

// ---------- wiring ----------
$("tabs").onclick = (e) => {
  const t = e.target.dataset && e.target.dataset.tab; if (!t) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b === e.target));
  for (const id of ["home", "sched", "stats", "set"]) $("tab-" + id).hidden = id !== t;
  if (t === "stats") renderStats();
};
$("histMode").onclick = (e) => { const m = e.target.dataset && e.target.dataset.m; if (m) { histM = m; renderStats(); } };
$("modes").onclick = (e) => { const m = e.target.dataset && e.target.dataset.mode; if (m !== undefined) pub("mode", m); };
$("minus").onclick = () => nudge(-0.5);
$("plus").onclick = () => nudge(0.5);
$("boost").onclick = () => pub("boost", st && st.boost > 0 ? 0 : 60);
$("away").onclick = () => { if (st && st.away > 0) pub("away", 0); else $("awayBox").hidden = !$("awayBox").hidden; };
$("awayInf").onclick = () => { pub("away", "inf"); $("awayBox").hidden = true; };
$("awayGo").onclick = () => {
  const v = $("awayDate").value; if (!v) return toast("Odaberi datum");
  const end = new Date(v + "T23:59:00"); if (end <= new Date()) return toast("Datum mora biti u budućnosti");
  pub("away", Math.floor(end.getTime() / 1000)); $("awayBox").hidden = true;
};
$("acOn").onclick = () => pub("ac", "on");
$("acOff").onclick = () => pub("ac", "off");
$("addBlock").onclick = () => {
  const bl = sched[curDay], last = bl[bl.length - 1].m;
  if (last >= 1425) return toast("Nema mjesta za novi blok");
  bl.push({ m: Math.min(1439, last + 60), p: 0 }); edited(); renderSched();
};
$("copyDay").onclick = () => { const src = sched[curDay]; sched = sched.map(() => src.map((b) => ({ ...b }))); edited(); renderSched(); };
[0, 1, 2].forEach((k) => { $("p" + k).onchange = () => { presets[k] = Number($("p" + k).value); edited(); renderSched(); }; });
$("saveSched").onclick = () => {
  const err = schedError(sched); if (err) { $("schedMsg").textContent = err; return; }
  if (presets.some((p) => !(p >= 5 && p <= 30))) { $("schedMsg").textContent = "Temperature moraju biti 5–30 °C"; return; }
  if (pub("presets", presets.map((p) => p.toFixed(1)).join(",")) && pub("sched", formatSched(sched))) { schedEdited = false; $("schedMsg").textContent = "Poslano"; toast("Raspored poslan"); }
};
$("calTouch").onclick = () => { if (pub("touchcal", "1")) toast("Kalibracija pokrenuta na termostatu"); };
$("setTime").onclick = () => { if (pub("time", Math.floor(Date.now() / 1000))) toast("Vrijeme poslano"); };
$("logout").onclick = () => { if (client) client.end(true); try { localStorage.removeItem("pass"); sessionStorage.clear(); } catch (e) { /* ignore */ } $("app").hidden = true; $("login").hidden = false; };
$("loginForm").onsubmit = (e) => {
  e.preventDefault();
  const url = $("url").value.trim(), user = $("user").value.trim(), pass = $("pass").value, id = $("devid").value.trim();
  if (!/^[A-Za-z0-9_-]{1,23}$/.test(id)) { $("loginErr").textContent = "ID smije sadržavati slova, brojke, - i _"; return; }
  try {
    localStorage.setItem("conn", JSON.stringify({ url, user, id }));
    if ($("remember").checked) localStorage.setItem("pass", pass); else localStorage.removeItem("pass");
  } catch (err) { /* storage unavailable */ }
  connect(url, user, pass, id);
};

(function init() {
  let c = null, p = "";
  try { c = JSON.parse(localStorage.getItem("conn") || "null"); p = localStorage.getItem("pass") || sessionStorage.getItem("pass") || ""; } catch (e) { /* ignore */ }
  if (c) { $("url").value = c.url; $("user").value = c.user; $("devid").value = c.id; }
  if (p) $("remember").checked = !!localStorage.getItem("pass");
  if (c && p) { $("pass").value = p; connect(c.url, c.user, p, c.id); } else $("login").hidden = false;
  matchMedia("(prefers-color-scheme: dark)").onchange = () => { renderHome(); renderSched(); renderStats(); };
})();
