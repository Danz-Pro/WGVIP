/*
════════════════════════════════════════════════════════════════════
  WGVIP v3.0 — Auto-Valid Response Manipulator
  https://github.com/Danz-Pro/WGVIP

  STRATEGY: Force all proceed responses to show "correct" on client
  ═══ HOW IT WORKS ═══
  1. Override XHR prototype: responseText + response getters
  2. Override window.fetch: modify Response body
  3. When proceed API returns, FORCE all "correct" flags to true
  4. User can click ANY option → game always shows correct + high score
  5. NO pre-fetch needed — just manipulate what comes back

  ═══ ALSO INCLUDED ═══
  • Pre-fetch correct answer (for auto-click & panel display)
  • Request body modification (backup: send correct answer to server)
  • Auto-click correct option (visual feedback)
  • Response force-correct (primary: client always sees correct)
════════════════════════════════════════════════════════════════════
*/

// ═══════════════════════════════════════════
//  SAVE ORIGINALS FIRST
// ═══════════════════════════════════════════

const _origFetch = window.fetch.bind(window);
const _origXHROpen = XMLHttpRequest.prototype.open;
const _origXHRSend = XMLHttpRequest.prototype.send;
const _origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

// Save original XHR getter for responseText and response
const _origResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
const _origResponseDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');

// ═══════════════════════════════════════════
//  STATE
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
  interceptXHRCount: 0,
  interceptFetchCount: 0,
  forceCorrectCount: 0,
  debug: true,
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
//  PINIA
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
  store(name: string): any { return this._get()?._s?.get(name) || null; },
  state(name: string): any { return this.store(name)?.$state || null; },
  get roomHash(): string     { return this.state("gameData")?.roomHash || ""; },
  get quizVersionId(): string { return this.state("gameData")?.quizVersionId || ""; },
  get totalQuestions(): number { return this.state("gameData")?.totalQuestionsInQuiz || 0; },
  get currentQId(): string {
    const gq = this.state("gameQuestions");
    return gq?.currentId || gq?.currentQuestionId || "";
  },
  get inGame(): boolean { return !!(this.state("gameData")?.roomHash && this.state("gameData")?.gameState); },
  get playerId(): string { return this.state("player")?.playerId || ""; },
  getType(qId: string): string   { return this.state("gameQuestions")?.list?.[qId]?.type || "MCQ"; },
  getOptions(qId: string): any[] { return this.state("gameQuestions")?.list?.[qId]?.options || []; },
  getTargets(qId: string): any[] { return this.state("gameQuestions")?.list?.[qId]?.targets || []; },
};

const stripHtml = (html: string): string => {
  if (!html) return "";
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent || d.innerText || "").trim();
};

// ═══════════════════════════════════════════
//  RESPONSE FORCE-CORRECT ENGINE
// ═══════════════════════════════════════════

/**
 * Recursively modify ALL correctness indicators in a response object.
 * This is a shotgun approach — we change everything that could mean "incorrect"
 * to mean "correct". This ensures the game client always shows correct.
 */
