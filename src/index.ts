/*
════════════════════════════════════════════════════════════════════
  WGVIP v2.0 — Wayground Request Interceptor Cheat
  https://github.com/Danz-Pro/WGVIP

  STRATEGY: Dual Intercept (XHR + Fetch) + Auto-Answer
  ═══ HOW IT WORKS ═══
  1. Intercept BOTH XMLHttpRequest.open/send AND window.fetch
  2. When game sends proceed request, modify body with correct answer
  3. Pre-fetch correct answers using NATIVE XMLHttpRequest (not intercepted)
  4. Also auto-click correct option as visual feedback
  5. Server ALWAYS receives the correct answer regardless of what user clicks

  ═══ KEY INSIGHT ═══
  Wayground/Quizizz uses axios → XMLHttpRequest, NOT fetch()
  Previous version only intercepted fetch → never caught any requests
════════════════════════════════════════════════════════════════════
*/

// ═══════════════════════════════════════════
//  SAVE ORIGINALS FIRST (before anything can override them)
// ═══════════════════════════════════════════

const _origFetch = window.fetch.bind(window);
const _origXHROpen = XMLHttpRequest.prototype.open;
const _origXHRSend = XMLHttpRequest.prototype.send;
const _origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

// ═══════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════

interface CorrectAnswer {
  questionId: string;
  type: string;
  mcqIndex?: number;
  msqIndices?: number[];
  blankText?: string;
  blankTargetId?: string;
  displayText: string;
}

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

const S = {
  answers: new Map<string, CorrectAnswer>(),
  pendingFetches: new Map<string, Promise<CorrectAnswer | null>>(),
  roomHash: "",
  quizVersionId: "",
  playerId: "",
  currentQId: "",
  inGame: false,
  totalQ: 0,
  pollTimer: null as ReturnType<typeof setInterval> | null,
  panel: null as HTMLElement | null,
  style: null as HTMLElement | null,
  interceptActive: false,
  interceptedCount: 0,
  modifiedCount: 0,
  debug: true, // Start with debug on so we can see what's happening
};

// ═══════════════════════════════════════════
//  LOG
// ═══════════════════════════════════════════

const LOG = {
  info:    (m: string) => S.debug && console.log(`%c[WGVIP]%c ${m}`, "color:#00e5ff;font-weight:bold", "color:inherit"),
  warn:    (m: string) => console.warn(`%c[WGVIP]%c ${m}`, "color:#ffd740;font-weight:bold", "color:inherit"),
  error:   (m: string) => console.error(`%c[WGVIP]%c ${m}`, "color:#ff5252;font-weight:bold", "color:inherit"),
  success: (m: string) => console.log(`%c[WGVIP]%c ${m}`, "color:#00e676;font-weight:bold", "color:inherit"),
  always:  (m: string) => console.log(`%c[WGVIP]%c ${m}`, "color:#00e5ff;font-weight:bold", "color:inherit"),
};

// ═══════════════════════════════════════════
//  PINIA ACCESS
// ═══════════════════════════════════════════

const Pinia = {
  _get(): any {
    try {
      const root = document.querySelector("#root") || document.querySelector("#app");
      if (!root) return null;
      const app = (root as any).__vue_app__;
      if (!app) return null;
      return app.config.globalProperties?.$pinia || null;
    } catch { return null; }
  },
  store(name: string): any {
    const p = this._get();
    return p?._s?.get(name) || null;
  },
  state(name: string): any {
    const store = this.store(name);
    return store?.$state || null;
  },
  get roomHash(): string     { return this.state("gameData")?.roomHash || ""; },
  get quizVersionId(): string { return this.state("gameData")?.quizVersionId || ""; },
  get totalQuestions(): number { return this.state("gameData")?.totalQuestionsInQuiz || 0; },
  get currentQId(): string {
    const gq = this.state("gameQuestions");
    return gq?.currentId || gq?.currentQuestionId || "";
  },
  get inGame(): boolean {
    const gd = this.state("gameData");
    return !!(gd?.roomHash && gd?.gameState);
  },
  get playerId(): string {
    return this.state("player")?.playerId || "";
  },
  getType(qId: string): string   { return this.state("gameQuestions")?.list?.[qId]?.type || "MCQ"; },
  getOptions(qId: string): any[] { return this.state("gameQuestions")?.list?.[qId]?.options || []; },
  getTargets(qId: string): any[] { return this.state("gameQuestions")?.list?.[qId]?.targets || []; },
  getText(qId: string): string   { return this.state("gameQuestions")?.list?.[qId]?.text || ""; },
};

