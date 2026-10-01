// Language registry and the small translation runtime. Plain ES modules, no build step.
// English is bundled (it is the fallback and the first paint); other languages load on demand.
import en from "./en.js";

export const DEFAULT_LANG = "en";

// Native names are never translated. `locale` drives number formatting and plural rules (Latin digits everywhere).
// `dict` is filled in by loadDict(); until then lookups fall back to English.
export const LANGS = [
  { code: "en", name: "English", dir: "ltr", locale: "en", dict: en },
  { code: "pt-BR", name: "Português (Brasil)", dir: "ltr", locale: "pt-BR", dict: null },
  { code: "es", name: "Español", dir: "ltr", locale: "es", dict: null },
  { code: "zh-Hans", name: "中文(简体)", dir: "ltr", locale: "zh-CN", dict: null },
  { code: "ar", name: "العربية", dir: "rtl", locale: "ar-u-nu-latn", dict: null },
];

// Targets of [text](id) in dictionary strings. Only these ids exist; anything else renders as plain text.
export const LINKS = {
  src: { href: "https://github.com/vox-trust/vox-trust/tree/main/web", cls: "ltr" },
  author: { href: "https://www.linkedin.com/in/rogeroliveira/", cls: "iso", rel: "me noopener" },
};

const byCode = new Map(LANGS.map((l) => [l.code, l]));
const modules = {
  "pt-BR": () => import("./pt-BR.js"),
  es: () => import("./es.js"),
  "zh-Hans": () => import("./zh-Hans.js"),
  ar: () => import("./ar.js"),
};

/** Loads (once) the dictionary of `code` and returns it; English is always available. */
export async function loadDict(code) {
  const l = langByCode(code);
  if (!l.dict) l.dict = (await modules[l.code]()).default;
  return l.dict;
}

/** Maps a tag such as "pt", "pt-br", "zh-CN" or "es-MX" to a supported code, or null. */
export function matchLang(tag) {
  if (typeof tag !== "string") return null;
  const parts = tag.trim().replace(/_/g, "-").toLowerCase().split("-");
  const base = parts[0];
  if (base === "en") return "en";
  if (base === "pt") return "pt-BR";
  if (base === "es") return "es";
  if (base === "ar") return "ar";
  if (base === "zh") {
    // Traditional Chinese readers are not silently given Simplified; they fall through.
    const traditional = parts.includes("hant") || ["tw", "hk", "mo"].includes(parts[parts.length - 1]);
    return traditional ? null : "zh-Hans";
  }
  return null;
}

export const langByCode = (code) => byCode.get(code) || byCode.get(DEFAULT_LANG);

const FSI = "⁨";
const PDI = "⁩";

/** Removes control and format characters (Cc, Cf): bidi overrides, zero-width marks, newlines. */
export const stripControls = (text) => String(text).replace(/[\p{Cc}\p{Cf}]/gu, "");

/** Text from outside the page (a file name, a label): cleaned, then isolated so it cannot reorder its neighbours. */
export const isolate = (text) => `${FSI}${stripControls(text)}${PDI}`;

/** Marks a param as user-supplied: translate() always cleans and isolates it, in every language. */
export const user = (text) => ({ user: String(text) });

const own = (dict, key) => (dict && Object.hasOwn(dict, key) ? dict[key] : undefined);

function lookup(lang, key) {
  const raw = own(langByCode(lang).dict, key) ?? own(en, key);
  return typeof raw === "string" ? raw : undefined;
}

function fill(l, raw, params) {
  return raw.replace(/\{(\w+)\}/g, (m, name) => {
    if (!Object.hasOwn(params, name)) return m;
    const value = params[name];
    if (value && typeof value === "object" && "user" in value) return isolate(value.user);
    return l.dir === "rtl" ? `${FSI}${String(value)}${PDI}` : String(value);
  });
}

/**
 * Looks up `key` in `lang`, falling back to English, then to the key itself. {name} placeholders are
 * replaced in a single pass (a value is never re-scanned); in RTL languages each value is wrapped in a
 * bidi isolate so numbers and hex keep their own direction. Values made with user() are always isolated.
 */
export function translate(lang, key, params = {}) {
  return fill(langByCode(lang), lookup(lang, key) ?? key, params);
}

/** The plural category CLDR assigns to `count` in `lang` (zero, one, two, few, many, other). */
export const pluralCategory = (lang, count) => new Intl.PluralRules(langByCode(lang).locale).select(count);

/**
 * Plural-aware lookup: tries `base_<category>` for the language, then `base_other`, then English the same
 * way. {n} is the count unless params say otherwise.
 */
export function translatePlural(lang, base, count, params = {}) {
  const category = pluralCategory(lang, count);
  const key = [`${base}_${category}`, `${base}_other`].find((k) => own(langByCode(lang).dict, k) !== undefined) ?? [`${base}_${category}`, `${base}_other`].find((k) => own(en, k) !== undefined);
  return translate(lang, key ?? base, { n: count, ...params });
}
