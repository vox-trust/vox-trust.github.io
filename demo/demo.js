// Vox Trust browser demo (file mode). Everything runs locally; nothing is uploaded.
import { DEFAULT_LANG, LANGS, LINKS, isolate, langByCode, loadDict, matchLang, translate, translatePlural, user } from "./i18n/index.js";
import { coded, deriveCircleKey, encodeWav, hex, loadVoxTrust, stripManifest, unhex, wavInfo } from "./vox-trust.js";

const RATE = 16000;
const MAX_SECONDS = 60;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_CHUNK_ITEMS = 200;
const MAX_LISTED = 20;
const MAX_REPORT_CHARS = 20000;
const CORE_TIMEOUT_MS = 30000;
const $ = (id) => document.getElementById(id);

const state = {
  vt: null,
  samples: null, // Int16Array, mono
  original: null, // unsealed WAV bytes
  sealed: null, // sealed WAV bytes
  current: null, // the demo's own audio: sealed, then possibly tampered by the attack buttons
  external: null, // a WAV file the visitor asked to verify; it is never attacked and never feeds chunk sizes
  seed: null,
  publicKey: null,
  sealKeyId: 0,
  counter: 1,
  chunkFrames: 16000, // chunk size of the demo's own sealed audio, set only by doSeal
  blobUrl: null,
  embeddedKey: null,
  lang: DEFAULT_LANG,
  view: null, // the verified report on screen: { report, verdict }; text is re-rendered from it, never re-verified
};

let verifyGen = 0;

// ---------------------------------------------------------------- i18n

const LANG_STORAGE_KEY = "vox-trust-lang";
// Params may be plain values, user(text) (outside text, always isolated), { k, p, n } (a translated string,
// plural when n is given) or an Error (localised when it carries a code).
function resolve(params) {
  const source = typeof params === "function" ? params() : params || {};
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    if (value instanceof Error) out[name] = localizeError(value);
    else if (value && typeof value === "object" && "k" in value) out[name] = t(value.k, value.p, value.n);
    else out[name] = value;
  }
  return out;
}

// With a count, `key` is a plural base and the language's plural category picks the message.
const t = (key, params, count) => (count === undefined ? translate(state.lang, key, resolve(params)) : translatePlural(state.lang, key, count, resolve(params)));
const nf = (n, digits = 0) =>
  new Intl.NumberFormat(langByCode(state.lang).locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(n);

function localizeError(error) {
  const code = error && error.code;
  if (code && Object.hasOwn(langByCode(DEFAULT_LANG).dict, `err.${code}`)) return t(`err.${code}`, error.params);
  return error && error.message ? error.message : String(error);
}

// Dynamic texts are stored as closures, so a language change re-renders them from the same data.
const texts = new Map();
const msg = (key, params, count) => () => t(key, params, count);
const raw = (text) => () => text;

function setText(id, make) {
  texts.set(id, make);
  $(id).textContent = make();
}

function clearText(id) {
  texts.delete(id);
  $(id).textContent = "";
}

function applyStatic() {
  for (const el of document.querySelectorAll("[data-i18n]")) if (!texts.has(el.id)) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-rich]")) renderRich(el, t(el.dataset.i18nRich));
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  for (const el of document.querySelectorAll("[data-i18n-content]")) el.setAttribute("content", t(el.dataset.i18nContent));
  document.title = t("meta.title");
  for (const option of $("chunkSize").options) option.textContent = t("unit.s", { n: nf(Number(option.value) / RATE, Number(option.value) % RATE === 0 ? 0 : 1) });
}

// **bold** and [text](linkId) only (ids live in LINKS); everything else is plain text, so strings can never inject markup.
function renderRich(el, text) {
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*|\[(.+?)\]\((\w+)\)/g)) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = m[1];
      nodes.push(strong);
    } else if (Object.hasOwn(LINKS, m[3])) {
      const link = LINKS[m[3]];
      const a = document.createElement("a");
      a.textContent = m[2];
      a.href = link.href;
      a.className = link.cls;
      if (link.rel) a.rel = link.rel;
      nodes.push(a);
    } else {
      nodes.push(document.createTextNode(m[2])); // unknown link id: keep the words, drop the link
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  el.replaceChildren(...nodes);
}