// ═══════════════════════════════════════════
//  HTML UTIL
// ═══════════════════════════════════════════

const stripHtml = (html: string): string => {
  if (!html) return "";
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent || d.innerText || "").trim();
};

// ═══════════════════════════════════════════
//  NATIVE HTTP — Bypass all interceptors
// ═══════════════════════════════════════════

/** Make HTTP request using NATIVE XMLHttpRequest that bypasses our interceptor */
function nativePost(url: string, body: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // Create a special marker so our XHR interceptor skips this request
    const xhr = new XMLHttpRequest();
    (xhr as any).__wgvip_skip = true; // Marker to bypass interceptor

    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));

    // Use ORIGINAL open/send (not intercepted)
    _origXHROpen.call(xhr, "POST", url, true);
    _origXHRSetHeader.call(xhr, "Content-Type", "application/json");
    _origXHRSend.call(xhr, body);
  });
}

// ═══════════════════════════════════════════
//  PROCEED API — CORRECT ANSWER FETCHER
// ═══════════════════════════════════════════

const API = {
  _baseBody(questionId: string, questionType: string): any {
    return {
      roomHash: S.roomHash,
      playerId: S.playerId,
      response: {
        attempt: 0,
        questionId,
        questionType,
        responseType: "original",
        timeTaken: 2000 + Math.floor(Math.random() * 4000),
        answer: [],
        isEvaluated: false,
        state: "attempted",
        provisional: {
          scores: { correct: 600, incorrect: 0 },
          scoreBreakups: {
            correct: { base: 600, timer: 0, streak: 0, total: 600, powerups: [] },
            incorrect: { base: 0, timer: 0, streak: 0, total: 0, powerups: [] },
          },
          teamAdjustments: { correct: 0, incorrect: 0 },
        },
      },
      questionId,
      powerupEffects: { destroy: [] },
      quizVersionId: S.quizVersionId,
      elapsed: 0,
      isLastPlayerResponse: false,
    };
  },

  buildDummyBody(questionId: string): any {
    const qType = Pinia.getType(questionId);
    const body = this._baseBody(questionId, qType);

    if (qType === "MSQ") {
      body.response.response = [0];
    } else if (qType === "BLANK" || qType === "OPEN") {
      const targets = Pinia.getTargets(questionId);
      const targetId = targets?.[0]?.id || "";
      body.response.response = { media: null };
      body.response.answer = [{
        type: "BlankTargetObject",
        value: [{ targetId, value: { text: "x" } }],
        descriptor: "Answer",
      }];
    } else {
      body.response.response = 0;
    }

    return body;
  },

  async fetchCorrectAnswer(questionId: string): Promise<CorrectAnswer | null> {
    const pending = S.pendingFetches.get(questionId);
    if (pending) return pending;

    const cached = S.answers.get(questionId);
    if (cached) return cached;

    if (Pinia.getType(questionId) === "WORDCLOUD") return null;

    const fetchPromise = this._doFetch(questionId);
    S.pendingFetches.set(questionId, fetchPromise);

    try {
      const result = await fetchPromise;
      if (result) S.answers.set(questionId, result);
      return result;
    } finally {
      S.pendingFetches.delete(questionId);
    }
  },

  async _doFetch(questionId: string): Promise<CorrectAnswer | null> {
    const body = this.buildDummyBody(questionId);
    const qType = Pinia.getType(questionId);

    try {
      LOG.info(`Pre-fetch: ${questionId} (${qType})`);

      const d = await nativePost(
        `/_gameapi/main/public/v1/games/${S.roomHash}/proceed`,
        JSON.stringify(body)
      );

      if (!d?.success) {
        LOG.warn(`Pre-fetch: not success — ${JSON.stringify(d).substring(0, 200)}`);
        return null;
      }

      const answer = d?.data?.question?.structure?.answer;
      const options = d?.data?.question?.structure?.options;

      if (answer === undefined || answer === null) {
        LOG.warn(`Pre-fetch: no answer in response`);
        return null;
      }

      LOG.success(`Answer found: ${JSON.stringify(answer)}`);
      return this._processAnswer(questionId, qType, answer, options);
    } catch (e: any) {
      LOG.error(`Pre-fetch error: ${e.message}`);
      return null;
    }
  },

  _processAnswer(questionId: string, qType: string, apiAnswer: any, apiOptions?: any[]): CorrectAnswer {
    const result: CorrectAnswer = { questionId, type: qType, displayText: "—" };
    const piniaOptions = Pinia.getOptions(questionId);

    if (qType === "MCQ" || qType === "IS" || qType === "ORDER") {
      if (typeof apiAnswer === "number" && apiAnswer >= 0) {
        result.mcqIndex = apiAnswer;
        result.displayText = apiAnswer < piniaOptions.length
          ? stripHtml(piniaOptions[apiAnswer].text || `Opsi #${apiAnswer + 1}`)
          : `Opsi #${apiAnswer + 1}`;
      }
    } else if (qType === "MSQ") {
      if (Array.isArray(apiAnswer)) {
        result.msqIndices = apiAnswer.filter((n: any) => typeof n === "number" && n >= 0);
        const texts: string[] = [];
        result.msqIndices.forEach(idx => {
          texts.push(idx < piniaOptions.length
            ? stripHtml(piniaOptions[idx].text || `#${idx + 1}`)
            : `#${idx + 1}`);
        });
        result.displayText = texts.join(" + ");
      }
    } else if (qType === "BLANK" || qType === "OPEN") {
      if (Array.isArray(apiAnswer) && apiAnswer.length > 0 && typeof apiAnswer[0] === "object") {
        const optionIds: string[] = [];
        apiAnswer.forEach((a: any) => {
          if (a.optionId && Array.isArray(a.optionId)) {
            a.optionId.forEach((oid: string) => optionIds.push(oid));
          }
        });

        if (apiOptions && Array.isArray(apiOptions)) {
          for (const opt of apiOptions) {
            if (optionIds.includes(opt.id || opt._id)) {
              result.blankText = stripHtml(opt.text || "");
              break;
            }
          }
        }

        if (!result.blankText && piniaOptions.length > 0) {
          const optMap = new Map<string, string>();
          piniaOptions.forEach((o: any) => {
            if (o.id || o._id) optMap.set(o.id || o._id, stripHtml(o.text));
          });
          for (const oid of optionIds) {
            const txt = optMap.get(oid);
            if (txt) { result.blankText = txt; break; }
          }
        }

        if (apiAnswer[0].targetId) result.blankTargetId = apiAnswer[0].targetId;
        result.displayText = result.blankText || "(blank)";
      }
    }

    return result;
  },
};

