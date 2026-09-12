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
};

const audio = {
  beep: new Audio("audio/sfx/beep.wav"),
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

let state = {
  level: 1,
  theme: null,
  index: 0,
  tries: 0,
  token: 0,
  listening: false,
  recognizer: null,
  parentMode: false,
  awaitingHint: false,
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
    .replace(/[\s，。！？、.,!?;:：；'"「」『』（）()~～]/g, "")
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
  const targets = [word.text, ...(word.aliases || [])].map(normalize);
  for (const t of targets) {
    if (!t) continue;
    if (h === t) return true;
    if (h.includes(t)) return true;
    if (t.length >= 2 && h.length >= t.length - 1) {
      const d = levenshtein(h, t);
      if (d <= 1 && h.length >= t.length - 1) return true;
    }
    if (t.length >= 2) {
      const hits = [...t].filter((ch) => h.includes(ch)).length;
      if (hits === t.length && Math.abs(h.length - t.length) <= 2) return true;
    }
  }
  return false;
}

function SpeechCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopListening() {
  state.listening = false;
  els.micDot.classList.remove("on");
  try {
    if (state.recognizer) state.recognizer.stop();
  } catch {
    /* ignore */
  }
}

function listenOnce(token) {
  return new Promise((resolve) => {
    const Ctor = SpeechCtor();
    if (!Ctor) {
      resolve({ text: "", reason: "unsupported" });
      return;
    }

    const rec = new Ctor();
    state.recognizer = rec;
    rec.lang = "zh-HK";
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    rec.continuous = false;

    let settled = false;
    const finish = (value) => {
      if (settled || token !== state.token) return;
      settled = true;
      state.listening = false;
      els.micDot.classList.remove("on");
      try { rec.stop(); } catch { /* ignore */ }
      resolve(value);
    };

    rec.onresult = (ev) => {
      const texts = [];
      for (let i = 0; i < ev.results.length; i++) {
        for (let j = 0; j < ev.results[i].length; j++) {
          texts.push(ev.results[i][j].transcript);
        }
      }
      finish({ text: texts.join(" "), alts: texts, reason: "ok" });
    };
    rec.onerror = (ev) => {
      finish({ text: "", reason: ev.error || "error" });
    };
    rec.onend = () => {
      finish({ text: "", reason: "end" });
    };

    try {
      state.listening = true;
      els.micDot.classList.add("on");
      rec.start();
    } catch (err) {
      finish({ text: "", reason: String(err) });
    }

    setTimeout(() => finish({ text: "", reason: "timeout" }), 5000);
  });
}

async function listenServer(token) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { text: "", reason: "no-media" };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return { text: "", reason: "mic-denied" };
  }

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  state.listening = true;
  els.micDot.classList.add("on");
  rec.start();
  await wait(2800);
  if (token !== state.token) {
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    return { text: "", reason: "cancelled" };
  }
  await new Promise((resolve) => {
    rec.onstop = resolve;
    try { rec.stop(); } catch { resolve(); }
  });
  stream.getTracks().forEach((t) => t.stop());
  state.listening = false;
  els.micDot.classList.remove("on");

  const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
  try {
    const res = await fetch("/api/hear", { method: "POST", body: blob });
    if (!res.ok) return { text: "", reason: "server" };
    const data = await res.json();
    return { text: data.text || "", reason: data.text ? "ok" : "empty" };
  } catch {
    return { text: "", reason: "server" };
  }
}

function needsParent(heard) {
  return ["unsupported", "no-media", "mic-denied", "not-allowed", "service-not-allowed", "server"].includes(
    heard.reason
  );
}

async function hearChild(token) {
  const web = SpeechCtor();
  if (web) {
    const first = await listenOnce(token);
    if (token !== state.token) return { text: "", reason: "cancelled" };
    if (first.text) return first;
    const fallback = ["not-allowed", "service-not-allowed", "network", "aborted"];
    if (fallback.includes(first.reason)) {
      const second = await listenServer(token);
      if (token !== state.token) return { text: "", reason: "cancelled" };
      if (second.text) return second;
      return { text: "", reason: "unsupported" };
    }
    return first;
  }
  const second = await listenServer(token);
  if (token !== state.token) return { text: "", reason: "cancelled" };
  if (second.text) return second;
  if (second.reason === "mic-denied" || second.reason === "no-media") return second;
  return { text: "", reason: "unsupported" };
}

function setStatus(text, listening = false) {
  els.status.textContent = text;
  els.micDot.classList.toggle("on", listening);
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
  for (const a of [audio.beep, audio.correctSfx, audio.wrongSfx, audio.correct, audio.tryagain, audio.bravo]) {
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
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      toast("請允許使用麥克風，小朋友先可以讀俾遊戲聽。");
    }
  }
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
  state.tries = 0;
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
  state.awaitingHint = false;
  const word = currentWord();
  state.tries = 0;
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

  if (state.level === 1) {
    showHint(false);
    setStatus("聽一聽");
    await wait(400);
    if (token !== state.token) return;
    await playAudio(audio.word);
    if (token !== state.token) return;
    await wait(280);
    if (token !== state.token) return;
  } else {
    showHint(true);
    setStatus("請讀出來");
    await wait(600);
    if (token !== state.token) return;
    if (state.awaitingHint) {
      state.awaitingHint = false;
      setStatus("聽提示");
      await playAudio(audio.word);
      if (token !== state.token) return;
      await wait(200);
    }
  }

  while (token === state.token) {
    setStatus(state.level === 1 ? "請讀：" + word.text : "請讀出來", true);
    const heardPromise = hearChild(token);
    await wait(500);
    if (token !== state.token) return;
    playAudio(audio.beep);
    const heard = await heardPromise;
    if (token !== state.token) return;

    if (state.awaitingHint) {
      state.awaitingHint = false;
      setStatus("聽提示");
      await playAudio(audio.word);
      if (token !== state.token) return;
      await wait(200);
      continue;
    }

    if (needsParent(heard)) {
      setStatus("家長幫手聽一聽");
      showParentHelp(true);
      return;
    }

    if (isMatch(heard.text, word)) {
      await celebrate(token);
      return;
    }

    state.tries += 1;
    stopListening();
    showOverlay("bad", "再試一次", "images/ui/retry.jpg");
    playAudio(audio.wrongSfx);
    await wait(120);
    await playAudio(audio.tryagain);
    if (token !== state.token) return;
    await wait(450);
    hideOverlay();
    if (token !== state.token) return;
    if (state.level === 1 && state.tries % 3 === 0) {
      setStatus("再聽一次");
      await playAudio(audio.word);
      if (token !== state.token) return;
    }
  }
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
  state.tries += 1;
  showOverlay("bad", "再試一次", "images/ui/retry.jpg");
  playAudio(audio.wrongSfx);
  await wait(120);
  await playAudio(audio.tryagain);
  if (token !== state.token) return;
  await wait(400);
  hideOverlay();
  if (token !== state.token) return;
  if (state.level === 1 && state.tries % 3 === 0) {
    setStatus("再聽一次");
    await playAudio(audio.word);
    if (token !== state.token) return;
  }
  await playAudio(audio.beep);
  if (token !== state.token) return;
  setStatus("家長幫手聽一聽");
  showParentHelp(true);
});

$("btn-skip").addEventListener("click", () => {
  state.token += 1;
  nextWord();
});

$("btn-hint").addEventListener("click", async () => {
  if (state.level !== 2) return;
  state.awaitingHint = true;
  if (state.listening) {
    stopListening();
    return;
  }
  if (els.parentHelp.classList.contains("show")) {
    const token = state.token;
    setStatus("聽提示");
    await playAudio(audio.word);
    if (token !== state.token) return;
  }
});

$("btn-hear-again").addEventListener("click", () => {
  const token = ++state.token;
  stopListening();
  hideOverlay();
  showParentHelp(false);
  playRound(token);
});

$("btn-done-again").addEventListener("click", () => startTheme(state.theme));
$("btn-done-home").addEventListener("click", () => showScreen("themes"));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopListening();
});