function initialLang() {
  const query = matchLang(new URLSearchParams(location.search).get("lang"));
  if (query) return query;
  try {
    const stored = matchLang(localStorage.getItem(LANG_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    /* storage unavailable */
  }
  for (const tag of navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) {
    const found = matchLang(tag);
    if (found) return found;
  }
  return DEFAULT_LANG;
}

let langGen = 0;

async function setLanguage(code, { persist = false, url = false } = {}) {
  const lang = langByCode(code);
  const gen = ++langGen;
  try {
    await loadDict(lang.code);
  } catch {
    /* offline or blocked: the English fallback keeps the page usable */
  }
  if (gen !== langGen) return; // a newer choice superseded this one while it loaded
  state.lang = lang.code;
  const root = document.documentElement;
  root.lang = lang.code;
  root.dir = lang.dir;
  $("lang").value = lang.code;
  applyStatic();
  for (const [id, make] of texts) $(id).textContent = make();
  if (state.view) {
    renderChunks(state.view.report);
    $("report").textContent = reportText(state.view.report, state.view.verdict);
  }
  if (persist) {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang.code);
    } catch {
      /* storage unavailable */
    }
  }
  if (url) {
    const next = new URL(location.href);
    next.searchParams.set("lang", lang.code);
    history.replaceState(null, "", next);
  }
}

function buildLangSelect() {
  const select = $("lang");
  for (const l of LANGS) {
    const option = document.createElement("option");
    option.value = l.code;
    option.textContent = l.name;
    option.lang = l.code;
    select.append(option);
  }
  select.addEventListener("change", () => void setLanguage(select.value, { persist: true, url: true }));
}

const tooBig = (file) => msg("problem.tooLargeText", { size: (file.size / 1048576).toFixed(0), max: MAX_FILE_BYTES / 1048576 });

// ---------------------------------------------------------------- keys

const keyCache = new Map();

function forgetKeys() {
  for (const { key } of keyCache.values()) key.fill(0);
  keyCache.clear();
  if (state.seed) state.seed.fill(0);
  state.seed = null;
  state.publicKey = null;
  state.embeddedKey = null;
  $("sealPass").value = "";
  $("verifyPass").value = "";
  $("pinned").value = "";
  setPublicInfo();
  updatePinInfo();
}

async function circleKey(passphrase) {
  if (!keyCache.has(passphrase)) {
    const key = await deriveCircleKey(passphrase);
    keyCache.set(passphrase, { key, keyId: state.vt.circleKeyId(key) });
  }
  return keyCache.get(passphrase);
}

// ---------------------------------------------------------------- audio

function makeSample() {
  const seconds = 6;
  const n = RATE * seconds;
  const out = new Float64Array(n);
  const syllables = [[0.15, 0.75], [0.95, 1.55], [1.75, 2.6], [2.9, 3.4], [3.6, 4.5], [4.8, 5.8]];
  let phase = 0;
  let noise = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let env = 0;
    for (const [a, b] of syllables) if (t >= a && t < b) env = Math.pow(Math.sin((Math.PI * (t - a)) / (b - a)), 0.7);
    const f0 = 125 + 35 * Math.sin(2 * Math.PI * 0.45 * t) + 10 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += (2 * Math.PI * f0) / RATE;
    let v = 0;
    for (let h = 1; h <= 18; h++) {
      const f = h * f0;
      const formant = Math.exp(-(((f - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 300) ** 2)) + 0.25 * Math.exp(-(((f - 2600) / 400) ** 2));
      v += (Math.sin(h * phase) / h) * (0.05 + formant);
    }
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    out[i] = env * v + 0.01 * (noise / 0x7fffffff - 0.5);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.round((out[i] / peak) * 0.6 * 32767);
  return samples;
}

async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } finally {
    ctx.close();
  }
  const seconds = Math.min(decoded.duration, MAX_SECONDS);
  const frames = Math.max(1, Math.floor(seconds * RATE));
  const offline = new OfflineAudioContext(1, frames, RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const channel = rendered.getChannelData(0);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(channel[i] * 32767)));
  return { samples: out, truncated: decoded.duration > MAX_SECONDS };
}

