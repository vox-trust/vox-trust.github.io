// Vox Trust browser demo (file mode). Everything runs locally; nothing is uploaded.
import { deriveCircleKey, encodeWav, hex, loadVoxTrust, stripManifest, unhex, wavInfo } from "./vox-trust.js";

const RATE = 16000;
const MAX_SECONDS = 60;
const $ = (id) => document.getElementById(id);

const state = {
  vt: null,
  samples: null, // Int16Array, mono
  original: null, // unsealed WAV bytes
  sealed: null, // sealed WAV bytes
  current: null, // what the verifier sees (sealed, then possibly tampered)
  seed: null,
  publicKey: null,
  sealKeyId: 0,
  counter: 1,
  chunkFrames: 16000,
  blobUrl: null,
};

// ---------------------------------------------------------------- keys

const keyCache = new Map();

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

function samplesOf(bytes) {
  const info = wavInfo(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset + info.pcmOffset, info.pcmLength);
  const out = new Int16Array(info.pcmLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(2 * i, true);
  return { samples: out, info };
}

function drawWave(samples, { badChunks = [], chunkFrames = 0, channels = 1 } = {}) {
  const canvas = $("wave");
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!samples || samples.length === 0) return;
  const css = getComputedStyle(document.documentElement);
  const color = css.getPropertyValue("--wave").trim() || "#3b4a63";
  const bad = css.getPropertyValue("--wave-bad").trim() || "#a0222a";
  const frames = Math.floor(samples.length / channels);
  if (chunkFrames > 0) {
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = bad;
    for (const i of badChunks) {
      const x0 = ((i * chunkFrames) / frames) * w;
      const x1 = Math.min(w, (((i + 1) * chunkFrames) / frames) * w);
      ctx.fillRect(x0, 0, x1 - x0, h);
    }
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = color;
    for (let i = 1; i * chunkFrames < frames; i++) ctx.fillRect(Math.round(((i * chunkFrames) / frames) * w), 0, 1, h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x / w) * frames);
    const b = Math.max(a + 1, Math.floor(((x + 1) / w) * frames));
    let lo = 0;
    let hi = 0;
    for (let f = a; f < b && f < frames; f += Math.max(1, (b - a) >> 4)) {
      const s = samples[f * channels] / 32768;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
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
  link.download = sealed ? "sealed.wav" : "unsealed.wav";
}

// ---------------------------------------------------------------- UI helpers

const fmtSeconds = (frames, rate) => `${(frames / rate).toFixed(frames % rate === 0 ? 0 : 1)} s`;

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
  const box = $("verdict");
  box.className = "verdict neutral";
  $("vIcon").textContent = "·";
  $("vTitle").textContent = "Nothing verified yet";
  $("vText").textContent = "Seal some audio, then verify it.";
  $("chunksBox").hidden = true;
  $("detailsBox").hidden = true;
}

function setAudio(samples, label) {
  state.samples = samples;
  state.original = encodeWav(samples, RATE, 1);
  state.sealed = null;
  state.current = null;
  $("audioInfo").textContent = `${label}: ${(samples.length / RATE).toFixed(1)} s, ${RATE / 1000} kHz mono, ${(state.original.length / 1024).toFixed(0)} KB.`;
  drawWave(samples);
  showAudio(state.original);
  $("sealBtn").disabled = !state.vt;
  $("verifyBtn").disabled = !state.vt;
  setAttackEnabled(false);
  $("sealInfo").textContent = "";
  resetVerdict();
}

// ---------------------------------------------------------------- seal

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function setPublicInfo() {
  if (!state.publicKey) {
    $("pubInfo").textContent = "No key pair yet. The private key stays in memory in this page.";
    $("copyPub").disabled = true;
    return;
  }
  const h = hex(state.publicKey);
  $("pubInfo").textContent = `Public key: ${h.slice(0, 16)}…${h.slice(-8)} (the full key was pinned for you below; the private key stays in this page).`;
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
    ({ key, keyId } = await circleKey($("sealPass").value));
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
    $("sealInfo").textContent = `Could not seal: ${error.message}`;
    return;
  } finally {
    setBusy(false);
  }
  state.current = state.sealed;
  const chunks = Math.ceil(state.samples.length / state.chunkFrames);
  fillChunkSelect(chunks);
  setAttackEnabled(true);
  $("sealInfo").textContent = `Sealed in ${mode} mode: ${chunks} chunks, ${state.sealed.length - state.original.length} bytes added to the file. The audio samples are untouched.`;
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
        $("sealInfo").textContent = "Pick a chunk that has a full-size chunk after it to swap with.";
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
  if (kind !== "swap") $("sealInfo").textContent = "";
  state.current = bytes;
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

function explain(report, verdict) {
  const list = (a) => a.join(", ");
  switch (verdict) {
    case "verified":
      return ["Verified", "Sealed by a key you trust, and the audio is exactly as it was sealed."];
    case "unsealed":
      if (report.check === "unknown_key") {
        return ["Unsealed", "A seal exists, but under a key you don't trust (yet). Nothing is verified. Check the key another way before pinning it."];
      }
      return ["Unsealed", "No seal found. That is normal for someone who doesn't use the protocol, so it does not mean the audio is fake. It also means nothing was verified."];
    case "warning":
      return ["No seal, from someone who usually seals", "Be careful. Compression or noise suppression can also erase a seal, so ask them to send it again, or confirm another way."];
    default:
      break;
  }
  if (report.check === "absent") return ["Alert: no seal (strict mode)", "This contact always seals, and this audio has no seal."];
  if (report.check === "unknown_key") return ["Alert: sealed by a different key", "This audio is sealed, but not by the key you have for this contact. Someone may be impersonating them."];
  switch (report.reason) {
    case "modified":
      return ["Alert: the audio was changed", `The seal is genuine but the audio no longer matches it. Altered chunk${report.modified_chunks.length === 1 ? "" : "s"}: ${list(report.modified_chunks)}.`];
    case "format_changed":
      return ["Alert: length or format changed", "The audio's length, sample rate or channel count differs from what was sealed."];
    case "bad_authenticator":
      return ["Alert: the seal does not match your key", "Wrong passphrase, or someone forged or altered the seal."];
    case "bad_signature":
      return ["Alert: broken signature", "The seal was altered after it was made."];
    case "unsupported_version":
      return ["Alert: unknown seal version", "This file was sealed with a version this demo does not understand."];
    default:
      return ["Alert: damaged seal", "The seal in this file is malformed."];
  }
}