// ═══════════════════════════════════════════
//  REQUEST BODY MODIFIER
// ═══════════════════════════════════════════

function modifyRequestBody(bodyStr: string): string {
  try {
    const body = JSON.parse(bodyStr);
    const qId = body.questionId || body?.response?.questionId;

    if (!qId) return bodyStr;

    const correctAnswer = S.answers.get(qId);
    if (!correctAnswer) {
      LOG.warn(`No cached answer for ${qId} — sending original`);
      return bodyStr;
    }

    const qType = correctAnswer.type;
    LOG.info(`Modifying request for ${qId} (${qType})`);

    if (qType === "MCQ" || qType === "IS" || qType === "ORDER") {
      if (correctAnswer.mcqIndex !== undefined) {
        const oldVal = body.response?.response;
        body.response.response = correctAnswer.mcqIndex;
        LOG.success(`MCQ: ${JSON.stringify(oldVal)} → ${correctAnswer.mcqIndex}`);
      }
    } else if (qType === "MSQ") {
      if (correctAnswer.msqIndices && correctAnswer.msqIndices.length > 0) {
        const oldVal = body.response?.response;
        body.response.response = correctAnswer.msqIndices;
        LOG.success(`MSQ: ${JSON.stringify(oldVal)} → ${JSON.stringify(correctAnswer.msqIndices)}`);
      }
    } else if (qType === "BLANK" || qType === "OPEN") {
      if (correctAnswer.blankText) {
        if (body.response?.answer && Array.isArray(body.response.answer)) {
          for (const ans of body.response.answer) {
            if (ans.value && Array.isArray(ans.value)) {
              for (const v of ans.value) {
                if (v.value && typeof v.value.text !== "undefined") {
                  const oldVal = v.value.text;
                  v.value.text = correctAnswer.blankText;
                  LOG.success(`BLANK: "${oldVal}" → "${correctAnswer.blankText}"`);
                }
              }
            }
          }
        }
        if (correctAnswer.blankTargetId && body.response?.answer?.[0]?.value?.[0]) {
          body.response.answer[0].value[0].targetId = correctAnswer.blankTargetId;
        }
      }
    }

    S.modifiedCount++;
    Panel.updateInterceptCount();
    return JSON.stringify(body);
  } catch (e: any) {
    LOG.error(`modifyRequestBody error: ${e.message}`);
    return bodyStr;
  }
}