function showAudio(bytes) {
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state.blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  $("player").src = state.blobUrl;
  const link = $("download");
  link.href = state.blobUrl;
  link.hidden = false;
  let sealed = true;
  try {
    sealed = wavInfo(bytes).manifestOffset >= 0;
  } catch {
    sealed = false;
  }
  link.download = sealed ? "unverified.wav" : "unsealed.wav";
}

// "sealed.wav" is only offered for audio that just verified; anything else must not look trusted.
function setDownloadName(verdict, report) {
  const link = $("download");
  if (verdict === "verified") link.download = "sealed.wav";
  else link.download = report && report.check === "absent" ? "unsealed.wav" : "unverified.wav";
}

// ---------------------------------------------------------------- UI helpers

const fmtSeconds = (frames, rate) => t("unit.s", { n: nf(frames / rate, frames % rate === 0 ? 0 : 1) });

function setBusy(on) {
  document.body.style.cursor = on ? "progress" : "";
}

function setAttackEnabled(on) {
  document.querySelectorAll("[data-attack]").forEach((b) => (b.disabled = !on));
  $("atkChunk").disabled = !on;
}

function fillChunkSelect(chunks) {
  const select = $("atkChunk");
  select.replaceChildren();
  for (let i = 0; i < chunks; i++) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = String(i);
    select.append(option);
  }
}

function resetVerdict() {
  verifyGen++; // a verification still in flight belongs to the old audio
  state.view = null;
  setVerdictBox("neutral", msg("v.none.title"), msg("v.none.text"));
  $("chunksBox").hidden = true;
  $("detailsBox").hidden = true;
}

function setAudio(samples, label) {
  // label: a { k, p } translated string or a plain file name
  state.samples = samples;
  state.original = encodeWav(samples, RATE, 1);
  state.sealed = null;
  state.current = null;
  state.external = null;
  setText("audioInfo", msg("audio.info", { label, seconds: nf(samples.length / RATE, 1), khz: RATE / 1000, kb: (state.original.length / 1024).toFixed(0) }));
  showAudio(state.original);
  $("sealBtn").disabled = !state.vt;
  $("verifyBtn").disabled = !state.vt;
  setAttackEnabled(false);
  clearText("sealInfo");
  resetVerdict();
}

// ---------------------------------------------------------------- seal

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function setPublicInfo() {
  if (!state.publicKey) {
    setText("pubInfo", msg("pub.none"));
    $("copyPub").disabled = true;
    return;
  }
  const h = hex(state.publicKey);
  setText("pubInfo", msg("pub.info", { key: `${h.slice(0, 16)}…${h.slice(-8)}` }));
  $("copyPub").disabled = false;
}

function generateKeys() {
  state.seed = crypto.getRandomValues(new Uint8Array(32));
  state.publicKey = state.vt.publicKey(state.seed).publicKey;
  $("pinned").value = hex(state.publicKey);
  setPublicInfo();
}

async function doSeal() {
  if (!state.original) return;
  const mode = selectedMode();
  let key;
  let keyId = 0;
  if (mode === "circle") {
    try {
      ({ key, keyId } = await circleKey($("sealPass").value));
    } catch (error) {
      setText("sealInfo", msg("seal.keyError", { error }));
      return;
    }
  } else {
    if (!state.seed) generateKeys();
    key = state.seed;
  }
  state.chunkFrames = Number($("chunkSize").value);
  state.sealKeyId = keyId;
  setBusy(true);
  try {
    state.sealed = state.vt.seal(state.original, {
      mode,
      key,
      keyId,
      createdUnix: Math.floor(Date.now() / 1000),
      counter: state.counter++,
      chunkFrames: state.chunkFrames,
    });
  } catch (error) {
    setText("sealInfo", msg("seal.error", { error }));
    return;
  } finally {
    setBusy(false);
  }
  state.current = state.sealed;
  state.external = null;
  const chunks = Math.ceil(state.samples.length / state.chunkFrames);
  fillChunkSelect(chunks);
  setAttackEnabled(true);
  setText("sealInfo", msg("seal.done", { mode: { k: `mode.name.${mode}` }, chunks, bytes: state.sealed.length - state.original.length }, chunks));
  showAudio(state.current);
  await runVerify();
}

