/* Speedle — Vue 3 SPA (CDN) — Options API rewrite
   A) Pause time when switching modes
   B) Pause time when player leaves (hidden/unload)
   C) Reduce localStorage spam (throttled saves + save-on-important-events)
   D) Use Vue Options API: data(), methods, computed, mounted, beforeUnmount
*/

const MIN_LEN = 3;
const MAX_LEN = 9;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a += 0x6D2B79F5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function formatMMSS(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2,'0');
  const ss = String(s % 60).padStart(2,'0');
  return `${mm}:${ss}`;
}

function formatMSS(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

function todayKeyLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function fiveMinuteBlockKeyLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = d.getMinutes();
  const floored = String(Math.floor(mm / 5) * 5).padStart(2,'0');
  return `${y}-${m}-${day} ${hh}:${floored}`;
}

function timeOnlyFromBlockKey(blockKey){
  const parts = String(blockKey).split(" ");
  return parts.length === 2 ? parts[1] : "";
}

function normaliseWord(w){ return String(w || "").trim().toLowerCase(); }

function makeFeedback(guess, answer){
  const g = guess.split("");
  const a = answer.split("");
  const res = Array(g.length).fill("bad");

  const counts = {};
  for (let i = 0; i < a.length; i++){
    if (g[i] === a[i]) {
      res[i] = "good";
    } else {
      counts[a[i]] = (counts[a[i]] || 0) + 1;
    }
  }
  for (let i = 0; i < g.length; i++){
    if (res[i] === "good") continue;
    const ch = g[i];
    if (counts[ch] > 0){
      res[i] = "present";
      counts[ch]--;
    }
  }
  return res;
}

function pickSeededWord(seedStr, pool){
  if (!pool || !pool.length) return "speed";
  const seed = hashStringToSeed(seedStr);
  const rng = mulberry32(seed);
  const idx = Math.floor(rng() * pool.length);
  return pool[idx];
}

