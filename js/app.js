import { THEMES } from "./words.js";

const $ = (id) => document.getElementById(id);

const screens = {
  home: $("screen-home"),
  levels: $("screen-levels"),
  themes: $("screen-themes"),
  play: $("screen-play"),
  done: $("screen-done"),
};

const els = {
  themeGrid: $("theme-grid"),
  picture: $("picture"),
  word: $("word"),
  status: $("status"),
  micDot: $("mic-dot"),
  progress: $("progress"),
  overlay: $("overlay"),
  overlayImg: $("overlay-img"),
  overlayText: $("overlay-text"),
  parentHelp: $("parent-help"),
  toast: $("toast"),
  playTitle: $("play-title"),
  doneTitle: $("done-title"),
  hint: $("btn-hint"),
  hearAgain: $("btn-hear-again"),
  voiceMeter: $("voice-meter"),
};

const audio = {
  correctSfx: new Audio("audio/sfx/correct.wav"),
  wrongSfx: new Audio("audio/sfx/wrong.wav"),
  correct: new Audio("audio/phrases/correct.wav"),
  tryagain: new Audio("audio/phrases/tryagain.wav"),
  bravo: new Audio("audio/phrases/bravo.wav"),
  word: new Audio(),
};

for (const a of Object.values(audio)) {
  a.preload = "auto";
}

const LANGS = ["zh-HK", "zh-TW", "zh-CN"];

let state = {
  level: 1,
  theme: null,
  index: 0,
  token: 0,
  listening: false,
  recognizer: null,
  ignoreUntil: 0,
  micReady: false,
};

function showScreen(name) {
  for (const s of Object.values(screens)) s.classList.remove("active");
  screens[name].classList.add("active");
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function playAudio(el) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("ended", done);
      el.removeEventListener("error", done);
      resolve();
    };
    try {
      el.pause();
      el.currentTime = 0;
      el.addEventListener("ended", done);
      el.addEventListener("error", done);
      const p = el.play();
      if (p && p.catch) p.catch(done);
      setTimeout(done, Math.max(600, ((el.duration || 1.2) * 1000) + 250));
    } catch {
      done();
    }
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function currentWord() {
  return state.theme.words[state.index];
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[āáǎà]/g, "a")
    .replace(/[ēéěè]/g, "e")
    .replace(/[īíǐì]/g, "i")
    .replace(/[ōóǒò]/g, "o")
    .replace(/[ūúǔù]/g, "u")
    .replace(/[\s，。！？、.,!?;:：；'"「」『』（）()~～\-]/g, "")
    .replace(/[0-9]/g, "")
    .replace(/[啊呀哦嗯啦喎囉咯嘅咗哩呢嗎吗吧]/g, "");
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function isMatch(heard, word) {
  const h = normalize(heard);
  if (!h) return false;
  const targets = [word.text, ...(word.aliases || [])].map(normalize).filter(Boolean);
  for (const t of targets) {
    if (h === t) return true;
    if (h.includes(t)) return true;
    if (t.length === 1 && h.includes(t)) return true;
    if (t.length >= 2 && h.length >= 2 && t.includes(h)) return true;
    if (t.length >= 2) {
      const d = levenshtein(h, t);
      if (d <= 1) return true;
      const hits = [...t].filter((ch) => h.includes(ch)).length;
      if (hits === t.length && Math.abs(h.length - t.length) <= 2) return true;
    }
  }
  return false;
}

function SpeechCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setMeter(on) {
  if (!els.voiceMeter) return;
  els.voiceMeter.classList.toggle("on", on);
  els.voiceMeter.dataset.level = on ? "3" : "0";
}

async function ensureMic() {
  if (state.micReady) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    stream.getTracks().forEach((t) => t.stop());
    state.micReady = true;
    return true;
  } catch {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      state.micReady = true;
      return true;
    } catch {
      return false;
    }
  }
}

function stopListening() {
  state.listening = false;
  els.micDot.classList.remove("on");
  setMeter(false);
  try {
    if (state.recognizer) state.recognizer.stop();
  } catch {
    /* ignore */
  }
}

function collectTranscripts(ev) {
  const texts = [];
  for (let i = 0; i < ev.results.length; i++) {
    for (let j = 0; j < ev.results[i].length; j++) {
      const t = (ev.results[i][j].transcript || "").trim();
      if (t) texts.push(t);
    }
  }
  return texts;
}

function bindGrammar(rec, word) {
  try {
    const G = window.SpeechGrammarList || window.webkitSpeechGrammarList;
    if (!G) return;
    const terms = [word.text, ...(word.aliases || [])]
      .filter((t) => /[\u4e00-\u9fff]/.test(t))
      .slice(0, 8);
    if (!terms.length) return;
    const list = new G();
    list.addFromString(`#JSGF V1.0; grammar w; public <w> = ${terms.join(" | ")} ;`, 1);
    rec.grammars = list;
  } catch {
    /* grammar is optional */
  }
}