// ---------------------------------------------------------------- attacks

function chunkRange(index, info, chunkFrames) {
  const frameBytes = info.channels * 2;
  const start = info.pcmOffset + index * chunkFrames * frameBytes;
  const end = Math.min(info.pcmOffset + info.pcmLength, start + chunkFrames * frameBytes);
  return [start, end];
}

async function attack(kind) {
  if (!state.sealed) return;
  try {
    await applyAttack(kind);
  } catch (error) {
    verifyGen++;
    showProblem(msg("problem.attackTitle"), () => localizeError(error));
  }
}

async function applyAttack(kind) {
  let bytes = state.current.slice();
  const info = wavInfo(bytes);
  const index = Number($("atkChunk").value || 0);
  const [start, end] = chunkRange(index, info, state.chunkFrames);
  switch (kind) {
    case "silence":
      bytes.fill(0, start, end);
      break;
    case "flip":
      bytes[Math.min(end - 1, start + (((end - start) >> 2) << 1))] ^= 1;
      break;
    case "swap": {
      const [s2, e2] = chunkRange(index + 1, info, state.chunkFrames);
      if (e2 - s2 !== end - start || e2 <= s2) {
        setText("sealInfo", msg("atk.swapNeedsNext"));
        return;
      }
      const a = bytes.slice(start, end);
      bytes.copyWithin(start, s2, e2);
      bytes.set(a, s2);
      break;
    }
    case "strip":
      bytes = stripManifest(bytes);
      break;
    case "lossy":
      for (let i = info.pcmOffset; i < info.pcmOffset + info.pcmLength; i += 2) bytes[i] = 0;
      break;
    case "reseal": {
      const stripped = stripManifest(bytes);
      const mode = selectedMode();
      const key = crypto.getRandomValues(new Uint8Array(32));
      bytes = state.vt.seal(stripped, {
        mode,
        key,
        keyId: state.sealKeyId,
        createdUnix: Math.floor(Date.now() / 1000),
        counter: 99,
        chunkFrames: state.chunkFrames,
      });
      break;
    }
    case "reset":
      bytes = state.sealed.slice();
      break;
    default:
      return;
  }
  if (kind !== "swap") clearText("sealInfo");
  state.current = bytes;
  state.external = null;
  showAudio(bytes);
  await runVerify();
}

// ---------------------------------------------------------------- verify

function contactFromSelect() {
  switch ($("contact").value) {
    case "always":
      return { alwaysSeals: true, strict: false };
    case "strict":
      return { alwaysSeals: true, strict: true };
    default:
      return null;
  }
}

const listOf = (a) => {
  const shown = a.slice(0, MAX_LISTED).map(String).join(t("list.sep"));
  return a.length > MAX_LISTED ? t("list.more", { list: shown, n: a.length - MAX_LISTED }) : shown;
};

// Returns translation keys (never prose), so the same report can be shown again in another language.
function explain(report, verdict) {
  switch (verdict) {
    case "verified":
      return { title: "v.verified.title", text: "v.verified.text" };
    case "unsealed":
      return { title: "v.unsealed.title", text: report.check === "unknown_key" ? "v.unsealed.unknownKey" : "v.unsealed.absent" };
    case "warning":
      return { title: "v.warning.title", text: "v.warning.text" };
    default:
      break;
  }
  if (report.check === "absent") return { title: "v.alert.absent.title", text: "v.alert.absent.text" };
  if (report.check === "unknown_key") return { title: "v.alert.unknownKey.title", text: "v.alert.unknownKey.text" };
  switch (report.reason) {
    case "modified":
      return {
        title: "v.alert.modified.title",
        text: "v.alert.modified.text",
        count: report.modified_chunks.length,
        params: () => ({ list: listOf(report.modified_chunks) }),
      };
    case "format_changed":
      return { title: "v.alert.format.title", text: "v.alert.format.text" };
    case "bad_authenticator":
      return { title: "v.alert.auth.title", text: "v.alert.auth.text" };
    case "bad_signature":
      return { title: "v.alert.sig.title", text: "v.alert.sig.text" };
    case "unsupported_version":
      return { title: "v.alert.version.title", text: "v.alert.version.text" };
    default:
      return { title: "v.alert.damaged.title", text: "v.alert.damaged.text" };
  }
}