async function loadWordFile(path){
  const resp = await fetch(path, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${path} fetch failed (${resp.status})`);
  const text = await resp.text();

  const out = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)){
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (!/^[a-z]+$/.test(w)) continue;
    if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function storageKeyBoard(modeKey, seedKey){
  return `speedle.board.${modeKey}.${seedKey}`;
}

function safeParseJSON(raw){
  try { return JSON.parse(raw); } catch { return null; }
}

function computeKeyStateFromGuesses(guesses){
  const ks = {};
  const rank = { bad:0, present:1, good:2 };
  for (const g of guesses){
    for (let i = 0; i < g.word.length; i++){
      const ch = g.word[i].toUpperCase();
      const next = g.fb[i];
      const prev = ks[ch];
      if (!prev || rank[next] > rank[prev]) ks[ch] = next;
    }
  }
  return ks;
}

function buildCopyText(board){
  const mode = board.modeLabel;
  const seed = board.seedKey;
  const time = formatMMSS(board.finalMs ?? board.elapsedMs ?? 0);
  const guesses = board.guesses?.length || 0;
  return `Speedle\nMode: ${mode}\nSeed: ${seed}\nTime: ${time}\nGuesses: ${guesses}`;
}

Vue.createApp({
  data(){
    return {
      MODES: [
        { key: "daily",  label: "Daily",  seedType: "daily", rule: (len)=>len>=3 && len<=9 },
        { key: "short",  label: "Short",  seedType: "5min",  rule: (len)=>len>=3 && len<=4 },
        { key: "medium", label: "Medium", seedType: "5min",  rule: (len)=>len>=5 && len<=6 },
        { key: "long",   label: "Long",   seedType: "5min",  rule: (len)=>len>=7 && len<=9 }
      ],

      // word lists
      guessSet: new Set(),     // words.txt
      answers: [],             // answers.txt filtered 3..9
      filesReady: false,

      // seeds for button undertext
      dailyDate: todayKeyLocal(),
      fiveMinKey: fiveMinuteBlockKeyLocal(),
      seedInterval: null,

      // boards
      boards: {},              // id -> board object
      currentBoardId: "",

      // ui
      message: "",
      messageKind: "info",
      showHelp: false,

      // timer + persistence
      rafHandle: null,
      lastSaveAt: 0,           // perf.now timestamp for throttling
      saveIntervalMs: 700,     // throttle window
      messageTimer: null,

      // keyboard
      kRows: [
        ["Q","W","E","R","T","Y","U","I","O","P"],
        ["A","S","D","F","G","H","J","K","L"],
        ["ENTER","Z","X","C","V","B","N","M","⌫"]
      ],
    };
  },

  computed: {
    currentBoard(){
      return this.boards[this.currentBoardId] || null;
    },

    activeModeKey(){
      return this.currentBoard?.modeKey || "daily";
    },

    wordLen(){
      return this.currentBoard?.answer?.length || 5;
    },

    timeText(){
      const b = this.currentBoard;
      if (!b) return "00:00";
      if (b.status === "running") return formatMMSS(b.elapsedMs);
      return formatMMSS(b.finalMs ?? b.elapsedMs ?? 0);
    },

    headerSeed(){
      const b = this.currentBoard;
      if (!b) return "";
      return `${b.modeLabel} · ${b.seedKey}`;
    },

    isFinished(){
      const b = this.currentBoard;
      return !!b && (b.status === "solved" || b.status === "failed");
    },

    canEnter(){
      const b = this.currentBoard;
      return !!b && b.status === "running" && b.currentGuess.length === b.answer.length;
    },

    canClear(){
      const b = this.currentBoard;
      return !!b && b.status === "running" && b.currentGuess.length > 0;
    },

    gridRows(){
      const b = this.currentBoard;
      if (!b) return [];
      const rows = [];

      for (const g of b.guesses){
        rows.push(g.word.toUpperCase().split("").map((ch, i) => ({ ch, s: g.fb[i] })));
      }

      if (b.status === "running"){
        const cur = [];
        const curUp = b.currentGuess.toUpperCase();
        for (let i = 0; i < b.answer.length; i++){
          cur.push({ ch: curUp[i] || "", s: "" });
        }
        rows.push(cur);
      }

      return rows;
    },

    headerCopyText(){
      const b = this.currentBoard;
      if (!b || b.status !== "solved") return "";

      const mode = b.modeLabel;

      let seedText = b.seedKey;
      if (b.modeKey === "daily"){
        const d = new Date(b.seedKey);
        seedText = d.toLocaleDateString("en-AU", { day:"2-digit", month:"short" });
      }

      return `${mode} Speedle ${seedText} solved in ${formatMSS(b.finalMs ?? 0)} (${b.guesses.length} guesses)`;
    }
  },

  methods: {
    // ---------- seed helpers ----------
    refreshSeedLabels(){
      this.dailyDate = todayKeyLocal();
      this.fiveMinKey = fiveMinuteBlockKeyLocal();
    },

    underTextForMode(m){
      return (m.seedType === "daily")
        ? this.dailyDate
        : timeOnlyFromBlockKey(this.fiveMinKey);
    },

    seedKeyForMode(m){
      return (m.seedType === "daily")
        ? this.dailyDate
        : this.fiveMinKey;
    },

    // ---------- messaging ----------
    setMessage(text, kind = "info", { autoFade = false, delay = 2200 } = {}){
      this.message = text;
      this.messageKind = kind;

      // clear any existing timer
      if (this.messageTimer){
        clearTimeout(this.messageTimer);
        this.messageTimer = null;
      }

      if (autoFade){
        this.messageTimer = setTimeout(() => {
          this.message = "";
          this.messageKind = "info";
          this.messageTimer = null;
        }, delay);
      }
    },
    clearMessage(){
      this.message = "";
      this.messageKind = "info";
    },

    // ---------- persistence (throttled) ----------
    saveBoardToStorage(b, { force=false } = {}){
      const now = performance.now();
      if (!force && (now - this.lastSaveAt) < this.saveIntervalMs) return;
      this.lastSaveAt = now;

      const k = storageKeyBoard(b.modeKey, b.seedKey);
      const toSave = {
        modeKey: b.modeKey,
        modeLabel: b.modeLabel,
        seedKey: b.seedKey,
        answer: b.answer,

        status: b.status,
        startedAtISO: b.startedAtISO,
        lastActiveISO: b.lastActiveISO,

        elapsedMs: b.elapsedMs,
        finalMs: b.finalMs ?? null,

        currentGuess: b.currentGuess,
        hasStarted: b.hasStarted,
        guesses: b.guesses
      };
      localStorage.setItem(k, JSON.stringify(toSave));
    },

    saveBoardNow(b){
      this.lastSaveAt = 0; // reset throttle
      this.saveBoardToStorage(b, { force:true });
    },

    loadBoardFromStorage(modeKey, seedKey){
      const k = storageKeyBoard(modeKey, seedKey);
      const raw = localStorage.getItem(k);
      if (!raw) return null;

      const obj = safeParseJSON(raw);
      if (!obj || typeof obj !== "object") return null;
      if (typeof obj.answer !== "string") return null;
      if (obj.answer.length < MIN_LEN || obj.answer.length > MAX_LEN) return null;
      if (!Array.isArray(obj.guesses)) obj.guesses = [];
      if (typeof obj.currentGuess !== "string") obj.currentGuess = "";

      obj.keyState = computeKeyStateFromGuesses(obj.guesses);
      if (typeof obj.hasStarted !== "boolean") obj.hasStarted = (Number(obj.elapsedMs) || 0) > 0 || (obj.guesses?.length || 0) > 0;
      return obj;
    },

    // ---------- timer control ----------
    stopTick(){
      if (this.rafHandle){
        cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
      }
    },

    startTick(){
      // start ticking the current board (assumes startPerfTs already set)
      this.stopTick();
      const loop = () => {
        const b = this.currentBoard;
        if (!b || b.status !== "running") return;

        b.elapsedMs = performance.now() - b.startPerfTs;
        b.lastActiveISO = new Date().toISOString();

        // throttled save
        this.saveBoardToStorage(b);

        this.rafHandle = requestAnimationFrame(loop);
      };
      this.rafHandle = requestAnimationFrame(loop);
    },

    pauseBoard(b, { reason="" } = {}){
        if (!b || b.status !== "running") return;

        if (b.hasStarted){
            b.elapsedMs = performance.now() - b.startPerfTs;
        } else {
            b.elapsedMs = 0;
        }

        b.lastActiveISO = new Date().toISOString();
        this.stopTick();
        this.saveBoardNow(b);

        if (reason) this.setMessage(reason, "info");
    },

    resumeBoard(b){
        if (!b || b.status !== "running") return;

        b.elapsedMs = Number(b.elapsedMs) || 0;
        b.startPerfTs = performance.now() - b.elapsedMs;
        b.lastActiveISO = new Date().toISOString();

        this.saveBoardToStorage(b, { force:true });

        if (b.hasStarted){
            this.startTick();
        } else {
            this.stopTick(); // stay paused until first submit
        }

    },

    // ---------- board creation ----------
    poolForMode(modeKey){
      const mode = this.MODES.find(m => m.key === modeKey) || this.MODES[0];
      return this.answers.filter(w => mode.rule(w.length));
    },

    createNewBoard(modeKey, seedKey){
      const mode = this.MODES.find(m => m.key === modeKey) || this.MODES[0];
      const pool = this.poolForMode(modeKey);
      const ans = pickSeededWord(`${modeKey}:${seedKey}`, pool);

      const nowISO = new Date().toISOString();
      const b = {
        id: `${modeKey}.${seedKey}`,
        modeKey,
        modeLabel: mode.label,
        seedKey,
        answer: ans,

        status: "running",
        hasStarted: false,
        startedAtISO: nowISO,
        lastActiveISO: nowISO,

        startPerfTs: performance.now(),
        elapsedMs: 0,
        finalMs: null,

        currentGuess: "",
        guesses: [],
        keyState: {}
      };

      this.saveBoardNow(b);
      return b;
    },

    ensureBoard(modeKey){
      const mode = this.MODES.find(m => m.key === modeKey) || this.MODES[0];
      const seedKey = this.seedKeyForMode(mode);
      const id = `${modeKey}.${seedKey}`;

      if (this.boards[id]) return this.boards[id];

      const loaded = this.loadBoardFromStorage(modeKey, seedKey);
      if (loaded){
        loaded.id = id;
        loaded.modeLabel = loaded.modeLabel || mode.label;
        loaded.startPerfTs = 0;

        // IMPORTANT: loaded running boards are PAUSED by default until shown/resumed
        loaded.elapsedMs = Number(loaded.elapsedMs) || 0;
        loaded.keyState = loaded.keyState || computeKeyStateFromGuesses(loaded.guesses || []);
        this.boards[id] = loaded;
        return loaded;
      }

      const b = this.createNewBoard(modeKey, seedKey);
      this.boards[id] = b;
      return b;
    },

    // ---------- mode switching ----------
    showBoard(modeKey){
      // A) Pause time when switching modes
      if (this.currentBoard && this.currentBoard.status === "running"){
        this.pauseBoard(this.currentBoard);
      }

      this.clearMessage();

      const b = this.ensureBoard(modeKey);
      this.currentBoardId = b.id;

      // show status + resume timer only when on this board
      if (b.status === "running"){
        this.resumeBoard(b);
        this.setMessage(`Length: ${b.answer.length}`, "info");
      } else if (b.status === "solved"){
        this.setMessage(`Solved in ${formatMMSS(b.finalMs)} · ${b.guesses.length} guesses`, "success");
      } else if (b.status === "failed"){
        this.setMessage(`Finished · Answer: ${String(b.answer).toUpperCase()}`, "warn");
      }

      this.$nextTick(() => {
        const el = this.$refs.guessScrollEl;
        if (el) el.scrollTop = 0;
      });
    },

    // ---------- rules ----------
    isValidGuessForMode(word, modeKey){
      const mode = this.MODES.find(m => m.key === modeKey) || this.MODES[0];
      if (!/^[a-z]+$/.test(word)) return false;
      if (word.length < MIN_LEN || word.length > MAX_LEN) return false;
      if (!mode.rule(word.length)) return false;
      return this.guessSet.has(word);
    },

    finaliseSolved(b){
      b.status = "solved";
      b.finalMs = Math.max(0, b.elapsedMs);
      b.lastActiveISO = new Date().toISOString();

      this.stopTick();
      this.saveBoardNow(b);
      this.setMessage(`Solved in ${formatMMSS(b.finalMs)} · ${b.guesses.length} guesses`, "success");
    },

    // ---------- input ----------
    submit(){
      const b = this.currentBoard;
      if (!b || b.status !== "running") return;

      const g = normaliseWord(b.currentGuess);
      if (g.length !== b.answer.length){
        this.setMessage(
          `Must be ${b.answer.length} letters`,
          "warn" , { autoFade: true }
        );
        return;
      }


      if (!this.isValidGuessForMode(g, b.modeKey)){
this.setMessage("Not in list", "warn", { autoFade: true });
        return;
      }

      // Start the clock on the first valid submitted guess
        if (!b.hasStarted){
        b.hasStarted = true;
        b.startPerfTs = performance.now(); // start from 0
        b.elapsedMs = 0;
        this.startTick();
        this.saveBoardNow(b);
        }


      const fb = makeFeedback(g, b.answer);
      b.guesses.push({ word: g, fb });
      b.keyState = computeKeyStateFromGuesses(b.guesses);
      b.currentGuess = "";

      // save on meaningful action
      this.saveBoardNow(b);

      this.$nextTick(() => {
        const el = this.$refs.guessScrollEl;
        if (el) el.scrollTop = el.scrollHeight;
      });

      if (g === b.answer){
        this.finaliseSolved(b);
      } else {
        //this.setMessage(`${b.guesses.length} guesses · ${this.timeText}`, "info");
      }
    },

    addChar(ch){
      const b = this.currentBoard;
      if (!b || b.status !== "running") return;
      if (!/^[a-z]$/i.test(ch)) return;
      if (b.currentGuess.length >= b.answer.length) return;
      b.currentGuess += ch.toLowerCase();
      // no save here (avoid spam)
    },

    backspace(){
      const b = this.currentBoard;
      if (!b || b.status !== "running") return;
      b.currentGuess = b.currentGuess.slice(0, -1);
      // no save here (avoid spam)
    },

    clearGuess(){
      const b = this.currentBoard;
      if (!b || b.status !== "running") return;
      b.currentGuess = "";
      // no save here (avoid spam)
    },

    keyStateClass(letter){
      const b = this.currentBoard;
      if (!b) return "";
      return b.keyState?.[letter] || "";
    },

    handleKeydown(e){
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Enter"){
        e.preventDefault();
        this.submit();
        return;
      }
      if (e.key === "Backspace"){
        e.preventDefault();
        this.backspace();
        return;
      }
      if (/^[a-z]$/i.test(e.key)){
        e.preventDefault();
        this.addChar(e.key);
      }
    },

    // ---------- copy ----------
    async copyResult(){
      const b = this.currentBoard;
      if (!b || b.status !== "solved") return;
      const text = buildCopyText(b);

      try{
        await navigator.clipboard.writeText(text);
        this.setMessage("Copied result", "success");
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try{ document.execCommand("copy"); this.setMessage("Copied result", "success"); }
        catch{ this.setMessage("Copy failed", "warn"); }
        document.body.removeChild(ta);
      }
    },

    async copyHeaderResult(){
      if (!this.headerCopyText) return;

      try{
        await navigator.clipboard.writeText(this.headerCopyText);
        this.setMessage("Result copied", "success");
      } catch {
        const ta = document.createElement("textarea");
        ta.value = this.headerCopyText;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try{ document.execCommand("copy"); this.setMessage("Result copied", "success"); }
        catch{ this.setMessage("Copy failed", "warn"); }
        document.body.removeChild(ta);
      }
    },

    // ---------- leave/pause hooks ----------
    handleVisibility(){
      // B) Pause when player leaves game (tab hidden)
      const b = this.currentBoard;
      if (!b || b.status !== "running") return;

      if (document.hidden){
        this.pauseBoard(b);
      } else {
        // When returning, resume the current board
        this.resumeBoard(b);
      }
    },

    handleBeforeUnload(){
      // B) Pause on unload/navigation away
      const b = this.currentBoard;
      if (!b || b.status !== "running") return;
      this.pauseBoard(b);
    }
  },

  async mounted(){
    window.addEventListener("keydown", this.handleKeydown, { passive:false });

    // Load word files
    const [guessWords, answerWords] = await Promise.all([
      loadWordFile("./words.txt"),
      loadWordFile("./answers.txt")
    ]);

    this.guessSet = new Set(guessWords);
    this.answers = answerWords.filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN);
    this.filesReady = true;

    // seeds
    this.refreshSeedLabels();
    this.seedInterval = setInterval(this.refreshSeedLabels, 1000);

    // leave/pause
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("beforeunload", this.handleBeforeUnload);

    // start
    this.showBoard("daily");
  },

  beforeUnmount(){
    window.removeEventListener("keydown", this.handleKeydown);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("beforeunload", this.handleBeforeUnload);

    this.stopTick();
    if (this.seedInterval) clearInterval(this.seedInterval);
  },

  template: `
  <div class="wrap">
    <header class="topbar">
      <div class="brand">
        <div class="title">Speedle</div>
      </div>

      <div class="rightbits">
        <div style="display:flex; align-items:center; gap:8px; justify-content:flex-end;">
          <div class="pill"><strong>{{ timeText }}</strong></div>

          <button
            v-if="currentBoard && currentBoard.status==='solved'"
            class="msgBtn small"
            type="button"
            @click="copyHeaderResult"
            aria-label="Copy result"
            title="Copy result"
          >⧉</button>
        </div>

        <div style="margin-top:6px">{{ headerSeed }}</div>
      </div>
    </header>

    <div class="modes">
      <button
        v-for="m in MODES"
        :key="m.key"
        class="modebtn"
        :class="{active: activeModeKey === m.key}"
        @click="showBoard(m.key)"
        type="button"
      >
        {{ m.label }}
        <span class="small">{{ underTextForMode(m) }}</span>
      </button>
    </div>

    <section class="boardpanel" aria-label="Speedle board" :style="{ '--cols': wordLen }">
      <div class="guessscroll" ref="guessScrollEl">
        <div class="grid">
          <div class="row"
              v-for="(row, rIdx) in gridRows"
              :key="rIdx"
              :style="{ gridTemplateColumns: 'repeat(' + wordLen + ', 1fr)' }">
            <div
              v-for="(t, cIdx) in row"
              :key="cIdx"
              class="tile"
              :class="t.s"
            >{{ t.ch }}</div>
          </div>
        </div>
      </div>
    </section>

    <div v-if="showHelp" class="overlay" @click.self="showHelp=false">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Help">
        <div class="modalhead">
          <div>How to play</div>
          <button class="xbtn" type="button" @click="showHelp=false" aria-label="Close">✕</button>
        </div>

        <p>
          Race to complete the word: time matters, not the number of guesses.
        </p>

        <ul>
          <li><strong>Daily</strong>: one board per day.</li>
          <li><strong>Short/Medium/Long</strong>: one board per 5-minute seed.</li>
          <li><strong>Short</strong>: 3 to 4 letters</li>
          <li><strong>Medium</strong>: 5 to 6 letters</li>
          <li><strong>Long</strong>: 7 to 9 letters</li>
        </ul>

        <p class="smallmuted">
          Green = correct spot, yellow = in the word, grey = not in the word.
        </p>
      </div>
    </div>
  </div>

  <div class="dockStack" aria-label="Bottom dock">
    <div class="dockInner">
      <div class="msgBar"
          :style="messageKind==='success' ? 'border-color: rgba(46,125,50,0.35); background: rgba(46,125,50,0.08);'
                : messageKind==='warn' ? 'border-color: rgba(181,155,0,0.35); background: rgba(181,155,0,0.08);'
                : ''">
        <div class="msgText">{{ message || " " }}</div>

        <div class="msgActions">
          <button class="msgBtn small" type="button" @click="showHelp=true" aria-label="Help">?</button>

          <button
            v-if="currentBoard && currentBoard.status==='solved'"
            class="msgBtn"
            type="button"
            @click="copyHeaderResult"
          >
            Copy result
          </button>
        </div>
      </div>

      <div class="kbd" aria-label="On-screen keyboard">
        <div class="krow" v-for="(kr, idx) in kRows" :key="idx">
          <button
            v-for="k in kr"
            :key="k"
            class="key"
            :class="[
              (k.length===1 ? keyStateClass(k) : ''),
              (k==='ENTER' || k==='⌫') ? 'wide' : ''
            ]"
            type="button"
            @click="k==='ENTER' ? submit() : (k==='⌫' ? backspace() : addChar(k))"
          >
            {{ k }}
          </button>
        </div>
      </div>
    </div>
  </div>
  `
}).mount("#app");
