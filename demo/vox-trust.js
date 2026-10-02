// Vox Trust: thin JavaScript wrapper over the WebAssembly core (C ABI, ABI version 1).
// No dependencies. Works in browsers and in Node 20+. Pre-alpha, unaudited.
//
// All cryptography happens inside the WebAssembly module, which has no imports: it cannot
// reach the network, the DOM or the file system. This file only moves bytes in and out.

const ABI_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Error with a stable machine-readable `code` (and `params`) so UIs can localize the message. */
export const coded = (code, message, params = {}) => Object.assign(new Error(message), { code, params });

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const unhex = (text) => {
  if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) throw coded("invalid_hex", "invalid hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** Derives a 32-byte circle key from a passphrase with PBKDF2-HMAC-SHA-256 (WebCrypto). */
export async function deriveCircleKey(passphrase, salt = "vox-trust/0/passphrase", iterations = 600000) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Loads the WebAssembly core from bytes (ArrayBuffer/Uint8Array) or a URL string. */
export async function loadVoxTrust(source) {
  let bytes = source;
  if (typeof source === "string" || source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok) throw coded("core_http", `could not load the WebAssembly core: HTTP ${response.status}`, { status: response.status });
    bytes = await response.arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  if (x.vt_abi_version() !== ABI_VERSION) {
    throw coded("core_abi", `unsupported core ABI version ${x.vt_abi_version()}, expected ${ABI_VERSION}`, { got: x.vt_abi_version(), expected: ABI_VERSION });
  }

  // Copies `data` into the module and records the block in `held`, so the caller's `finally`
  // frees it even if a later copy throws. Secret blocks (keys, seeds) are zeroed before freeing.
  const put = (held, data, secret = false) => {
    const ptr = x.vt_alloc(data.length);
    if (ptr === 0) throw coded("core_oom", `not enough memory for ${data.length} bytes`, { bytes: data.length });
    const block = { ptr, len: data.length, secret };
    held.push(block);
    new Uint8Array(x.memory.buffer, ptr, data.length).set(data);
    return block;
  };
  const release = (held) => {
    for (const b of held) {
      if (b.secret) new Uint8Array(x.memory.buffer, b.ptr, b.len).fill(0);
      x.vt_free(b.ptr, b.len);
    }
  };
  const result = () => new Uint8Array(x.memory.buffer, x.vt_result_ptr(), x.vt_result_len()).slice();
  const fail = () => {
    throw new Error(decoder.decode(result()));
  };
  const needKey = (key, name) => {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error(`${name} must be 32 bytes`);
  };
  const split64 = (n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("createdUnix must be a non-negative integer");
    return [Math.floor(n / 2 ** 32), n >>> 0];
  };
  const u32 = (n, name) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`${name} must be a 32-bit unsigned integer`);
    return n >>> 0;
  };

  const MODES = { circle: 0, public: 1 };
  const CHECK_CODES = { valid: 0, invalid: 1, unknown_key: 2, absent: 3 };
  const VERDICTS = ["verified", "unsealed", "warning", "alert"];

  return {
    abiVersion: () => x.vt_abi_version(),

    /** Size in bytes of the module's linear memory (a diagnostic, used by the leak test). */
    memoryBytes: () => x.memory.buffer.byteLength,

    /** The recommended identifier of a 32-byte circle key (computed by the core). */
    circleKeyId(key) {
      needKey(key, "key");
      const held = [];
      try {
        const k = put(held, key, true);
        return x.vt_circle_key_id(k.ptr) >>> 0;
      } finally {
        release(held);
      }
    },

    /** Public key and key id (hex) for an Ed25519 seed. */
    publicKey(seed) {
      needKey(seed, "seed");
      const held = [];
      try {
        const s = put(held, seed, true);
        if (x.vt_public_key(s.ptr) !== 0) fail();
        const parsed = JSON.parse(decoder.decode(result()));
        return { publicKey: unhex(parsed.public_key), keyId: parseInt(parsed.key_id, 16) };
      } finally {
        release(held);
      }
    },

    /**
     * Seals a 16-bit PCM WAV file. Returns the sealed WAV bytes.
     * options: { mode: "circle"|"public", key (32 bytes: secret or Ed25519 seed), keyId, createdUnix, counter, chunkFrames }
     */
    seal(wav, { mode, key, keyId = 0, createdUnix, counter = 0, chunkFrames }) {
      if (!(mode in MODES)) throw new Error('mode must be "circle" or "public"');
      needKey(key, "key");
      const [hi, lo] = split64(createdUnix);
      const held = [];
      try {
        const w = put(held, wav);
        const k = put(held, key, true);
        const status = x.vt_seal(
          w.ptr, w.len, MODES[mode], k.ptr, k.len,
          u32(keyId, "keyId"), hi, lo, u32(counter, "counter"), u32(chunkFrames, "chunkFrames"),
        );
        if (status !== 0) fail();
        return result();
      } finally {
        release(held);
      }
    },

    /**
     * Verifies a WAV file. trust: { circleKey?, circleKeyId?, pinnedPublicKey? }.
     * Returns the report object (see the spec), with `check` one of
     * "valid" | "invalid" | "unknown_key" | "absent".
     */
    verify(wav, { circleKey, circleKeyId = 0, pinnedPublicKey } = {}) {
      if (circleKey) needKey(circleKey, "circleKey");
      if (pinnedPublicKey) needKey(pinnedPublicKey, "pinnedPublicKey");
      const held = [];
      try {
        const w = put(held, wav);
        const c = circleKey ? put(held, circleKey, true) : null;
        const p = pinnedPublicKey ? put(held, pinnedPublicKey) : null;
        const status = x.vt_verify(
          w.ptr, w.len, c ? c.ptr : 0, c ? c.len : 0, u32(circleKeyId, "circleKeyId"),
          p ? p.ptr : 0, p ? p.len : 0,
        );
        if (status !== 0) fail();
        return JSON.parse(decoder.decode(result()));
      } finally {
        release(held);
      }
    },

    /**
     * Applies the trust policy to a check. contact: { alwaysSeals, strict } or null when the
     * speaker is unknown. Returns "verified" | "unsealed" | "warning" | "alert".
     */
    decide(check, contact = null) {
      if (!(check in CHECK_CODES)) throw new Error(`unknown check "${check}"`);
      const code = x.vt_decide(
        CHECK_CODES[check],
        contact ? 1 : 0,
        contact && contact.alwaysSeals ? 1 : 0,
        contact && contact.strict ? 1 : 0,
      );
      return VERDICTS[code];
    },
  };
}