// ═══════════════════════════════════════════
//  INTERCEPTOR — DUAL (XHR + FETCH)
// ═══════════════════════════════════════════

const Interceptor = {
  install(): void {
    if (S.interceptActive) return;

    // ═══ 1. INTERCEPT XMLHttpRequest ═══
    XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
      // Store URL and method on the XHR instance for later use in send()
      (this as any).__wgvip_url = typeof url === "string" ? url : url.toString();
      (this as any).__wgvip_method = method;
      return _origXHROpen.apply(this, [method, url, ...args] as any);
    };

    XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
      const url = (this as any).__wgvip_url || "";
      const method = ((this as any).__wgvip_method || "").toUpperCase();
      const skip = (this as any).__wgvip_skip; // Our own requests have this flag

      // Intercept proceed API POST requests (but skip our own pre-fetch requests)
      if (!skip && url.includes("/proceed") && method === "POST" && typeof body === "string") {
        S.interceptedCount++;
        LOG.always(`⚡ XHR Intercepted: ${url.substring(0, 80)}`);
        LOG.info(`Body preview: ${body.substring(0, 200)}`);

        try {
          const modified = modifyRequestBody(body);
          if (modified !== body) {
            body = modified;
            LOG.success(`✅ XHR request modified!`);
            Panel.updateStatus("XHR Intercept berhasil!", "ok");
          }
        } catch (e: any) {
          LOG.error(`XHR modify error: ${e.message}`);
        }
      }

      return _origXHRSend.call(this, body);
    };

    // ═══ 2. INTERCEPT window.fetch ═══
    window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = "";
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof input === "object" && "url" in input) url = (input as Request).url;

      // Intercept proceed API POST requests
      if (url.includes("/proceed") && init?.method?.toUpperCase() === "POST" && init?.body && typeof init.body === "string") {
        S.interceptedCount++;
        LOG.always(`⚡ Fetch Intercepted: ${url.substring(0, 80)}`);

        try {
          const modified = modifyRequestBody(init.body as string);
          if (modified !== init.body) {
            init = { ...init, body: modified };
            LOG.success(`✅ Fetch request modified!`);
            Panel.updateStatus("Fetch Intercept berhasil!", "ok");
          }
        } catch (e: any) {
          LOG.error(`Fetch modify error: ${e.message}`);
        }
      }

      return _origFetch.call(this, input, init);
    };

    S.interceptActive = true;
    LOG.always("Dual interceptor installed (XHR + Fetch)!");
  },

  uninstall(): void {
    if (S.interceptActive) {
      window.fetch = _origFetch;
      XMLHttpRequest.prototype.open = _origXHROpen;
      XMLHttpRequest.prototype.send = _origXHRSend;
      XMLHttpRequest.prototype.setRequestHeader = _origXHRSetHeader;
      S.interceptActive = false;
      LOG.info("Interceptors removed");
    }
  },
};

// ═══════════════════════════════════════════
//  AUTO-CLICK — Visual Feedback + Backup
// ═══════════════════════════════════════════