function forceCorrectResponse(data: any): any {
  if (!data || typeof data !== 'object') return data;

  // Deep clone to avoid mutating cached data
  const clone = JSON.parse(JSON.stringify(data));

  function modify(obj: any): void {
    if (!obj || typeof obj !== 'object') return;

    // ═══ Direct correctness booleans ═══
    if ('isCorrect' in obj)           obj.isCorrect = true;
    if ('correct' in obj)             obj.correct = true;
    if ('isCorrectAnswer' in obj)     obj.isCorrectAnswer = true;
    if ('isIncorrect' in obj)         obj.isIncorrect = false;
    if ('incorrect' in obj)           obj.incorrect = false;
    if ('wasCorrect' in obj)          obj.wasCorrect = true;
    if ('wasIncorrect' in obj)        obj.wasIncorrect = false;
    if ('answeredCorrectly' in obj)   obj.answeredCorrectly = true;
    if ('hasCorrectAnswer' in obj)    obj.hasCorrectAnswer = true;
    if ('isValid' in obj)             obj.isValid = true;
    if ('isEvaluated' in obj)         obj.isEvaluated = true;

    // ═══ String states ═══
    if ('state' in obj && typeof obj.state === 'string') {
      obj.state = obj.state.replace(/incorrect|wrong|failed|error/i, 'correct');
    }
    if ('result' in obj && typeof obj.result === 'string') {
      obj.result = obj.result.replace(/incorrect|wrong|failed|error/i, 'correct');
    }
    if ('status' in obj && typeof obj.status === 'string') {
      if (/incorrect|wrong|failed/i.test(obj.status)) obj.status = 'correct';
    }
    if ('answerState' in obj && typeof obj.answerState === 'string') {
      obj.answerState = 'correct';
    }
    if ('playerState' in obj && typeof obj.playerState === 'string') {
      obj.playerState = obj.playerState.replace(/incorrect|wrong/i, 'correct');
    }
    if ('evaluation' in obj && typeof obj.evaluation === 'string') {
      obj.evaluation = 'correct';
    }

    // ═══ Score fields — always set to high values ═══
    if ('score' in obj && typeof obj.score === 'number' && obj.score <= 0) {
      obj.score = 600;
    }
    if ('totalScore' in obj && typeof obj.totalScore === 'number') {
      obj.totalScore = Math.max(obj.totalScore, 600);
    }
    if ('points' in obj && typeof obj.points === 'number' && obj.points <= 0) {
      obj.points = 600;
    }
    if ('streak' in obj && typeof obj.streak === 'number') {
      obj.streak = Math.max(obj.streak, 1);
    }

    // ═══ Provisional scores ═══
    if ('provisional' in obj && typeof obj.provisional === 'object' && obj.provisional) {
      if (obj.provisional.scores) {
        if (typeof obj.provisional.scores.correct === 'number') {
          obj.provisional.scores.correct = Math.max(obj.provisional.scores.correct, 600);
        }
        if (typeof obj.provisional.scores.incorrect === 'number') {
          obj.provisional.scores.incorrect = 0;
        }
      }
      if (obj.provisional.scoreBreakups) {
        if (obj.provisional.scoreBreakups.correct) {
          obj.provisional.scoreBreakups.correct.base = 600;
          obj.provisional.scoreBreakups.correct.total = 600;
        }
        if (obj.provisional.scoreBreakups.incorrect) {
          obj.provisional.scoreBreakups.incorrect.base = 0;
          obj.provisional.scoreBreakups.incorrect.total = 0;
        }
      }
    }

    // ═══ Score breakups at response level ═══
    if ('scoreBreakups' in obj && typeof obj.scoreBreakups === 'object' && obj.scoreBreakups) {
      if (obj.scoreBreakups.correct) {
        obj.scoreBreakups.correct.base = Math.max(obj.scoreBreakups.correct.base || 0, 600);
        obj.scoreBreakups.correct.total = Math.max(obj.scoreBreakups.correct.total || 0, 600);
      }
    }

    // ═══ Attempt tracking ═══
    if ('attempt' in obj && typeof obj.attempt === 'number') {
      // Don't change attempt count, but ensure evaluated
    }

    // ═══ Recurse into all nested objects ═══
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        modify(obj[key]);
      }
    }
  }

  modify(clone);
  return clone;
}

// ═══════════════════════════════════════════
//  REQUEST BODY MODIFIER (backup strategy)
// ═══════════════════════════════════════════