function renderChunks(report) {
  const box = $("chunksBox");
  if (!report.n_chunks) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const list = $("chunks");
  list.replaceChildren();
  const bad = new Set(report.modified_chunks);
  for (let i = 0; i < report.n_chunks; i++) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    let status;
    if (!report.authenticated) {
      item.className = "unknown";
      strong.textContent = "?";
      status = "can't tell";
    } else if (bad.has(i)) {
      item.className = "bad";
      strong.textContent = "✕";
      status = "altered";
    } else {
      item.className = "ok";
      strong.textContent = "✓";
      status = "intact";
    }
    const from = fmtSeconds(i * report.chunk_frames, report.sample_rate);
    item.append(strong, document.createTextNode(`${from}`), document.createElement("br"), document.createTextNode(status));
    item.setAttribute("aria-label", `Chunk ${i} from ${from}: ${status}`);
    list.append(item);
  }
  $("chunksNote").textContent = report.authenticated
    ? "Chunk results are trustworthy because the seal itself verified."
    : "Chunk results are not shown as fact: the seal itself is not trusted, so the chunk list could be forged.";
}

function render(report, verdict) {
  const [title, text] = explain(report, verdict);
  $("verdict").className = `verdict ${verdict}`;
  $("vIcon").textContent = { verified: "✓", unsealed: "–", warning: "!", alert: "✕" }[verdict];
  $("vTitle").textContent = title;
  $("vText").textContent = text;
  renderChunks(report);
  $("detailsBox").hidden = false;
  $("report").textContent = `${JSON.stringify(report, null, 2)}\n\nverdict: ${verdict}`;
  $("pinEmbedded").hidden = !(report.embedded_public_key && report.check === "unknown_key");
  try {
    const { samples, info } = samplesOf(state.current);
    drawWave(samples, { badChunks: report.authenticated ? report.modified_chunks : [], chunkFrames: report.chunk_frames || 0, channels: info.channels });
  } catch {
    /* not drawable */
  }
}

async function runVerify() {
  if (!state.vt || !state.current) return;
  const trust = {};
  const pass = $("verifyPass").value;
  if (pass) {
    const { key, keyId } = await circleKey(pass);
    trust.circleKey = key;
    trust.circleKeyId = keyId;
  }
  const pinned = $("pinned").value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(pinned)) trust.pinnedPublicKey = unhex(pinned);
  let report;
  try {
    report = state.vt.verify(state.current, trust);
  } catch (error) {
    $("verdict").className = "verdict alert";
    $("vIcon").textContent = "✕";
    $("vTitle").textContent = "Could not read this file";
    $("vText").textContent = error.message;
    $("chunksBox").hidden = true;
    $("detailsBox").hidden = true;
    return;
  }
  if (report.chunk_frames) state.chunkFrames = report.chunk_frames;
  render(report, state.vt.decide(report.check, contactFromSelect()));
}

// ---------------------------------------------------------------- wiring

function wire() {
  $("useSample").addEventListener("click", () => setAudio(makeSample(), "Sample clip"));
  $("pickFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    $("audioInfo").textContent = "Decoding…";
    try {
      const { samples, truncated } = await decodeFile(file);
      setAudio(samples, truncated ? `${file.name} (first ${MAX_SECONDS} s)` : file.name);
    } catch {
      $("audioInfo").textContent = "Your browser could not decode that file. Try a WAV, MP3 or M4A.";
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
      $("copyPub").textContent = "Copied";
      setTimeout(() => ($("copyPub").textContent = "Copy public key"), 1500);
    } catch {
      /* clipboard unavailable */
    }
  });
  $("sealBtn").addEventListener("click", doSeal);
  document.querySelectorAll("[data-attack]").forEach((b) => b.addEventListener("click", () => attack(b.dataset.attack)));
  $("verifyBtn").addEventListener("click", runVerify);
  for (const id of ["verifyPass", "pinned", "contact"]) $(id).addEventListener("change", runVerify);
  $("forgetPin").addEventListener("click", () => {
    $("pinned").value = "";
    runVerify();
  });
  $("pinEmbedded").addEventListener("click", () => {
    const m = /"embedded_public_key": "([0-9a-f]{64})"/.exec($("report").textContent);
    if (m) {
      $("pinned").value = m[1];
      runVerify();
    }
  });
  $("verifyFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    state.current = new Uint8Array(await file.arrayBuffer());
    showAudio(state.current);
    $("verifyBtn").disabled = false;
    await runVerify();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.samples && runVerify());
}

async function init() {
  wire();
  try {
    state.vt = await loadVoxTrust(new URL("./vox_trust.wasm", import.meta.url));
    $("coreStatus").textContent = `Core ready · ABI ${state.vt.abiVersion()}`;
    $("useSample").disabled = false;
  } catch (error) {
    $("coreStatus").textContent = "Core failed to load";
    $("audioInfo").textContent = `The WebAssembly core could not be loaded: ${error.message}`;
    return;
  }
  setAudio(makeSample(), "Sample clip");
}

init();