/**
 * Minimal, tolerant RIFF reader used by the demo's tamper tools (the strict parser lives in
 * the WebAssembly core). Returns offsets into `bytes`, or throws if it is not 16-bit PCM WAV.
 */
export function wavInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw coded("not_wav", "not a WAV file");
  const info = { channels: 0, sampleRate: 0, bits: 0, pcmOffset: -1, pcmLength: 0, manifestOffset: -1, manifestLength: 0, chunks: [] };
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const start = pos + 8;
    info.chunks.push({ id, start, size });
    if (id === "fmt ") {
      info.channels = view.getUint16(start + 2, true);
      info.sampleRate = view.getUint32(start + 4, true);
      info.bits = view.getUint16(start + 14, true);
    } else if (id === "data") {
      info.pcmOffset = start;
      info.pcmLength = size;
    } else if (id === "VOXT") {
      info.manifestOffset = start;
      info.manifestLength = size;
    }
    pos = start + size + (size & 1);
  }
  if (info.pcmOffset < 0 || info.bits !== 16) throw coded("only_pcm16", "only 16-bit PCM WAV is supported");
  return info;
}

/** Builds a 16-bit PCM WAV file from an Int16Array of interleaved samples. */
export function encodeWav(samples, sampleRate, channels = 1) {
  const dataLength = samples.length * 2;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const put4 = (o, s) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  put4(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  put4(8, "WAVE");
  put4(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  put4(36, "data");
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + 2 * i, samples[i], true);
  return out;
}

/** Returns a copy of the WAV with the VOXT manifest chunk removed (an "unsealed" file). */
export function stripManifest(bytes) {
  const info = wavInfo(bytes);
  const keep = info.chunks.filter((c) => c.id !== "VOXT");
  const parts = keep.map((c) => {
    const padded = c.size + (c.size & 1);
    return bytes.subarray(c.start - 8, c.start + padded);
  });
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(bytes.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