function tryModifyRequestBody(bodyStr: string): string {
  try {
    const body = JSON.parse(bodyStr);
    const qId = body.questionId || body?.response?.questionId;
    if (!qId) return bodyStr;

    const correctAnswer = S.answers.get(qId);
    if (!correctAnswer) return bodyStr;

    const qType = correctAnswer.type;

    if ((qType === "MCQ" || qType === "IS" || qType === "ORDER") && correctAnswer.mcqIndex !== undefined) {
      body.response.response = correctAnswer.mcqIndex;
      LOG.info(`Request mod: MCQ → ${correctAnswer.mcqIndex}`);
    } else if (qType === "MSQ" && correctAnswer.msqIndices?.length) {
      body.response.response = correctAnswer.msqIndices;
      LOG.info(`Request mod: MSQ → ${JSON.stringify(correctAnswer.msqIndices)}`);
    } else if ((qType === "BLANK" || qType === "OPEN") && correctAnswer.blankText) {
      if (body.response?.answer && Array.isArray(body.response.answer)) {
        for (const ans of body.response.answer) {
          if (ans.value && Array.isArray(ans.value)) {
            for (const v of ans.value) {
              if (v.value && typeof v.value.text !== "undefined") {
                v.value.text = correctAnswer.blankText;
              }
            }
          }
        }
      }
      LOG.info(`Request mod: BLANK → "${correctAnswer.blankText}"`);
    }

    return JSON.stringify(body);
  } catch {
    return bodyStr;
  }
}

// ═══════════════════════════════════════════
//  DUAL INTERCEPTOR — XHR + FETCH
// ═══════════════════════════════════════════

