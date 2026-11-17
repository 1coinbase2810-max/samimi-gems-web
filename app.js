/* samimi Gems — web (GitHub Pages, static, no backend)
   Same behaviour as the Telegram bot (src/worker.js):
   - gems = saved system prompts + knowledge, per-gem chat history
   - Nara router, OpenAI-compatible /v1/chat/completions, free-model fallback chain
   - key is the user's own, stored only in this browser's localStorage
*/
"use strict";

const STORE_KEY = "samimiGemsWeb.v1";
const DEFAULT_BASE = "https://router.bynara.id/v1";
const DEFAULT_MODEL = "muse-spark-1.3-contributor";
const MAX_INSTRUCTION = 6000, MAX_KNOWLEDGE = 6000;

// Same fallback order as the bot (worker.js). Known-bad excluded: jev, mimo-v2.6-flash-free.
const FALLBACK_MODELS = [
  "muse-spark-1.3-contributor", "muse-spark-1.2-contributor", "mimo-v2.5-free",
  "nemotron-3.5-lightning-free", "laguna-s-2.1", "space-bunny-alpha",
  "ling-3.0-flash-sante-free", "nemotron-3-super-free", "nemotron-3-ultra-free",
  "space-bunny-alpha-bynara", "ling-3.0-flash-fin-free",
];
const EXCLUDE_MODELS = new Set(["jev", "mimo-v2.6-flash-free"]);
const VIDEO_RE = /video/i, FREE_RE = /free/i;

const REPLY_GUY_INSTRUCTION = `Role:

You are my Twitter reply assistant.
Language & vibe

Always reply in English.

Tone must be friendly, casual, and naturally bullish.

Sound like a real crypto Twitter user, not an assistant.

Replies can be imperfect, relaxed, and conversational.
Length rules

Each reply must be 65 characters max.

Never exceed 85 characters.

If the reply feels stiff, shorten it instead of formalizing it.
Style rules

Use contractions like: we're, it's, that's, can't.

Short reactions are allowed.

Light confidence, subtle hype, natural flow.

No filler, no explanations.
Content rules

Stay fully on-topic with the project.

Use uploaded project docs as source of truth.

No links unless asked.
Emoji rule

No emojis at all.
Formatting rules

Do not overuse em dashes.

Avoid emoji-heavy formatting.

Use only lowercase letters. Never use capital letters or caps lock.
If unsure, choose the most natural, tweet-like wording.`;

const REPLY_GUY_BANNED = ["Exactly", "fact", "huge", "game changer", "Finally",
  "This is the kind", "No noise, no hype, just X", "Let's talk about",
  "In an ever-changing world", "Paradigm shift", "Let's dive in", "Buzzwords",
  "Chaos", "Matters", "Shift", "Real", "Feels", "Feels like", "Unlock"];

/* ---------- state ---------- */
function defaultState() {
  const seed = { id: "gem-reply-guy", name: "reply guy ✍️",
    instruction: REPLY_GUY_INSTRUCTION, knowledge: "",
    bannedWords: [...REPLY_GUY_BANNED], createdAt: Date.now() };
  return {
    gems: [seed], activeId: seed.id, histories: {},
    settings: { apiKey: "", baseUrl: DEFAULT_BASE, model: DEFAULT_MODEL,
      temperature: 0.7, maxHistory: 20, fallback: true, strictBanned: false,
      proxyUrl: "", freeModels: [] },
  };
}
let state;
try { state = JSON.parse(localStorage.getItem(STORE_KEY)) || defaultState(); }
catch { state = defaultState(); }
if (!state.gems || !state.gems.length) state = defaultState();
if (!state.settings) state.settings = defaultState().settings;
if (!state.histories) state.histories = {};
// migrate old gems that lack bannedWords
for (const g of state.gems) if (!Array.isArray(g.bannedWords)) g.bannedWords = [];
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }

const $ = (id) => document.getElementById(id);
const uid = () => "gem-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const faNum = (n) => Number(n).toLocaleString("fa-IR");
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  $("toastWrap").appendChild(t); setTimeout(() => t.remove(), 2600);
}
async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label || "کپی شد ✓"); return true; }
  catch {
    const ta = document.createElement("textarea"); ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta);
    ta.select(); let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); toast(ok ? (label || "کپی شد ✓") : "کپی نشد — دستی انتخاب کن"); return ok;
  }
}
const activeGem = () => state.gems.find((g) => g.id === state.activeId) || state.gems[0] || null;
const historyOf = (gemId) => (state.histories[gemId] ||= []);