function renderChunks(report) {
  const box = $("chunksBox");
  const list = $("chunks");
  list.replaceChildren();
  if (!report.n_chunks) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (report.n_chunks > MAX_CHUNK_ITEMS) {
    // The count comes from the file; never build an unbounded list of elements from it.
    if (report.authenticated) {
      const n = report.modified_chunks.length;
      setText("chunksNote", () =>
        t("chunks.tooMany", { n: report.n_chunks, detail: n === 0 ? t("chunks.allIntact") : t("chunks.someAltered", { n, list: listOf(report.modified_chunks) }) }),
      );
    } else {
      setText("chunksNote", msg("chunks.hidden"));
    }
    return;
  }
  const bad = new Set(report.modified_chunks);
  for (let i = 0; i < report.n_chunks; i++) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    let status;
    if (!report.authenticated) {
      item.className = "unknown";
      strong.textContent = "?";
      status = t("chunk.unknown");
    } else if (bad.has(i)) {
      item.className = "bad";
      strong.textContent = "✕";
      status = t("chunk.bad");
    } else {
      item.className = "ok";
      strong.textContent = "✓";
      status = t("chunk.ok");
    }
    const from = fmtSeconds(i * report.chunk_frames, report.sample_rate);
    item.append(strong, document.createTextNode(`${from}`), document.createElement("br"), document.createTextNode(status));
    item.setAttribute("aria-label", t("chunk.aria", { i, from, status }));
    list.append(item);
  }
  setText("chunksNote", msg(report.authenticated ? "chunks.trusted" : "chunks.untrusted"));
}

// The report itself is protocol output and stays as-is (LTR, English keys); only the truncation note is translated.
function reportText(report, verdict) {
  let json = JSON.stringify(report, null, 2);
  if (json.length > MAX_REPORT_CHARS) json = `${json.slice(0, MAX_REPORT_CHARS)}\n${t("report.truncated")}`;
  return `${json}\n\nverdict: ${verdict}`;
}

function render(report, verdict) {
  const e = explain(report, verdict);
  setVerdictBox(verdict, msg(e.title), msg(e.text, e.params, e.count));
  state.view = { report, verdict };
  setDownloadName(verdict, report);
  renderChunks(report);
  $("detailsBox").hidden = false;
  $("report").textContent = reportText(report, verdict);
  state.embeddedKey = report.embedded_public_key && report.check === "unknown_key" ? report.embedded_public_key : null;
  $("pinEmbedded").hidden = !state.embeddedKey;
}

function setVerdictBox(kind, title, text) {
  const box = $("verdict");
  box.className = `verdict ${kind}`;
  box.setAttribute("role", "status");
  setText("vTitle", title);
  setText("vText", text);
}

function showProblem(title, text) {
  state.view = null;
  setVerdictBox("alert", title, text);
  $("verdict").setAttribute("role", "alert");
  $("chunksBox").hidden = true;
  $("detailsBox").hidden = true;
  $("pinEmbedded").hidden = true;
  state.embeddedKey = null;
  $("download").download = "unverified.wav";
}

function updatePinInfo() {
  const raw = $("pinned").value.trim();
  const ok = raw === "" || /^[0-9a-fA-F]{64}$/.test(raw);
  if (ok) clearText("pinInfo");
  else setText("pinInfo", msg("pin.invalid", { n: raw.length }));
  $("pinned").setAttribute("aria-invalid", ok ? "false" : "true");
  return ok;
}