const Interceptor = {
  install(): void {
    if (S.interceptActive) return;

    // ═══════════════════════════════════════
    //  1. XHR — Override open() to tag proceed requests
    // ═══════════════════════════════════════
    XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
      const urlStr = typeof url === 'string' ? url : url.toString();
      (this as any).__wgvip_proceed = urlStr.includes('/proceed');
      (this as any).__wgvip_skip = (this as any).__wgvip_skip || false;
      (this as any).__wgvip_url = urlStr;
      (this as any).__wgvip_method = method;
      return _origXHROpen.apply(this, [method, url, ...args] as any);
    };

    // ═══════════════════════════════════════
    //  2. XHR — Override send() to modify request body
    // ═══════════════════════════════════════
    XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
      const isProceed = (this as any).__wgvip_proceed;
      const isSkip = (this as any).__wgvip_skip;
      const method = ((this as any).__wgvip_method || '').toUpperCase();

      if (isProceed && !isSkip && method === 'POST' && typeof body === 'string') {
        S.interceptXHRCount++;
        LOG.always(`XHR proceed #${S.interceptXHRCount}: ${(body as string).substring(0, 150)}...`);

        // Try request body modification (backup strategy)
        const modified = tryModifyRequestBody(body as string);
        body = modified;
      }

      return _origXHRSend.call(this, body);
    };

    // ═══════════════════════════════════════
    //  3. XHR — Override responseText getter (PRIMARY strategy)
    // ═══════════════════════════════════════
    if (_origResponseTextDesc && _origResponseTextDesc.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
        get: function() {
          const original: string = _origResponseTextDesc.get!.call(this);

          if ((this as any).__wgvip_proceed && this.readyState === 4 && original) {
            try {
              const parsed = JSON.parse(original);
              const modified = forceCorrectResponse(parsed);
              S.forceCorrectCount++;
              LOG.success(`responseText FORCE CORRECT #${S.forceCorrectCount}`);
              Panel.updateInterceptCount();
              return JSON.stringify(modified);
            } catch (e: any) {
              LOG.error(`responseText mod error: ${e.message}`);
            }
          }

          return original;
        },
        configurable: true,
      });
    }

    // ═══════════════════════════════════════
    //  4. XHR — Override response getter (for responseType = 'json')
    // ═══════════════════════════════════════
    if (_origResponseDesc && _origResponseDesc.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        get: function() {
          const original = _origResponseDesc.get!.call(this);

          if ((this as any).__wgvip_proceed && this.readyState === 4) {
            // If responseType is 'json', original is already parsed
            if (this.responseType === 'json' && original && typeof original === 'object') {
              const modified = forceCorrectResponse(original);
              S.forceCorrectCount++;
              LOG.success(`response (json) FORCE CORRECT #${S.forceCorrectCount}`);
              Panel.updateInterceptCount();
              return modified;
            }
            // If responseType is '' or 'text', original is a string
            if (typeof original === 'string' && original) {
              try {
                const parsed = JSON.parse(original);
                const modified = forceCorrectResponse(parsed);
                S.forceCorrectCount++;
                LOG.success(`response (text) FORCE CORRECT #${S.forceCorrectCount}`);
                Panel.updateInterceptCount();
                return JSON.stringify(modified);
              } catch {}
            }
          }

          return original;
        },
        configurable: true,
      });
    }

    // ═══════════════════════════════════════
    //  5. FETCH — Override window.fetch
    // ═══════════════════════════════════════
    window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = "";
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof input === "object" && "url" in input) url = (input as Request).url;

      // Modify request body if proceed (backup strategy)
      if (url.includes("/proceed") && init?.method?.toUpperCase() === "POST" && init?.body && typeof init.body === "string") {
        S.interceptFetchCount++;
        LOG.always(`Fetch proceed #${S.interceptFetchCount}`);
        init = { ...init, body: tryModifyRequestBody(init.body as string) };
      }

      // Call original fetch
      const response = await _origFetch.call(this, input, init);

      // Modify response if proceed (PRIMARY strategy)
      if (url.includes("/proceed")) {
        try {
          const text = await response.text();
          const parsed = JSON.parse(text);
          const modified = forceCorrectResponse(parsed);
          S.forceCorrectCount++;
          LOG.success(`Fetch response FORCE CORRECT #${S.forceCorrectCount}`);
          Panel.updateInterceptCount();

          return new Response(JSON.stringify(modified), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (e: any) {
          LOG.error(`Fetch response mod error: ${e.message}`);
        }
      }

      return response;
    };

    S.interceptActive = true;
    LOG.always("WGVIP v3.0 Interceptors installed (XHR + Fetch, response force-correct)");
  },

  uninstall(): void {
    if (S.interceptActive) {
      window.fetch = _origFetch;
      XMLHttpRequest.prototype.open = _origXHROpen;
      XMLHttpRequest.prototype.send = _origXHRSend;
      XMLHttpRequest.prototype.setRequestHeader = _origXHRSetHeader;

      // Restore original responseText/response getters
      if (_origResponseTextDesc) {
        Object.defineProperty(XMLHttpRequest.prototype, 'responseText', _origResponseTextDesc);
      }
      if (_origResponseDesc) {
        Object.defineProperty(XMLHttpRequest.prototype, 'response', _origResponseDesc);
      }

      S.interceptActive = false;
      LOG.info("Interceptors removed");
    }
  },
};

// ═══════════════════════════════════════════
//  NATIVE HTTP — Bypass interceptors for pre-fetch
// ═══════════════════════════════════════════

function nativePost(url: string, body: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    (xhr as any).__wgvip_skip = true; // Bypass our interceptors

    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve(xhr.responseText); }
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));

    _origXHROpen.call(xhr, "POST", url, true);
    _origXHRSetHeader.call(xhr, "Content-Type", "application/json");
    _origXHRSend.call(xhr, body);
  });
}

// ═══════════════════════════════════════════
//  PROCEED API — Pre-fetch (for auto-click & panel only)
// ═══════════════════════════════════════════