const AutoClick = {
  /** Click the correct option in the DOM */
  async clickCorrect(qId: string): Promise<boolean> {
    const answer = S.answers.get(qId);
    if (!answer) return false;

    // Wait a moment for DOM to be ready
    await new Promise(r => setTimeout(r, 200));

    if (answer.type === "MCQ" || answer.type === "IS" || answer.type === "ORDER") {
      if (answer.mcqIndex !== undefined) {
        const el = document.querySelector<HTMLElement>(`[data-cy="option-${answer.mcqIndex}"]`);
        if (el) {
          LOG.info(`Auto-clicking option-${answer.mcqIndex}`);
          el.click();
          return true;
        }
        // Fallback: click by index in DOM
        const options = document.querySelectorAll<HTMLElement>('[role="option"]');
        if (answer.mcqIndex < options.length) {
          options[answer.mcqIndex].click();
          return true;
        }
      }
    } else if (answer.type === "MSQ") {
      if (answer.msqIndices) {
        let clicked = 0;
        for (const idx of answer.msqIndices) {
          const el = document.querySelector<HTMLElement>(`[data-cy="option-${idx}"]`);
          if (el) { el.click(); clicked++; }
        }
        return clicked > 0;
      }
    } else if (answer.type === "BLANK" || answer.type === "OPEN") {
      if (answer.blankText) {
        // Try box inputs first
        const boxes = document.querySelectorAll<HTMLInputElement>('input.fib-box-input');
        if (boxes.length > 0) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          if (setter) {
            let charIdx = 0;
            for (let i = 0; i < boxes.length && charIdx < answer.blankText.length; i++) {
              setter.call(boxes[i], answer.blankText[charIdx]);
              boxes[i].dispatchEvent(new Event("input", { bubbles: true }));
              charIdx++;
            }
            return true;
          }
        }

        // Try text input
        const input = document.querySelector<HTMLInputElement>('[data-cy="fib-text-input"]')
          || document.querySelector<HTMLInputElement>('input.fib-text-input');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, answer.blankText); else input.value = answer.blankText;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
    }

    return false;
  },
};

// ═══════════════════════════════════════════
//  QUESTION WATCHER
// ═══════════════════════════════════════════

const Watcher = {
  start(): void {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = setInterval(() => this.tick(), 300);
  },

  stop(): void {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  },

  async tick(): Promise<void> {
    if (!Pinia.inGame) {
      if (S.inGame) this.onGameEnd();
      return;
    }

    if (!S.inGame) this.onGameStart();

    const qId = Pinia.currentQId;
    if (!qId || qId === S.currentQId) return;

    S.currentQId = qId;
    const qType = Pinia.getType(qId);
    LOG.info(`New question detected: ${qId} (${qType})`);

    // Pre-fetch correct answer
    Panel.updateStatus("Mengambil jawaban...", "loading");

    const answer = await API.fetchCorrectAnswer(qId);
    if (answer) {
      Panel.updateAnswer(answer);
      Panel.updateStatus("Jawaban siap!", "ok");

      // Auto-click correct answer as visual feedback
      AutoClick.clickCorrect(qId);
    } else if (qType === "WORDCLOUD") {
      Panel.updateStatus("WORDCLOUD — no answer", "loading");
    } else {
      Panel.updateStatus("Gagal mengambil jawaban", "err");
    }

    Panel.updateStats();
  },

  onGameStart(): void {
    S.inGame = true;
    S.roomHash = Pinia.roomHash;
    S.quizVersionId = Pinia.quizVersionId;
    S.playerId = Pinia.playerId;
    S.totalQ = Pinia.totalQuestions;

    LOG.always(`Game: Room=${S.roomHash}, Player=${S.playerId}, Q=${S.totalQ}`);
    Panel.updateStatus("Intercept aktif!", "ok");
    Panel.updateStats();
  },

  onGameEnd(): void {
    S.inGame = false;
    S.currentQId = "";
    S.answers.clear();
    S.pendingFetches.clear();
    LOG.info("Game ended");
    Panel.updateStatus("Game selesai", "loading");
  },
};

// ═══════════════════════════════════════════
//  PANEL — MINIMAL GHOST UI
// ═══════════════════════════════════════════

const T = {
  accent: "#00e5ff", accentDim: "rgba(0,229,255,0.12)",
  green: "#00e676", greenDim: "rgba(0,230,118,0.1)",
  gold: "#ffd740", red: "#ff5252",
  text: "#e0f7fa", textDim: "#4db6ac",
  border: "rgba(0,150,136,0.3)",
};

