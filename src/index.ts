/*
════════════════════════════════════════════════════════════════════
  WGVIP v1.0 — Wayground Request Interceptor Cheat
  https://github.com/Danz-Pro/WGVIP

  STRATEGY: Intercept & Modify Proceed API Requests
  ═══ HOW IT WORKS ═══
  1. Pre-fetch correct answers via Proceed API (dummy call)
  2. Intercept the game's actual proceed request via fetch override
  3. Replace the user's answer with the correct answer in the request body
  4. Server ALWAYS receives the correct answer
  5. User can click ANY option — result is always correct on server side

  ═══ VERIFIED FINDINGS ═══
  • Proceed API: POST /_gameapi/main/public/v1/games/{roomHash}/proceed
  • Returns correct answers in data.question.structure.answer
  • Does NOT affect game state when called via independent fetch()
  • MCQ:  answer = number       → replace response.response
  • MSQ:  answer = [numbers]    → replace response.response
  • BLANK: answer = [{optionId, targetId}] → replace text in response.answer
════════════════════════════════════════════════════════════════════
*/

// ═══════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════

interface CorrectAnswer {
  questionId: string;
  type: string;
  /** MCQ: correct option index (0-based) */
  mcqIndex?: number;
  /** MSQ: correct option indices */
  msqIndices?: number[];
  /** BLANK: correct answer text */
  blankText?: string;
  /** BLANK: target ID for answer */
  blankTargetId?: string;
  /** Display text for panel */
  displayText: string;
}

// ═══════════════════════════════════════════
//  THEME
// ═══════════════════════════════════════════

const T = {
  bg:          "rgba(6, 8, 20, 0.95)",
  bgGradient:  "linear-gradient(160deg, rgba(10,14,40,0.97), rgba(4,4,16,0.97))",
  accent:      "#00e5ff",
  accentDim:   "rgba(0,229,255,0.12)",
  accentGlow:  "rgba(0,229,255,0.35)",
  gold:        "#ffd740",
  goldDim:     "rgba(255,215,64,0.1)",
  green:       "#00e676",
  greenDim:    "rgba(0,230,118,0.1)",
  red:         "#ff5252",
  text:        "#e0f7fa",
  textMuted:   "#80cbc4",
  textDim:     "#4db6ac",
  border:      "rgba(0,150,136,0.3)",
  shadow:      "0 6px 30px rgba(0,0,0,0.6), 0 0 20px rgba(0,229,255,0.08)",
  radius:      "10px",
};

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
  originalFetch: window.fetch.bind(window),
  interceptActive: false,
  interceptedCount: 0,
  modifiedCount: 0,
};

// ═══════════════════════════════════════════
//  LOG
// ═══════════════════════════════════════════