async function runVerify() {
  const gen = ++verifyGen;
  const bytes = state.external || state.current;
  if (!state.vt || !bytes) return;
  // Clear first: a slow or failing run must never leave the previous verdict on screen.
  state.view = null;
  setVerdictBox("neutral", msg("v.checking.title"), msg("v.checking.text"));
  $("chunksBox").hidden = true;
  $("detailsBox").hidden = true;
  $("download").download = "unverified.wav";
  try {
    const trust = {};
    const pass = $("verifyPass").value;
    if (pass) {
      const { key, keyId } = await circleKey(pass);
      if (gen !== verifyGen) return;
      trust.circleKey = key;
      trust.circleKeyId = keyId;
    }
    const pinned = $("pinned").value.trim().toLowerCase();
    if (updatePinInfo() && pinned) trust.pinnedPublicKey = unhex(pinned);
    const report = state.vt.verify(bytes, trust);
    if (gen !== verifyGen) return;
    render(report, state.vt.decide(report.check, contactFromSelect()));
  } catch (error) {
    if (gen !== verifyGen) return;
    showProblem(msg("problem.title"), () => localizeError(error));
  }
}

// ---------------------------------------------------------------- wiring

function wire() {
  $("useSample").addEventListener("click", () => setAudio(makeSample(), { k: "audio.sample" }));
  $("pickFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setText("audioInfo", tooBig(file));
      return;
    }
    setText("audioInfo", msg("audio.decoding"));
    try {
      const { samples, truncated } = await decodeFile(file);
      setAudio(samples, truncated ? { k: "audio.truncated", p: { name: user(file.name), n: MAX_SECONDS } } : user(file.name));
    } catch {
      setText("audioInfo", msg("audio.decodeFail"));
    }
  });
  document.querySelectorAll('input[name="mode"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      const mode = selectedMode();
      $("circleBox").hidden = mode !== "circle";
      $("publicBox").hidden = mode !== "public";
    }),
  );
  $("genKeys").addEventListener("click", generateKeys);
  $("copyPub").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(hex(state.publicKey));
      setText("copyPub", msg("keys.copied"));
      setTimeout(() => {
        texts.delete("copyPub");
        $("copyPub").textContent = t("keys.copy");
      }, 1500);
    } catch {
      /* clipboard unavailable */
    }
  });
  $("sealBtn").addEventListener("click", doSeal);
  document.querySelectorAll("[data-attack]").forEach((b) => b.addEventListener("click", () => attack(b.dataset.attack)));
  $("verifyBtn").addEventListener("click", runVerify);
  for (const id of ["verifyPass", "pinned", "contact"]) $(id).addEventListener("change", runVerify);
  $("pinned").addEventListener("input", updatePinInfo);
  $("forgetPin").addEventListener("click", () => {
    $("pinned").value = "";
    updatePinInfo();
    runVerify();
  });
  $("forgetKeys").addEventListener("click", () => {
    forgetKeys();
    runVerify();
  });
  $("pinEmbedded").addEventListener("click", () => {
    if (state.embeddedKey) {
      $("pinned").value = state.embeddedKey;
      runVerify();
    }
  });
  $("verifyFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    verifyGen++; // drop any run still in flight for the previous file
    if (file.size > MAX_FILE_BYTES) {
      showProblem(msg("problem.tooLarge"), tooBig(file));
      return;
    }
    setVerdictBox("neutral", msg("v.reading.title"), () => isolate(file.name));
    try {
      state.external = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      showProblem(msg("problem.readTitle"), () => localizeError(error));
      return;
    }
    showAudio(state.external);
    $("verifyBtn").disabled = false;
    await runVerify();
  });
}

function loadCore() {
  if (typeof WebAssembly !== "object") return Promise.reject(coded("no_wasm", "WebAssembly is not supported"));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(coded("core_timeout", "loading the core timed out")), CORE_TIMEOUT_MS);
  });
  return Promise.race([loadVoxTrust(new URL("./vox_trust.wasm", import.meta.url)), timeout]).finally(() => clearTimeout(timer));
}

async function init() {
  $("coreStatus").hidden = false;
  buildLangSelect();
  wire();
  await setLanguage(initialLang());
  try {
    state.vt = await loadCore();
    setText("coreStatus", msg("core.ready", { abi: state.vt.abiVersion() }));
    $("useSample").disabled = false;
  } catch (error) {
    // "Loading core…" must never stay on screen: show a visible, announced failure instead.
    $("coreStatus").classList.add("err");
    $("coreStatus").setAttribute("role", "alert");
    setText("coreStatus", msg("core.failed"));
    setText("audioInfo", msg("core.loadError", { error }));
    return;
  }
  setAudio(makeSample(), { k: "audio.sample" });
}

init();