const Panel = {
  create(): void {
    if (S.panel) return;

    const el = document.createElement("div");
    el.id = "wgvip-panel";
    el.classList.add("ghost");
    el.innerHTML = `
      <div id="wgvip-header">
        <div id="wgvip-logo">WGVIP</div>
        <div id="wgvip-header-actions">
          <button id="wgvip-btn-minimize" title="Perkecil">&#x2500;</button>
        </div>
      </div>
      <div id="wgvip-body">
        <div id="wgvip-status">
          <span id="wgvip-status-dot"></span>
          <span id="wgvip-status-text">Memulai...</span>
        </div>
        <div id="wgvip-answer-box">
          <div id="wgvip-answer-label">Jawaban yang dikirim:</div>
          <div id="wgvip-answer-text">—</div>
        </div>
        <div id="wgvip-stats">
          <span id="wgvip-stat-answers">0 jawaban</span>
          <span id="wgvip-stat-intercept">0/0 intercept</span>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.id = "wgvip-css";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
      #wgvip-panel { position:fixed;top:12px;right:12px;z-index:999999;font-family:'Inter',-apple-system,system-ui,sans-serif;font-size:12px;color:${T.text};background:linear-gradient(160deg,rgba(10,14,40,0.97),rgba(4,4,16,0.97));border:1px solid ${T.border};border-radius:10px;width:260px;box-shadow:0 6px 30px rgba(0,0,0,0.6);backdrop-filter:blur(16px);user-select:none;overflow:hidden;transition:all 0.35s ease;animation:wgvipSlide 0.35s ease; }
      #wgvip-panel.ghost { width:auto;border-radius:6px;background:none!important;backdrop-filter:none!important;box-shadow:none!important;border:none!important; }
      #wgvip-panel.ghost #wgvip-body { display:none; }
      #wgvip-panel.ghost #wgvip-logo { display:none; }
      #wgvip-panel.ghost #wgvip-header { padding:0;background:none!important;border-bottom:none!important;margin:0; }
      #wgvip-panel.ghost #wgvip-header-actions { gap:0;background:none!important; }
      #wgvip-panel.ghost #wgvip-btn-minimize { opacity:0.35;border:none!important;font-size:13px;padding:3px 8px;background:none!important;color:rgba(80,80,80,0.9);border-radius:6px;cursor:pointer;outline:none; }
      #wgvip-panel.ghost #wgvip-btn-minimize:hover { opacity:1;color:rgba(40,40,40,1); }
      @keyframes wgvipSlide { from{opacity:0;transform:translateY(-15px) scale(0.96)} to{opacity:1;transform:translateY(0) scale(1)} }
      #wgvip-header { display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:linear-gradient(135deg,${T.accentDim},transparent);border-bottom:1px solid ${T.border}; }
      #wgvip-logo { font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;color:${T.accent};letter-spacing:3px; }
      #wgvip-header-actions button { background:none;border:1px solid ${T.border};color:${T.textDim};cursor:pointer;font-size:11px;padding:2px 7px;border-radius:5px;transition:all 0.2s; }
      #wgvip-header-actions button:hover { color:${T.accent};border-color:${T.accent}; }
      #wgvip-body { padding:10px 12px; }
      #wgvip-status { display:flex;align-items:center;gap:7px;margin-bottom:8px; }
      #wgvip-status-dot { width:6px;height:6px;border-radius:50%;background:#555;flex-shrink:0; }
      #wgvip-status.ok #wgvip-status-dot { background:${T.green};box-shadow:0 0 6px ${T.green}66; }
      #wgvip-status.err #wgvip-status-dot { background:${T.red};box-shadow:0 0 6px ${T.red}66; }
      #wgvip-status.warn #wgvip-status-dot { background:${T.gold};box-shadow:0 0 6px ${T.gold}66; }
      #wgvip-status.loading #wgvip-status-dot { background:${T.accent};animation:wgvipPulse 1s infinite; }
      @keyframes wgvipPulse { 0%,100%{opacity:1}50%{opacity:0.3} }
      #wgvip-status-text { font-size:10px;color:${T.textDim}; }
      #wgvip-answer-box { background:${T.greenDim};border:1px solid rgba(0,230,118,0.2);border-radius:7px;padding:8px 10px;margin-bottom:8px; }
      #wgvip-answer-label { font-size:9px;color:${T.textDim};text-transform:uppercase;letter-spacing:1px;margin-bottom:4px; }
      #wgvip-answer-text { font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${T.green};word-break:break-word;line-height:1.3;max-height:60px;overflow-y:auto; }
      #wgvip-stats { display:flex;justify-content:space-between;font-size:9px;color:${T.textDim}; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(el);
    S.panel = el;
    S.style = style;

    el.querySelector("#wgvip-btn-minimize")!.addEventListener("click", () => el.classList.toggle("ghost"));
  },

  updateStatus(text: string, type: "ok" | "err" | "warn" | "loading" | ""): void {
    const statusEl = S.panel?.querySelector("#wgvip-status");
    const textEl = S.panel?.querySelector("#wgvip-status-text");
    if (statusEl) statusEl.className = type;
    if (textEl) textEl.textContent = text;
  },

  updateAnswer(answer: CorrectAnswer): void {
    const el = S.panel?.querySelector("#wgvip-answer-text");
    if (el) el.textContent = answer.displayText;
  },

  updateStats(): void {
    const el = S.panel?.querySelector("#wgvip-stat-answers");
    if (el) el.textContent = `${S.answers.size} jawaban`;
    this.updateInterceptCount();
  },

  updateInterceptCount(): void {
    const el = S.panel?.querySelector("#wgvip-stat-intercept");
    if (el) el.textContent = `${S.modifiedCount}/${S.interceptedCount} mod/total`;
  },

  destroy(): void {
    if (S.panel) { S.panel.remove(); S.panel = null; }
    if (S.style) { S.style.remove(); S.style = null; }
  },
};

// ═══════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════

const Boot = {
  async start(): Promise<void> {
    LOG.always("WGVIP v2.0 — Dual Interceptor (XHR + Fetch)");

    // Install interceptors FIRST
    Interceptor.install();

    Panel.create();
    Panel.updateStatus("Menunggu permainan...", "loading");

    // Wait for game
    for (let i = 0; i < 120; i++) {
      if (Pinia.inGame) break;
      await new Promise(r => setTimeout(r, 1000));
      if (i % 10 === 0) Panel.updateStatus(`Menunggu... (${i + 1}s)`, "loading");
    }

    if (!Pinia.inGame) {
      Panel.updateStatus("Permainan tidak ditemukan", "err");
      return;
    }

    S.roomHash = Pinia.roomHash;
    S.quizVersionId = Pinia.quizVersionId;
    S.playerId = Pinia.playerId;
    S.totalQ = Pinia.totalQuestions;
    S.inGame = true;

    LOG.always(`Game: Room=${S.roomHash}, Player=${S.playerId}, Q=${S.totalQ}`);
    Panel.updateStatus("Intercept aktif!", "ok");
    Panel.updateStats();

    Watcher.start();

    // Pre-fetch current question
    const qId = Pinia.currentQId;
    if (qId) {
      S.currentQId = qId;
      const answer = await API.fetchCorrectAnswer(qId);
      if (answer) {
        Panel.updateAnswer(answer);
        Panel.updateStatus("Jawaban siap!", "ok");
        AutoClick.clickCorrect(qId);
      }
    }

    LOG.success("WGVIP v2.0 ready!");
  },

  stop(): void {
    Interceptor.uninstall();
    Watcher.stop();
    Panel.destroy();
    S.inGame = false;
    S.answers.clear();
    S.pendingFetches.clear();
  },
};

// ═══════════════════════════════════════════
//  GLOBAL API + AUTO-START
// ═══════════════════════════════════════════

(window as any).WGVIP = {
  start: () => Boot.start(),
  stop: () => Boot.stop(),
  status: () => ({
    interceptActive: S.interceptActive,
    answersCached: S.answers.size,
    intercepted: S.interceptedCount,
    modified: S.modifiedCount,
  }),
  reload: (qId?: string) => {
    const id = qId || Pinia.currentQId;
    if (id) { S.answers.delete(id); API.fetchCorrectAnswer(id); }
  },
};

Boot.start();