const LOG = {
  info:    (m: string) => console.log(`%c[WGVIP]%c ${m}`, "color:#00e5ff;font-weight:bold", "color:inherit"),
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
//  PROCEED API — CORRECT ANSWER FETCHER
// ═══════════════════════════════════════════

const API = {
  /** Build base request body common to all question types */
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

  /** Build dummy body for pre-fetching correct answer */
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
      // MCQ, IS, ORDER fallback
      body.response.response = 0;
    }

    return body;
  },

  /** Fetch correct answer from Proceed API (uses original fetch to bypass interceptor) */
  async fetchCorrectAnswer(questionId: string): Promise<CorrectAnswer | null> {
    // Already being fetched? Wait for it
    const pending = S.pendingFetches.get(questionId);
    if (pending) return pending;

    // Already cached?
    const cached = S.answers.get(questionId);
    if (cached) return cached;

    // WORDCLOUD has no correct answer
    if (Pinia.getType(questionId) === "WORDCLOUD") {
      return null;
    }

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

      // Use ORIGINAL fetch to bypass our interceptor
      const r = await S.originalFetch(
        `/_gameapi/main/public/v1/games/${S.roomHash}/proceed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!r.ok) {
        LOG.warn(`Pre-fetch: HTTP ${r.status}`);
        return null;
      }

      const d = await r.json();
      if (!d?.success) {
        LOG.warn(`Pre-fetch: not success`);
        return null;
      }

      const answer = d?.data?.question?.structure?.answer;
      const options = d?.data?.question?.structure?.options;

      if (answer === undefined || answer === null) {
        LOG.warn(`Pre-fetch: no answer in response`);
        return null;
      }

      LOG.success(`Answer: ${JSON.stringify(answer)}`);
      return this._processAnswer(questionId, qType, answer, options);
    } catch (e: any) {
      LOG.error(`Pre-fetch error: ${e.message}`);
      return null;
    }
  },

  /** Process raw API answer into CorrectAnswer */
  _processAnswer(questionId: string, qType: string, apiAnswer: any, apiOptions?: any[]): CorrectAnswer {
    const result: CorrectAnswer = {
      questionId,
      type: qType,
      displayText: "—",
    };

    const piniaOptions = Pinia.getOptions(questionId);

    if (qType === "MCQ" || qType === "IS" || qType === "ORDER") {
      if (typeof apiAnswer === "number" && apiAnswer >= 0) {
        result.mcqIndex = apiAnswer;
        // Build display text from Pinia options
        if (apiAnswer < piniaOptions.length) {
          result.displayText = stripHtml(piniaOptions[apiAnswer].text || `Opsi #${apiAnswer + 1}`);
        } else {
          result.displayText = `Opsi #${apiAnswer + 1}`;
        }
      }
    } else if (qType === "MSQ") {
      if (Array.isArray(apiAnswer)) {
        result.msqIndices = apiAnswer.filter((n: any) => typeof n === "number" && n >= 0);
        // Build display texts
        const texts: string[] = [];
        result.msqIndices.forEach(idx => {
          if (idx < piniaOptions.length) {
            texts.push(stripHtml(piniaOptions[idx].text || `#${idx + 1}`));
          } else {
            texts.push(`#${idx + 1}`);
          }
        });
        result.displayText = texts.join(" + ");
      }
    } else if (qType === "BLANK" || qType === "OPEN") {
      if (Array.isArray(apiAnswer) && apiAnswer.length > 0 && typeof apiAnswer[0] === "object") {
        // Collect optionIds from answer
        const optionIds: string[] = [];
        apiAnswer.forEach((a: any) => {
          if (a.optionId && Array.isArray(a.optionId)) {
            a.optionId.forEach((oid: string) => optionIds.push(oid));
          }
        });

        // Look up text from API options first (most reliable)
        if (apiOptions && Array.isArray(apiOptions)) {
          for (const opt of apiOptions) {
            if (optionIds.includes(opt.id || opt._id)) {
              result.blankText = stripHtml(opt.text || "");
              break;
            }
          }
        }

        // Fallback: Pinia options
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

        if (apiAnswer[0].targetId) {
          result.blankTargetId = apiAnswer[0].targetId;
        }

        result.displayText = result.blankText || "(blank)";
      }
    }

    return result;
  },
};

// ═══════════════════════════════════════════
//  FETCH INTERCEPTOR — CORE CHEAT ENGINE
// ═══════════════════════════════════════════

const Interceptor = {
  /** Install fetch interceptor */
  install(): void {
    if (S.interceptActive) return;

    const originalFetch = S.originalFetch;

    window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      // Extract URL
      let url = "";
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else if (input && typeof input === "object" && "url" in input) {
        url = (input as Request).url;
      }

      // Only intercept proceed API POST requests
      if (url.includes("/proceed") && init?.method?.toUpperCase() === "POST" && init?.body) {
        S.interceptedCount++;

        try {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "");
          const qId = body.questionId || body?.response?.questionId;

          if (qId) {
            LOG.info(`⚡ Intercepted proceed: ${qId}`);

            // Ensure correct answer is available
            const correctAnswer = await API.fetchCorrectAnswer(qId);

            if (correctAnswer) {
              // Modify the request body with correct answer
              const modified = Interceptor.modifyBody(body, correctAnswer);
              init = { ...init, body: JSON.stringify(modified) };
              S.modifiedCount++;
              LOG.success(`✅ Request modified with correct answer!`);
              Panel.updateStatus("Intercept berhasil!", "ok");
              Panel.updateInterceptCount();
            } else {
              LOG.warn(`⚠ No correct answer for ${qId}, sending original`);
              Panel.updateStatus("Gagal modifikasi — jawaban asli", "warn");
            }
          }
        } catch (e: any) {
          LOG.error(`Interceptor error: ${e.message}`);
        }
      }

      // Call original fetch (or modified)
      return originalFetch.call(this, input, init);
    };

    S.interceptActive = true;
    LOG.success("Fetch interceptor installed!");
  },

  /** Modify request body to contain correct answer */
  modifyBody(body: any, answer: CorrectAnswer): any {
    const qType = answer.type;

    if (qType === "MCQ" || qType === "IS" || qType === "ORDER") {
      // MCQ: replace response.response with correct index
      if (answer.mcqIndex !== undefined) {
        LOG.info(`MCQ: ${body.response.response} → ${answer.mcqIndex}`);
        body.response.response = answer.mcqIndex;
      }
    } else if (qType === "MSQ") {
      // MSQ: replace response.response with correct indices array
      if (answer.msqIndices && answer.msqIndices.length > 0) {
        LOG.info(`MSQ: ${JSON.stringify(body.response.response)} → ${JSON.stringify(answer.msqIndices)}`);
        body.response.response = answer.msqIndices;
      }
    } else if (qType === "BLANK" || qType === "OPEN") {
      // BLANK: replace answer text and targetId
      if (answer.blankText) {
        // Walk through the answer structure and replace text
        if (body.response.answer && Array.isArray(body.response.answer)) {
          for (const ans of body.response.answer) {
            if (ans.value && Array.isArray(ans.value)) {
              for (const v of ans.value) {
                if (v.value && typeof v.value.text !== "undefined") {
                  LOG.info(`BLANK: "${v.value.text}" → "${answer.blankText}"`);
                  v.value.text = answer.blankText;
                }
              }
            }
          }
        }

        // Also update targetId if we have it
        if (answer.blankTargetId && body.response.answer?.[0]?.value?.[0]) {
          body.response.answer[0].value[0].targetId = answer.blankTargetId;
        }
      }
    }

    return body;
  },

  /** Remove interceptor */
  uninstall(): void {
    if (S.interceptActive) {
      window.fetch = S.originalFetch;
      S.interceptActive = false;
      LOG.info("Fetch interceptor removed");
    }
  },
};