function listenUntilMatch(token, word) {
  return new Promise((resolve) => {
    const Ctor = SpeechCtor();
    if (!Ctor) {
      resolve({ text: "", reason: "unsupported" });
      return;
    }

    let rec = null;
    let settled = false;
    let restarting = false;
    let langIndex = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      state.listening = false;
      els.micDot.classList.remove("on");
      setMeter(false);
      try { if (rec) rec.stop(); } catch { /* ignore */ }
      resolve(value);
    };

    const startRec = () => {
      if (settled || restarting) return;
      if (token !== state.token) {
        finish({ text: "", reason: "cancelled" });
        return;
      }
      rec = new Ctor();
      state.recognizer = rec;
      rec.lang = LANGS[langIndex % LANGS.length];
      langIndex += 1;
      rec.interimResults = true;
      rec.maxAlternatives = 8;
      rec.continuous = true;
      bindGrammar(rec, word);

      rec.onresult = (ev) => {
        if (settled || token !== state.token) return;
        if (Date.now() < state.ignoreUntil) return;
        const texts = collectTranscripts(ev);
        for (const t of texts) {
          if (isMatch(t, word)) {
            finish({ text: t, reason: "ok" });
            return;
          }
        }
      };
      rec.onerror = (ev) => {
        const err = ev.error || "error";
        if (err === "no-speech" || err === "aborted" || err === "audio-capture" || err === "network") return;
        if (err === "not-allowed" || err === "service-not-allowed") {
          finish({ text: "", reason: err });
        }
      };
      rec.onend = () => {
        if (settled) return;
        if (token !== state.token) {
          finish({ text: "", reason: "cancelled" });
          return;
        }
        restarting = true;
        setTimeout(() => {
          restarting = false;
          startRec();
        }, 80);
      };

      try {
        rec.start();
      } catch {
        restarting = true;
        setTimeout(() => {
          restarting = false;
          startRec();
        }, 200);
      }
    };

    state.listening = true;
    els.micDot.classList.add("on");
    setMeter(true);
    startRec();
  });
}

function needsParent(heard) {
  return ["unsupported", "no-media", "mic-denied", "not-allowed", "service-not-allowed"].includes(
    heard.reason
  );
}

function setStatus(text, listening = false) {
  els.status.textContent = text;
  els.micDot.classList.toggle("on", listening);
  setMeter(listening);
}

function renderProgress() {
  els.progress.innerHTML = "";
  state.theme.words.forEach((_, i) => {
    const d = document.createElement("span");
    d.className = "dot" + (i < state.index ? " done" : i === state.index ? " now" : "");
    els.progress.appendChild(d);
  });
}

function showOverlay(kind, text, img) {
  els.overlay.className = "overlay show " + kind;
  els.overlayText.textContent = text;
  els.overlayImg.src = img;
  els.overlayImg.alt = text;
}

function hideOverlay() {
  els.overlay.className = "overlay";
}

function showParentHelp(on) {
  els.parentHelp.classList.toggle("show", on);
}

function showHint(on) {
  els.hint.classList.toggle("show", on && state.level === 2);
}

function setLevelChrome() {
  els.hearAgain.hidden = state.level === 2;
  showHint(state.level === 2);
}

function muteMatching(ms) {
  state.ignoreUntil = Date.now() + ms;
}

async function playPrompt() {
  muteMatching(8000);
  await playAudio(audio.word);
  muteMatching(250);
}

async function unlockAudioAndMic() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      await ctx.resume();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {
    /* ignore */
  }
  for (const a of [audio.correctSfx, audio.wrongSfx, audio.correct, audio.tryagain, audio.bravo]) {
    try {
      a.muted = true;
      await a.play();
      a.pause();
      a.currentTime = 0;
      a.muted = false;
    } catch {
      a.muted = false;
    }
  }
  const ok = await ensureMic();
  if (!ok) toast("請允許使用麥克風，小朋友先可以讀俾遊戲聽。");
}

function renderThemes() {
  els.themeGrid.innerHTML = "";
  for (const theme of THEMES) {
    const btn = document.createElement("button");
    btn.className = "theme-card";
    btn.innerHTML = `<img src="${theme.cover}" alt="${theme.title}"><span>${theme.title}</span>`;
    btn.addEventListener("click", () => startTheme(theme));
    els.themeGrid.appendChild(btn);
  }
}

function chooseLevel(level) {
  state.level = level;
  renderThemes();
  showScreen("themes");
}