const API = {
  _baseBody(questionId: string, questionType: string): any {
    return {
      roomHash: S.roomHash,
      playerId: S.playerId,
      response: {
        attempt: 0, questionId, questionType,
        responseType: "original",
        timeTaken: 2000 + Math.floor(Math.random() * 4000),
        answer: [], isEvaluated: false, state: "attempted",
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

    const promise = this._doFetch(questionId);
    S.pendingFetches.set(questionId, promise);
    try {
      const result = await promise;
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
      if (!d?.success) { LOG.warn(`Pre-fetch failed`); return null; }

      const answer = d?.data?.question?.structure?.answer;
      const options = d?.data?.question?.structure?.options;
      if (answer === undefined || answer === null) { LOG.warn(`No answer`); return null; }

      LOG.success(`Pre-fetch answer: ${JSON.stringify(answer)}`);
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
          ? stripHtml(piniaOptions[apiAnswer].text || `#${apiAnswer + 1}`)
          : `#${apiAnswer + 1}`;
      }
    } else if (qType === "MSQ") {
      if (Array.isArray(apiAnswer)) {
        result.msqIndices = apiAnswer.filter((n: any) => typeof n === "number" && n >= 0);
        result.displayText = result.msqIndices.map(idx =>
          idx < piniaOptions.length ? stripHtml(piniaOptions[idx].text || `#${idx + 1}`) : `#${idx + 1}`
        ).join(" + ");
      }
    } else if (qType === "BLANK" || qType === "OPEN") {
      if (Array.isArray(apiAnswer) && apiAnswer.length > 0 && typeof apiAnswer[0] === "object") {
        const optionIds: string[] = [];
        apiAnswer.forEach((a: any) => {
          if (a.optionId && Array.isArray(a.optionId))
            a.optionId.forEach((oid: string) => optionIds.push(oid));
        });
        if (apiOptions) {
          for (const opt of apiOptions) {
            if (optionIds.includes(opt.id || opt._id)) { result.blankText = stripHtml(opt.text || ""); break; }
          }
        }
        if (!result.blankText && piniaOptions.length > 0) {
          const m = new Map<string, string>();
          piniaOptions.forEach((o: any) => { if (o.id || o._id) m.set(o.id || o._id, stripHtml(o.text)); });
          for (const oid of optionIds) { const t = m.get(oid); if (t) { result.blankText = t; break; } }
        }
        if (apiAnswer[0].targetId) result.blankTargetId = apiAnswer[0].targetId;
        result.displayText = result.blankText || "(blank)";
      }
    }
    return result;
  },
};

// ═══════════════════════════════════════════
//  AUTO-CLICK
// ═══════════════════════════════════════════

const AutoClick = {
  async clickCorrect(qId: string): Promise<void> {
    const answer = S.answers.get(qId);
    if (!answer) return;
    await new Promise(r => setTimeout(r, 300));

    if ((answer.type === "MCQ" || answer.type === "IS" || answer.type === "ORDER") && answer.mcqIndex !== undefined) {
      const el = document.querySelector<HTMLElement>(`[data-cy="option-${answer.mcqIndex}"]`);
      if (el) { el.click(); return; }
      const opts = document.querySelectorAll<HTMLElement>('[role="option"]');
      if (answer.mcqIndex < opts.length) opts[answer.mcqIndex].click();
    } else if (answer.type === "MSQ" && answer.msqIndices) {
      for (const idx of answer.msqIndices) {
        const el = document.querySelector<HTMLElement>(`[data-cy="option-${idx}"]`);
        if (el) el.click();
      }
    } else if ((answer.type === "BLANK" || answer.type === "OPEN") && answer.blankText) {
      const boxes = document.querySelectorAll<HTMLInputElement>('input.fib-box-input');
      if (boxes.length > 0) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) {
          let ci = 0;
          for (let i = 0; i < boxes.length && ci < answer.blankText.length; i++) {
            setter.call(boxes[i], answer.blankText[ci++]);
            boxes[i].dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      } else {
        const input = document.querySelector<HTMLInputElement>('[data-cy="fib-text-input"]')
          || document.querySelector<HTMLInputElement>('input.fib-text-input');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, answer.blankText); else input.value = answer.blankText;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }
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
    if (!Pinia.inGame) { if (S.inGame) this.onGameEnd(); return; }
    if (!S.inGame) this.onGameStart();

    const qId = Pinia.currentQId;
    if (!qId || qId === S.currentQId) return;
    S.currentQId = qId;

    LOG.info(`New question: ${qId} (${Pinia.getType(qId)})`);
    Panel.updateStatus("Auto-valid aktif", "ok");

    // Pre-fetch for auto-click + panel display (response force-correct works independently)
    const answer = await API.fetchCorrectAnswer(qId);
    if (answer) {
      Panel.updateAnswer(answer);
      AutoClick.clickCorrect(qId);
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
    Panel.updateStatus("Auto-valid aktif!", "ok");
    Panel.updateStats();
  },
  onGameEnd(): void {
    S.inGame = false; S.currentQId = "";
    S.answers.clear(); S.pendingFetches.clear();
    LOG.info("Game ended");
    Panel.updateStatus("Game selesai", "loading");
  },
};

// ═══════════════════════════════════════════
//  PANEL
// ═══════════════════════════════════════════

const T = {
  accent: "#00e5ff", green: "#00e676", gold: "#ffd740", red: "#ff5252",
  text: "#e0f7fa", textDim: "#4db6ac", border: "rgba(0,150,136,0.3)",
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
          <span id="wgvip-status-text">Auto-valid aktif</span>
        </div>
        <div id="wgvip-answer-box">
          <div id="wgvip-answer-label">AUTO VALID — Semua jawaban benar</div>
          <div id="wgvip-answer-text">Klik apa saja, semuanya auto correct</div>
        </div>
        <div id="wgvip-stats">
          <span id="wgvip-stat-answers">0 cached</span>
          <span id="wgvip-stat-intercept">0 forced</span>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.id = "wgvip-css";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
      #wgvip-panel { position:fixed;top:12px;right:12px;z-index:999999;font-family:'Inter',-apple-system,system-ui,sans-serif;font-size:12px;color:${T.text};background:linear-gradient(160deg,rgba(10,14,40,0.97),rgba(4,4,16,0.97));border:1px solid ${T.border};border-radius:10px;width:270px;box-shadow:0 6px 30px rgba(0,0,0,0.6);backdrop-filter:blur(16px);user-select:none;overflow:hidden;transition:all 0.35s ease;animation:wgvipSlide 0.35s ease; }
      #wgvip-panel.ghost { width:auto;border-radius:6px;background:none!important;backdrop-filter:none!important;box-shadow:none!important;border:none!important; }
      #wgvip-panel.ghost #wgvip-body { display:none; }
      #wgvip-panel.ghost #wgvip-logo { display:none; }
      #wgvip-panel.ghost #wgvip-header { padding:0;background:none!important;border-bottom:none!important;margin:0; }
      #wgvip-panel.ghost #wgvip-header-actions { gap:0;background:none!important; }
      #wgvip-panel.ghost #wgvip-btn-minimize { opacity:0.35;border:none!important;font-size:13px;padding:3px 8px;background:none!important;color:rgba(80,80,80,0.9);border-radius:6px;cursor:pointer;outline:none; }
      #wgvip-panel.ghost #wgvip-btn-minimize:hover { opacity:1; }
      @keyframes wgvipSlide { from{opacity:0;transform:translateY(-15px)} to{opacity:1;transform:translateY(0)} }
      #wgvip-header { display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:linear-gradient(135deg,rgba(0,229,255,0.12),transparent);border-bottom:1px solid ${T.border}; }
      #wgvip-logo { font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;color:${T.accent};letter-spacing:3px; }
      #wgvip-header-actions button { background:none;border:1px solid ${T.border};color:${T.textDim};cursor:pointer;font-size:11px;padding:2px 7px;border-radius:5px; }
      #wgvip-header-actions button:hover { color:${T.accent};border-color:${T.accent}; }
      #wgvip-body { padding:10px 12px; }
      #wgvip-status { display:flex;align-items:center;gap:7px;margin-bottom:8px; }
      #wgvip-status-dot { width:6px;height:6px;border-radius:50%;background:#555;flex-shrink:0; }
      #wgvip-status.ok #wgvip-status-dot { background:${T.green};box-shadow:0 0 6px ${T.green}66; }
      #wgvip-status.err #wgvip-status-dot { background:${T.red}; }
      #wgvip-status.loading #wgvip-status-dot { background:${T.accent};animation:wgvipPulse 1s infinite; }
      @keyframes wgvipPulse { 0%,100%{opacity:1}50%{opacity:0.3} }
      #wgvip-status-text { font-size:10px;color:${T.textDim}; }
      #wgvip-answer-box { background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.2);border-radius:7px;padding:8px 10px;margin-bottom:8px; }
      #wgvip-answer-label { font-size:9px;color:${T.textDim};text-transform:uppercase;letter-spacing:1px;margin-bottom:3px; }
      #wgvip-answer-text { font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:${T.green};word-break:break-word;line-height:1.3; }
      #wgvip-stats { display:flex;justify-content:space-between;font-size:9px;color:${T.textDim}; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(el);
    S.panel = el;
    S.style = style;
    el.querySelector("#wgvip-btn-minimize")!.addEventListener("click", () => el.classList.toggle("ghost"));
  },

  updateStatus(text: string, type: "ok" | "err" | "loading" | ""): void {
    const s = S.panel?.querySelector("#wgvip-status");
    const t = S.panel?.querySelector("#wgvip-status-text");
    if (s) s.className = type;
    if (t) t.textContent = text;
  },

  updateAnswer(answer: CorrectAnswer): void {
    const el = S.panel?.querySelector("#wgvip-answer-text");
    if (el) el.textContent = `Auto-click: ${answer.displayText}`;
  },

  updateStats(): void {
    const el = S.panel?.querySelector("#wgvip-stat-answers");
    if (el) el.textContent = `${S.answers.size} cached`;
    this.updateInterceptCount();
  },

  updateInterceptCount(): void {
    const el = S.panel?.querySelector("#wgvip-stat-intercept");
    if (el) el.textContent = `${S.forceCorrectCount} forced`;
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
    LOG.always("WGVIP v3.0 — Auto-Valid Response Manipulator");

    // Install interceptors FIRST
    Interceptor.install();

    Panel.create();
    Panel.updateStatus("Auto-valid aktif!", "ok");

    // Wait for game
    for (let i = 0; i < 120; i++) {
      if (Pinia.inGame) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!Pinia.inGame) {
      Panel.updateStatus("Belum ada game — menunggu...", "loading");
      // Keep trying
      const check = setInterval(() => {
        if (Pinia.inGame) {
          clearInterval(check);
          Boot.onGameFound();
        }
      }, 2000);
      return;
    }

    this.onGameFound();
  },

  async onGameFound(): Promise<void> {
    S.roomHash = Pinia.roomHash;
    S.quizVersionId = Pinia.quizVersionId;
    S.playerId = Pinia.playerId;
    S.totalQ = Pinia.totalQuestions;
    S.inGame = true;

    LOG.always(`Game found! Room=${S.roomHash}, Player=${S.playerId}, Q=${S.totalQ}`);
    Panel.updateStatus("Auto-valid aktif!", "ok");
    Panel.updateStats();

    Watcher.start();

    const qId = Pinia.currentQId;
    if (qId) {
      S.currentQId = qId;
      const answer = await API.fetchCorrectAnswer(qId);
      if (answer) {
        Panel.updateAnswer(answer);
        AutoClick.clickCorrect(qId);
      }
    }

    LOG.success("WGVIP v3.0 ready — semua jawaban auto correct!");
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
    active: S.interceptActive,
    forced: S.forceCorrectCount,
    xhr: S.interceptXHRCount,
    fetch: S.interceptFetchCount,
  }),
};

Boot.start();