// ═══════════════════════════════════════════
//  QUESTION WATCHER
// ═══════════════════════════════════════════

const Watcher = {
  start(): void {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = setInterval(() => this.tick(), 400);
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
    LOG.info(`New question: ${qId} (${qType})`);

    // Pre-fetch correct answer immediately
    Panel.updateStatus("Mengambil jawaban...", "loading");

    const answer = await API.fetchCorrectAnswer(qId);
    if (answer) {
      Panel.updateAnswer(answer);
      Panel.updateStatus("Jawaban siap — klik apa saja!", "ok");
    } else if (qType === "WORDCLOUD") {
      Panel.updateStatus("WORDCLOUD — no correct answer", "loading");
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

    LOG.always(`Game detected! Room: ${S.roomHash}, Player: ${S.playerId}, Questions: ${S.totalQ}`);
    Panel.updateStatus("Intercept aktif — klik apa saja!", "ok");
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

const Panel = {
  create(): void {
    if (S.panel) return;

    const el = document.createElement("div");
    el.id = "wgvip-panel";
    el.classList.add("ghost"); // Start minimized
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
          <span id="wgvip-stat-intercept">0 intercept</span>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.id = "wgvip-css";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
      #wgvip-panel { position:fixed;top:12px;right:12px;z-index:999999;font-family:'Inter',-apple-system,system-ui,sans-serif;font-size:12px;color:${T.text};background:${T.bgGradient};border:1px solid ${T.border};border-radius:${T.radius};width:260px;box-shadow:${T.shadow};backdrop-filter:blur(16px);user-select:none;overflow:hidden;transition:all 0.35s cubic-bezier(0.4,0,0.2,1);animation:wgvipSlide 0.35s ease; }
      #wgvip-panel.ghost { width:auto;border-radius:6px;background:none!important;backdrop-filter:none!important;box-shadow:none!important;border:none!important; }
      #wgvip-panel.ghost #wgvip-body { display:none; }
      #wgvip-panel.ghost #wgvip-logo { display:none; }
      #wgvip-panel.ghost #wgvip-header { padding:0;background:none!important;border-bottom:none!important;margin:0; }
      #wgvip-panel.ghost #wgvip-header-actions { gap:0;background:none!important; }
      #wgvip-panel.ghost #wgvip-btn-minimize { opacity:0.35;border:none!important;font-size:13px;padding:3px 8px;background:none!important;color:rgba(80,80,80,0.9);border-radius:6px;pointer-events:auto;cursor:pointer;outline:none; }
      #wgvip-panel.ghost #wgvip-btn-minimize:hover { opacity:1;color:rgba(40,40,40,1); }
      #wgvip-panel:not(.ghost) { width:260px;pointer-events:auto; }
      @keyframes wgvipSlide { from{opacity:0;transform:translateY(-15px) scale(0.96)} to{opacity:1;transform:translateY(0) scale(1)} }
      #wgvip-header { display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:linear-gradient(135deg,${T.accentDim},transparent);border-bottom:1px solid ${T.border}; }
      #wgvip-logo { font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;color:${T.accent};letter-spacing:3px; }
      #wgvip-header-actions { display:flex;gap:3px; }
      #wgvip-header-actions button { background:none;border:1px solid ${T.border};color:${T.textDim};cursor:pointer;font-size:11px;padding:2px 7px;border-radius:5px;transition:all 0.2s; }
      #wgvip-header-actions button:hover { color:${T.accent};border-color:${T.accent};background:${T.accentDim}; }
      #wgvip-body { padding:10px 12px; }
      #wgvip-status { display:flex;align-items:center;gap:7px;margin-bottom:8px; }
      #wgvip-status-dot { width:6px;height:6px;border-radius:50%;background:#555;flex-shrink:0;transition:background 0.3s; }
      #wgvip-status.ok #wgvip-status-dot { background:${T.green};box-shadow:0 0 6px ${T.green}66; }
      #wgvip-status.err #wgvip-status-dot { background:${T.red};box-shadow:0 0 6px ${T.red}66; }
      #wgvip-status.warn #wgvip-status-dot { background:${T.gold};box-shadow:0 0 6px ${T.gold}66; }
      #wgvip-status.loading #wgvip-status-dot { background:${T.accent};animation:wgvipPulse 1s infinite; }
      @keyframes wgvipPulse { 0%,100%{opacity:1}50%{opacity:0.3} }
      #wgvip-status-text { font-size:10px;color:${T.textDim}; }
      #wgvip-answer-box { background:${T.greenDim};border:1px solid rgba(0,230,118,0.2);border-radius:7px;padding:8px 10px;margin-bottom:8px; }
      #wgvip-answer-label { font-size:9px;color:${T.textDim};text-transform:uppercase;letter-spacing:1px;margin-bottom:4px; }
      #wgvip-answer-text { font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${T.green};word-break:break-word;line-height:1.3;max-height:60px;overflow-y:auto; }
      #wgvip-answer-text::-webkit-scrollbar { width:3px; }
      #wgvip-answer-text::-webkit-scrollbar-thumb { background:${T.accent}44;border-radius:2px; }
      #wgvip-stats { display:flex;justify-content:space-between;font-size:9px;color:${T.textDim}; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(el);
    S.panel = el;
    S.style = style;

    // Minimize toggle
    el.querySelector("#wgvip-btn-minimize")!.addEventListener("click", () => {
      el.classList.toggle("ghost");
    });
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
    const answersEl = S.panel?.querySelector("#wgvip-stat-answers");
    if (answersEl) answersEl.textContent = `${S.answers.size} jawaban`;
    this.updateInterceptCount();
  },

  updateInterceptCount(): void {
    const el = S.panel?.querySelector("#wgvip-stat-intercept");
    if (el) el.textContent = `${S.modifiedCount}/${S.interceptedCount} intercept`;
  },

  destroy(): void {
    if (S.panel) { S.panel.remove(); S.panel = null; }
    if (S.style) { S.style.remove(); S.style = null; }
  },
};

// ═══════════════════════════════════════════
//  BOOT — MAIN ENTRY POINT
// ═══════════════════════════════════════════

const Boot = {
  async start(): Promise<void> {
    LOG.always("WGVIP v1.0 — Request Interceptor");

    // Install fetch interceptor FIRST (before anything else)
    Interceptor.install();

    // Create minimal UI
    Panel.create();
    Panel.updateStatus("Menunggu permainan...", "loading");

    // Wait for game to start
    for (let i = 0; i < 120; i++) {
      if (Pinia.inGame) break;
      await new Promise(r => setTimeout(r, 1000));
      if (i % 10 === 0) Panel.updateStatus(`Menunggu permainan... (${i + 1}s)`, "loading");
    }

    if (!Pinia.inGame) {
      Panel.updateStatus("Permainan tidak ditemukan", "err");
      LOG.warn("No game found after 120s");
      return;
    }

    // Capture game info
    S.roomHash = Pinia.roomHash;
    S.quizVersionId = Pinia.quizVersionId;
    S.playerId = Pinia.playerId;
    S.totalQ = Pinia.totalQuestions;
    S.inGame = true;

    LOG.always(`Game: Room=${S.roomHash}, Player=${S.playerId}, Questions=${S.totalQ}`);
    Panel.updateStatus("Intercept aktif — klik apa saja!", "ok");
    Panel.updateStats();

    // Start watching for question changes
    Watcher.start();

    // Pre-fetch current question if available
    const qId = Pinia.currentQId;
    if (qId) {
      S.currentQId = qId;
      const answer = await API.fetchCorrectAnswer(qId);
      if (answer) {
        Panel.updateAnswer(answer);
        Panel.updateStatus("Jawaban siap — klik apa saja!", "ok");
      }
    }

    LOG.success("WGVIP v1.0 ready!");
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