/* ---------- prompt building + banned words (same rules as the bot) ---------- */
function buildSystemPrompt(gem) {
  let sys = (gem.instruction || "").trim();
  if (gem.knowledge && gem.knowledge.trim()) sys += `\n\n[دانش ضمیمه]:\n${gem.knowledge.trim()}`;
  const banned = (gem.bannedWords || []).map((w) => String(w).trim()).filter(Boolean);
  if (banned.length) {
    sys += "\n\nForbidden words & phrases — never use these words, phrases, or close variants:\n"
      + banned.map((w) => "- " + w).join("\n");
  }
  return sys;
}
function findBanned(text, bannedWords) {
  const found = [];
  for (const raw of bannedWords || []) {
    const w = String(raw).trim(); if (!w) continue;
    // Latin words: word-boundary match; Persian / phrases: plain substring. Case-insensitive.
    const isLatin = /^[A-Za-z][A-Za-z'’ -]*$/.test(w);
    const re = isLatin
      ? new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i")
      : null;
    const hit = re ? re.test(text) : text.toLocaleLowerCase().includes(w.toLocaleLowerCase());
    if (hit) found.push(w);
  }
  return found;
}
function isFreeModel(m) {
  if (!m || !m.id || VIDEO_RE.test(m.id)) return false;
  if (FREE_RE.test(m.id)) return true;
  const inp = Number(m.input_idr_per_1k ?? m.input_price ?? NaN);
  const out = Number(m.output_idr_per_1k ?? m.output_price ?? NaN);
  return inp === 0 && out === 0;
}
function modelsToTry(primary) {
  const seen = new Set(), out = [];
  for (const m of [primary, ...(state.settings.freeModels || []), ...FALLBACK_MODELS]) {
    if (m && !seen.has(m) && !EXCLUDE_MODELS.has(m)) { seen.add(m); out.push(m); }
  }
  return state.settings.fallback ? out : out.slice(0, 1);
}
function endpointFor(path) {
  const proxy = (state.settings.proxyUrl || "").trim().replace(/\/+$/, "");
  if (proxy) return proxy + path; // proxy routes by path, forwards upstream
  return (state.settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, "") + path;
}
function isCorsLikeError(e) {
  return e && (e.name === "TypeError" || /failed to fetch|networkerror|load failed/i.test(e.message || ""));
}

/* ---------- provider calls ---------- */
let aborter = null;
async function callChat(messages, onModelTried) {
  const s = state.settings;
  if (!s.apiKey) throw Object.assign(new Error("NO_KEY"), { code: "NO_KEY" });
  const chain = modelsToTry(s.model);
  let lastErr = null;
  for (const model of chain) {
    onModelTried && onModelTried(model, chain.length > 1);
    aborter = new AbortController();
    try {
      const r = await fetch(endpointFor("/chat/completions"), {
        method: "POST", signal: aborter.signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.apiKey },
        body: JSON.stringify({ model, messages, temperature: Number(s.temperature ?? 0.7) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = Object.assign(new Error(j?.error?.message || j?.message || ("خطای " + r.status + " از پروایدر")), { status: r.status });
        if (r.status === 401 || r.status === 403) throw lastErr; // wrong key: no point trying other models
        continue;
      }
      const text = j?.choices?.[0]?.message?.content?.trim();
      if (!text) { lastErr = new Error("پاسخ خالی از مدل برگشت"); continue; }
      return { text, model };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (e.status === 401 || e.status === 403) throw e;
      lastErr = e;
      if (isCorsLikeError(e)) throw Object.assign(e, { code: "CORS_OR_NETWORK" });
    }
  }
  throw lastErr || new Error("همه مدل‌ها خطا دادند");
}

async function refreshModels(showToast = true) {
  const s = state.settings;
  if (!s.apiKey) { toast("اول کلید API را وارد کن"); openSettings(); return; }
  $("modelStatus").textContent = "در حال دریافت…";
  try {
    const r = await fetch(endpointFor("/models"), { headers: { Authorization: "Bearer " + s.apiKey } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || ("خطای " + r.status));
    const free = (j?.data || []).filter(isFreeModel).map((m) => m.id).filter((id) => !EXCLUDE_MODELS.has(id));
    s.freeModels = free; save(); fillModelList();
    $("modelStatus").textContent = free.length ? `${faNum(free.length)} مدل رایگان پیدا شد` : "مدل رایگانی پیدا نشد";
    if (showToast) toast(free.length ? `${faNum(free.length)} مدل رایگان بروز شد` : "مدل رایگانی پیدا نشد");
  } catch (e) {
    $("modelStatus").textContent = "";
    toast(isCorsLikeError(e) ? "اتصال برقرار نشد — احتمالا CORS؛ پروکسی را در تنظیمات ببین" : ("خطا: " + (e.message || e)));
  }
}

async function testConnection() {
  const s = state.settings;
  if (!s.apiKey) { $("testStatus").textContent = "اول کلید را وارد کن."; return; }
  $("testStatus").textContent = "در حال تست…";
  try {
    const r = await fetch(endpointFor("/models"), { headers: { Authorization: "Bearer " + s.apiKey } });
    if (!r.ok) throw new Error("خطای " + r.status);
    $("testStatus").textContent = "✓ اتصال برقرار است.";
  } catch (e) {
    $("testStatus").textContent = isCorsLikeError(e)
      ? "✕ مرورگر جلوی اتصال مستقیم را گرفت (CORS) — آدرس پروکسی را وارد کن یا از پروایدری که CORS می‌دهد استفاده کن."
      : ("✕ " + (e.message || e));
  }
}

/* ---------- chat ---------- */
let sending = false;
async function sendChat(userText, { regenerate = false } = {}) {
  const gem = activeGem(); if (!gem || sending) return;
  const s = state.settings;
  const hist = historyOf(gem.id);
  if (!s.apiKey) { renderMessages(); openSettings(); toast("اول کلید API را در تنظیمات وارد کن"); return; }
  if (!regenerate) {
    hist.push({ role: "user", content: userText });
    hist.splice(0, hist.length - s.maxHistory);
  }
  sending = true; setSending(true); renderMessages();
  const sys = buildSystemPrompt(gem);
  const apiMessages = [{ role: "system", content: sys },
    ...hist.slice(-s.maxHistory).map((m) => ({ role: m.role, content: m.content }))];
  let result, error = null, triedModel = s.model;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await callChat(apiMessages, (m) => { triedModel = m; });
      const banned = findBanned(result.text, gem.bannedWords);
      result.banned = banned;
      if (!banned.length || !s.strictBanned || attempt === 2) break;
      // strict mode: silently retry once/twice; the prompt already forbids them
    }
  } catch (e) { error = e; }
  sending = false; setSending(false);
  if (error) {
    if (error.name === "AbortError") { renderMessages(); return; }
    const msg = error.code === "CORS_OR_NETWORK"
      ? "مرورگر جلوی اتصال مستقیم به پروایدر را گرفت (CORS). روتر Nara هدر Access-Control-Allow-Origin نمی‌فرستد، پس از GitHub Pages نمی‌شود مستقیم صدا زد.\n\nراه‌حل: پروکسی آماده در پوشه proxy/ همین ریپو را روی Cloudflare Workers (رایگان) دیپلوی کن و آدرسش را در تنظیمات → «آدرس پروکسی» بگذار. یا Base URL را به پروایدری بده که CORS می‌دهد (مثلا OpenRouter)."
      : error.status === 401 || error.status === 403
      ? "کلید API قبول نشد (401/403). کلید را در تنظیمات بررسی کن — کلید Nara با sk-nry- شروع می‌شود."
      : ("خطا: " + (error.message || error));
    hist.push({ role: "error", content: msg });
    hist.splice(0, hist.length - s.maxHistory);
    save(); renderMessages(); return;
  }
  hist.push({ role: "assistant", content: result.text, model: result.model, banned: result.banned || [] });
  hist.splice(0, hist.length - s.maxHistory);
  save(); renderMessages();
}

function regenerateLast() {
  const gem = activeGem(); if (!gem || sending) return;
  const hist = historyOf(gem.id);
  const lastUser = [...hist].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  // drop trailing assistant/error messages, keep the user message, then resend it
  while (hist.length && hist[hist.length - 1].role !== "user") hist.pop();
  save(); sendChat(lastUser.content, { regenerate: true });
}

/* ---------- rendering ---------- */
function renderAll() { renderSidebar(); renderChatHead(); renderMessages(); renderKeyBanner(); }
function renderKeyBanner() {
  const hasKey = !!(state.settings.apiKey || "").trim();
  $("keyBanner").hidden = hasKey;
  $("modelBadge").textContent = state.settings.model || "—";
  $("modelHint").textContent = state.settings.model || "—";
}
function renderSidebar() {
  const list = $("gemsList"); list.innerHTML = "";
  $("gemCount").textContent = faNum(state.gems.length);
  if (!state.gems.length) { list.innerHTML = '<div class="gem-empty">هنوز جمی نساخته‌ای.</div>'; return; }
  state.gems.forEach((g, i) => {
    const b = document.createElement("button");
    b.className = "gem-item" + (g.id === state.activeId ? " active" : "");
    b.innerHTML = `<span class="gem-num">${String(i + 1).padStart(2, "0")}</span>
      <span><span class="gem-name">${esc(g.name)}</span><br>
      <span class="gem-meta">${faNum((historyOf(g.id)).length)} پیام · ${faNum((g.bannedWords || []).length)} کلمه ممنوعه</span></span>`;
    b.onclick = () => { state.activeId = g.id; save(); closeSidebar(); renderAll(); };
    list.appendChild(b);
  });
}
function renderChatHead() {
  const gem = activeGem();
  const empty = !gem;
  $("chatEmpty").hidden = !empty;
  $("chatView").hidden = empty;
  if (!gem) return;
  $("chatTitle").textContent = "💎 " + gem.name;
  $("chatSubtitle").textContent = `مدل: ${state.settings.model} · حافظه: ${faNum(state.settings.maxHistory)} پیام آخر · دانش: ${gem.knowledge ? faNum(gem.knowledge.length) + " حرف" : "—"}`;
}
function messageActions(m, idx, isLastAssistant) {
  const wrap = document.createElement("div"); wrap.className = "msg-actions";
  if (m.role === "assistant") {
    const copy = document.createElement("button"); copy.className = "btn btn-outline";
    copy.textContent = "📋 کپی"; copy.onclick = () => copyText(m.content);
    wrap.appendChild(copy);
    if (isLastAssistant) {
      const re = document.createElement("button"); re.className = "btn btn-outline";
      re.textContent = "↻ دوباره بساز"; re.onclick = regenerateLast; wrap.appendChild(re);
    }
    if (m.banned && m.banned.length) {
      const flag = document.createElement("span"); flag.className = "banned-flag";
      flag.textContent = "⚠️ کلمه ممنوعه: " + m.banned.join("، "); wrap.appendChild(flag);
    }
    if (m.model) {
      const meta = document.createElement("span"); meta.className = "msg-meta";
      meta.textContent = "مدل: " + m.model; wrap.appendChild(meta);
    }
  }
  if (m.role === "user") {
    const copy = document.createElement("button"); copy.className = "btn btn-ghost";
    copy.textContent = "📋 کپی"; copy.onclick = () => copyText(m.content); wrap.appendChild(copy);
  }
  return wrap;
}
function renderMessages() {
  const gem = activeGem(); const box = $("messages"); if (!gem) return;
  box.innerHTML = "";
  const hist = historyOf(gem.id);
  if (!hist.length) {
    const d = document.createElement("div"); d.className = "msg assistant";
    d.innerHTML = `<div class="msg-text">${esc("سلام! من «" + gem.name + "» هستم. پیامت را بفرست تا با همین شخصیت جواب بدهم.")}</div>`;
    box.appendChild(d); return;
  }
  const lastAssistantIdx = (() => { for (let i = hist.length - 1; i >= 0; i--) if (hist[i].role === "assistant") return i; return -1; })();
  hist.forEach((m, idx) => {
    const d = document.createElement("div");
    d.className = "msg " + (m.role === "assistant" ? "assistant" : m.role === "error" ? "error" : "user");
    const t = document.createElement("div"); t.className = "msg-text"; t.textContent = m.content;
    d.appendChild(t);
    if (m.role !== "error") d.appendChild(messageActions(m, idx, idx === lastAssistantIdx));
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
}
function setSending(on) {
  $("typing").hidden = !on;
  $("btnSend").disabled = on;
  $("composerInput").disabled = on;
  if (!on) $("composerInput").focus();
}

/* ---------- modals ---------- */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
function openSettings() { fillSettings(); openModal("settingsModal"); }
function fillSettings() {
  const s = state.settings;
  $("setApiKey").value = s.apiKey || "";
  $("setBaseUrl").value = s.baseUrl || DEFAULT_BASE;
  $("setModel").value = s.model || DEFAULT_MODEL;
  $("setProxyUrl").value = s.proxyUrl || "";
  $("setTemperature").value = s.temperature ?? 0.7;
  $("tempValue").textContent = String(s.temperature ?? 0.7);
  $("setMaxHistory").value = s.maxHistory || 20;
  $("chkFallback").checked = !!s.fallback;
  $("chkStrictBanned").checked = !!s.strictBanned;
  $("testStatus").textContent = ""; $("modelStatus").textContent = "";
  fillModelList();
}
function fillModelList() {
  const dl = $("modelList"); dl.innerHTML = "";
  const models = [...new Set([state.settings.model, ...(state.settings.freeModels || []), ...FALLBACK_MODELS])].filter(Boolean);
  for (const m of models) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); }
}
function saveSettings() {
  const s = state.settings;
  s.apiKey = $("setApiKey").value.trim();
  s.baseUrl = $("setBaseUrl").value.trim() || DEFAULT_BASE;
  s.model = $("setModel").value.trim() || DEFAULT_MODEL;
  s.proxyUrl = $("setProxyUrl").value.trim();
  s.temperature = Number($("setTemperature").value);
  s.maxHistory = Math.min(40, Math.max(4, Number($("setMaxHistory").value) || 20));
  s.fallback = $("chkFallback").checked;
  s.strictBanned = $("chkStrictBanned").checked;
  save(); closeModal("settingsModal"); renderAll();
  toast(s.apiKey ? "تنظیمات ذخیره شد ✓" : "تنظیمات ذخیره شد — کلید را وارد کن تا چت کار کند");
}

function openGemEditor(gem) {
  $("gemModalTitle").textContent = gem ? "ویرایش جم" : "جم جدید";
  $("gemId").value = gem ? gem.id : "";
  $("gemName").value = gem ? gem.name : "";
  $("gemInstruction").value = gem ? gem.instruction : "";
  $("gemKnowledge").value = gem ? gem.knowledge || "" : "";
  $("gemBanned").value = gem ? (gem.bannedWords || []).join("\n") : "";
  $("btnDeleteGem").hidden = !gem;
  updateCounts(); openModal("gemModal");
  setTimeout(() => $("gemName").focus(), 50);
}
function updateCounts() {
  $("instrCount").textContent = `${faNum($("gemInstruction").value.length)} / ${faNum(MAX_INSTRUCTION)}`;
  $("knowCount").textContent = `${faNum($("gemKnowledge").value.length)} / ${faNum(MAX_KNOWLEDGE)}`;
}
function saveGem(e) {
  e.preventDefault();
  const id = $("gemId").value;
  const name = $("gemName").value.trim();
  if (!name) { toast("نام جم را بنویس"); return; }
  if (name.length > 32) { toast("نام جم حداکثر ۳۲ حرف باشد"); return; }
  const data = {
    name,
    instruction: $("gemInstruction").value.slice(0, MAX_INSTRUCTION),
    knowledge: $("gemKnowledge").value.slice(0, MAX_KNOWLEDGE),
    bannedWords: $("gemBanned").value.split("\n").map((w) => w.trim()).filter(Boolean),
  };
  if (id) {
    const g = state.gems.find((x) => x.id === id); if (!g) return;
    Object.assign(g, data);
    toast("جم بروز شد ✓");
  } else {
    const g = { id: uid(), createdAt: Date.now(), ...data };
    state.gems.push(g); state.activeId = g.id;
    toast("جم ساخته و فعال شد ✓");
  }
  save(); closeModal("gemModal"); renderAll();
}
function deleteGem() {
  const id = $("gemId").value; if (!id) return;
  const g = state.gems.find((x) => x.id === id);
  if (!g || !confirm(`جم «${g.name}» و گفت‌وگویش حذف شود؟`)) return;
  state.gems = state.gems.filter((x) => x.id !== id);
  delete state.histories[id];
  if (state.activeId === id) state.activeId = state.gems[0] ? state.gems[0].id : null;
  save(); closeModal("gemModal"); renderAll(); toast("جم حذف شد");
}

/* ---------- export / import ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "samimi-gems-export.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("خروجی دانلود شد");
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!Array.isArray(data.gems)) throw new Error("فایل معتبر نیست");
      state.gems = data.gems; state.activeId = data.activeId || data.gems[0]?.id || null;
      state.histories = data.histories || {};
      if (data.settings) state.settings = { ...defaultState().settings, ...data.settings };
      save(); closeModal("settingsModal"); renderAll(); toast("داده‌ها وارد شد ✓");
    } catch { toast("فایل JSON معتبر نیست"); }
  };
  r.readAsText(file);
}

/* ---------- sidebar (mobile) ---------- */
function closeSidebar() { $("sidebar").classList.remove("open"); $("backdrop").classList.remove("show"); }

/* ---------- wiring ---------- */
$("composerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("composerInput").value.trim();
  if (!v || sending) return;
  $("composerInput").value = ""; $("composerInput").style.height = "auto";
  sendChat(v);
});
$("composerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composerForm").requestSubmit(); }
});
$("composerInput").addEventListener("input", (e) => {
  e.target.style.height = "auto"; e.target.style.height = Math.min(180, e.target.scrollHeight) + "px";
});
$("btnNewGem").onclick = () => { closeSidebar(); openGemEditor(null); };
$("btnNewGemTop").onclick = () => openGemEditor(null);
$("btnHeroGem").onclick = () => openGemEditor(null);
$("btnSettings").onclick = openSettings;
$("btnKeyBanner").onclick = openSettings;
$("btnHeroKey").onclick = openSettings;
$("btnCloseSettings").onclick = () => closeModal("settingsModal");
$("btnSaveSettings").onclick = saveSettings;
$("btnTestConnection").onclick = testConnection;
$("btnRefreshModels").onclick = () => refreshModels(true);
$("toggleKey").onclick = () => {
  const f = $("setApiKey");
  f.type = f.type === "password" ? "text" : "password";
  $("toggleKey").textContent = f.type === "password" ? "نمایش" : "پنهان";
};
$("setTemperature").addEventListener("input", (e) => { $("tempValue").textContent = e.target.value; });
$("btnExportData").onclick = exportData;
$("btnImportData").onclick = () => $("fileImport").click();
$("fileImport").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });
$("btnClearAll").onclick = () => {
  if (!confirm("همه داده‌ها — کلید، جم‌ها و گفت‌وگوها — از این مرورگر حذف شود؟")) return;
  localStorage.removeItem(STORE_KEY); state = defaultState(); save();
  closeModal("settingsModal"); renderAll(); toast("همه داده‌ها پاک شد");
};
$("btnCloseGem").onclick = () => closeModal("gemModal");
$("gemForm").addEventListener("submit", saveGem);
$("btnDeleteGem").onclick = deleteGem;
$("gemInstruction").addEventListener("input", updateCounts);
$("gemKnowledge").addEventListener("input", updateCounts);
$("fileKnowledge").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (!/\.(txt|md|markdown)$/i.test(f.name)) { toast("فقط فایل .txt / .md قبول می‌شود"); e.target.value = ""; return; }
  const r = new FileReader();
  r.onload = () => {
    const cur = $("gemKnowledge").value;
    $("gemKnowledge").value = (cur ? cur + "\n\n" : "") + String(r.result || "").slice(0, MAX_KNOWLEDGE);
    $("gemKnowledge").value = $("gemKnowledge").value.slice(-MAX_KNOWLEDGE);
    updateCounts(); toast(`فایل «${f.name}» به دانش اضافه شد`);
  };
  r.readAsText(f); e.target.value = "";
});
$("btnEditGem").onclick = () => openGemEditor(activeGem());
$("btnResetHistory").onclick = () => {
  const gem = activeGem(); if (!gem) return;
  if (!confirm(`حافظه گفت‌وگو با «${gem.name}» پاک شود؟`)) return;
  state.histories[gem.id] = []; save(); renderMessages(); toast("حافظه مکالمه پاک شد 🧹");
};
$("btnMenu").onclick = () => { $("sidebar").classList.add("open"); $("backdrop").classList.add("show"); };
$("backdrop").onclick = closeSidebar;
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { document.querySelectorAll(".modal").forEach((m) => { m.hidden = true; }); closeSidebar(); }
});

/* ---------- init ---------- */
renderAll();
if (!(state.settings.apiKey || "").trim()) {
  // first visit: nudge to settings, but keep the hero visible
  setTimeout(() => { if (!state.settings.apiKey) openSettings(); }, 600);
}