function startTheme(theme) {
  state.theme = theme;
  state.index = 0;
  els.playTitle.textContent = "Level " + state.level + " · " + theme.title;
  setLevelChrome();
  showScreen("play");
  runCard();
}

async function runCard() {
  const token = ++state.token;
  hideOverlay();
  showParentHelp(false);
  stopListening();
  const word = currentWord();
  els.picture.src = `images/words/${word.id}.jpg`;
  els.picture.alt = word.text;
  els.word.textContent = word.text;
  renderProgress();
  audio.word.src = `audio/words/${word.id}.wav`;
  setLevelChrome();
  await playRound(token);
}

async function playRound(token) {
  const word = currentWord();
  if (token !== state.token) return;

  await ensureMic();
  if (token !== state.token) return;

  if (!SpeechCtor()) {
    setStatus("家長幫手聽一聽");
    showParentHelp(true);
    return;
  }

  muteMatching(60000);
  const heardPromise = listenUntilMatch(token, word);

  if (state.level === 1) {
    showHint(false);
    setStatus("聽一聽");
    await wait(280);
    if (token !== state.token) return;
    await playPrompt();
    if (token !== state.token) return;
    setStatus("隨時讀：" + word.text, true);
  } else {
    showHint(true);
    setStatus("隨時讀出來", true);
    muteMatching(200);
  }

  const parentTimer = setTimeout(() => {
    if (token !== state.token) return;
    showParentHelp(true);
  }, 14000);

  const heard = await heardPromise;
  clearTimeout(parentTimer);
  if (token !== state.token) return;

  if (heard.reason === "cancelled") return;
  if (needsParent(heard)) {
    setStatus("家長幫手聽一聽");
    showParentHelp(true);
    return;
  }

  await celebrate(token);
}

async function celebrate(token) {
  stopListening();
  showParentHelp(false);
  showOverlay("ok", "答對了", "images/ui/correct.jpg");
  playAudio(audio.correctSfx);
  await wait(180);
  await playAudio(audio.correct);
  if (token !== state.token) return;
  await wait(700);
  if (token !== state.token) return;
  nextWord();
}

function nextWord() {
  state.index += 1;
  if (state.index >= state.theme.words.length) {
    stopListening();
    els.doneTitle.textContent = state.theme.title + " 完成了！";
    showScreen("done");
    playAudio(audio.bravo);
    playAudio(audio.correctSfx);
    return;
  }
  runCard();
}

$("btn-start").addEventListener("click", async () => {
  $("btn-start").disabled = true;
  await unlockAudioAndMic();
  $("btn-start").disabled = false;
  showScreen("levels");
});

$("btn-level-1").addEventListener("click", () => chooseLevel(1));
$("btn-level-2").addEventListener("click", () => chooseLevel(2));

$("btn-back-home").addEventListener("click", () => {
  state.token += 1;
  stopListening();
  showScreen("home");
});

$("btn-back-levels").addEventListener("click", () => {
  state.token += 1;
  stopListening();
  showScreen("levels");
});

$("btn-back-themes").addEventListener("click", () => {
  state.token += 1;
  stopListening();
  hideOverlay();
  showHint(false);
  showScreen("themes");
});

$("btn-replay").addEventListener("click", () => {
  state.token += 1;
  runCard();
});

$("btn-parent-yes").addEventListener("click", () => {
  celebrate(state.token);
});

$("btn-parent-no").addEventListener("click", async () => {
  const token = state.token;
  showParentHelp(false);
  if (!state.listening) {
    playRound(token);
    return;
  }
  if (state.level === 1) {
    setStatus("聽一聽");
    await playPrompt();
    if (token !== state.token) return;
    setStatus("隨時讀：" + currentWord().text, true);
  } else {
    setStatus("隨時讀出來", true);
  }
  setTimeout(() => {
    if (token === state.token) showParentHelp(true);
  }, 14000);
});

$("btn-skip").addEventListener("click", () => {
  state.token += 1;
  nextWord();
});

$("btn-hint").addEventListener("click", async () => {
  if (state.level !== 2) return;
  const token = state.token;
  setStatus("聽提示");
  await playPrompt();
  if (token !== state.token) return;
  setStatus("隨時讀出來", true);
});

$("btn-hear-again").addEventListener("click", async () => {
  const token = state.token;
  hideOverlay();
  showParentHelp(false);
  setStatus("聽一聽");
  await playPrompt();
  if (token !== state.token) return;
  setStatus("隨時讀：" + currentWord().text, true);
});

$("btn-done-again").addEventListener("click", () => startTheme(state.theme));
$("btn-done-home").addEventListener("click", () => showScreen("themes"));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.token += 1;
    stopListening();
  }
});
