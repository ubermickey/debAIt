const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promises: fsPromises } = require("fs");

const PORT = process.env.PORT || 3456;
const CLAUDE = "/opt/homebrew/bin/claude";
const CODEX = "/opt/homebrew/bin/codex";
const GEMINI = "/opt/homebrew/bin/gemini";
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "debait.log");
const SESSIONS_FILE = path.join(LOG_DIR, "sessions.json");
const logQueue = [];
let isWritingLog = false;

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

async function writeLogsToFile() {
  if (logQueue.length === 0 || isWritingLog) {
    return;
  }
  isWritingLog = true;
  const logsToWrite = logQueue.splice(0, logQueue.length).join("\n") + "\n";
  try {
    await fsPromises.appendFile(LOG_FILE, logsToWrite);
  } catch (err) {
    console.error("Failed to write logs to file:", err);
  } finally {
    isWritingLog = false;
  }
}


// Default general-purpose system prompt (overrides Claude Code's code-focused default)
const DEFAULT_SYSTEM_PROMPT = `You are Claude, a helpful general-purpose AI assistant made by Anthropic. \
You help with any topic: writing, analysis, math, science, creative work, advice, current events, \
and general knowledge. You think deeply, reason carefully, and give thorough answers. \
You are not limited to coding tasks.`;

// Session store: maps conversationId -> { sessionId, turns, created, provider }
const sessions = new Map();

function saveSessions() {
  const obj = {};
  for (const [k, v] of sessions) obj[k] = v;
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("Failed to save sessions:", err.message);
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        sessions.set(k, v);
      }
      console.log(`Loaded ${sessions.size} session(s) from disk`);
    }
  } catch (err) {
    console.error("Failed to load sessions:", err.message);
  }
}

loadSessions();

function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data && { data }),
  };
  const line = JSON.stringify(entry);
  console.log(line);
  logQueue.push(line);
}

function callClaude(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json"];

    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }
    if (options.model) args.push("--model", options.model);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);

    log("info", "Spawning claude", {
      promptPreview: prompt.slice(0, 80),
      resumeSession: options.sessionId || null,
    });

    const proc = spawn(CLAUDE, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      log("error", "Claude timed out after 120s, killing");
      proc.kill("SIGKILL");
      reject(new Error("Claude timed out after 120s"));
    }, 120_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      log("info", "Claude process exited", { code, stdoutBytes: stdout.length, stderrBytes: stderr.length });

      if (stderr) log("warn", "Claude stderr", { stderr: stderr.slice(0, 500) });

      if (code !== 0) {
        log("error", "Claude failed", { code, stderr: stderr.slice(0, 500) });
        return reject(new Error(stderr || `claude exited with code ${code}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        log("info", "Response parsed OK", {
          resultPreview: (parsed.result || "").slice(0, 100),
          durationMs: parsed.duration_ms,
          cost: parsed.total_cost_usd,
          sessionId: parsed.session_id,
        });
        resolve(parsed);
      } catch {
        log("warn", "JSON parse failed, returning raw", { stdoutPreview: stdout.slice(0, 200) });
        resolve({ result: stdout.trim() });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log("error", "Spawn error", { message: err.message });
      reject(err);
    });
  });
}

function parseCodexJSONL(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  let sessionId = null;
  let result = "";
  let tokenUsage = null;
  let aborted = false;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // Thread/session ID
      if (event.type === "thread.started" && event.thread_id) {
        sessionId = event.thread_id;
      }

      // Agent message text
      if (event.type === "item.completed" && event.item && event.item.type === "agent_message") {
        result = event.item.text || "";
      }

      // Token usage
      if (event.type === "turn.completed" && event.usage) {
        tokenUsage = event.usage;
      }

      // Turn aborted
      if (event.type === "turn.aborted") {
        aborted = true;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return { sessionId, result, tokenUsage, aborted };
}

function formatDiscussionPrompt(history, targetProvider, participatingProviders) {
  const nameMap = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
  const providerName = nameMap[targetProvider] || targetProvider;

  // Determine other participants from the explicit list, or fall back to who appears in history
  let otherNames;
  if (participatingProviders && participatingProviders.length > 0) {
    otherNames = participatingProviders
      .filter(p => p !== targetProvider)
      .map(p => nameMap[p] || p);
  } else {
    const seen = new Set();
    for (const msg of history) {
      if (msg.provider && msg.provider !== targetProvider && nameMap[msg.provider]) {
        seen.add(nameMap[msg.provider]);
      }
    }
    otherNames = [...seen];
    if (otherNames.length === 0) {
      otherNames = Object.entries(nameMap).filter(([k]) => k !== targetProvider).map(([, v]) => v);
    }
  }
  const othersStr = otherNames.join(" and ");

  let transcript = "";
  for (const msg of history) {
    if (msg.role === "user") {
      transcript += `[Human]: ${msg.content}\n\n`;
    } else if (msg.provider && nameMap[msg.provider]) {
      transcript += `[${nameMap[msg.provider]}]: ${msg.content}\n\n`;
    }
  }

  return (
    `You are ${providerName} in a roundtable discussion with ${othersStr} and a human moderator.\n\n` +
    `Here is the full transcript so far:\n\n${transcript}` +
    `Now respond as ${providerName}. Briefly summarize or quote the key points from ${othersStr} that you are addressing, then give your response. ` +
    `Engage directly with what each of the others said — agree, disagree, or build on their points. Do not prefix your response with your name.`
  );
}

function callGemini(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-o", "json"];

    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }

    args.push(prompt, "--yolo");

    log("info", "Spawning gemini", {
      promptPreview: prompt.slice(0, 80),
      resumeSession: options.sessionId || null,
    });

    const proc = spawn(GEMINI, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      log("error", "Gemini timed out after 120s, killing");
      proc.kill("SIGKILL");
      reject(new Error("Gemini timed out after 120s"));
    }, 120_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      log("info", "Gemini process exited", { code, stdoutBytes: stdout.length, stderrBytes: stderr.length });

      if (stderr) log("warn", "Gemini stderr", { stderr: stderr.slice(0, 500) });

      if (code !== 0) {
        log("error", "Gemini failed", { code, stderr: stderr.slice(0, 500) });
        return reject(new Error(stderr || `gemini exited with code ${code}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        // Extract token counts from stats.models (object keyed by model name)
        let tokenInput = 0;
        let tokenOutput = 0;
        if (parsed.stats && parsed.stats.models) {
          for (const modelData of Object.values(parsed.stats.models)) {
            if (modelData.tokens) {
              tokenInput += modelData.tokens.input || 0;
              tokenOutput += modelData.tokens.candidates || modelData.tokens.output || 0;
            }
          }
        }
        log("info", "Gemini response parsed OK", {
          resultPreview: (parsed.response || "").slice(0, 100),
          sessionId: parsed.session_id,
          tokenInput,
          tokenOutput,
        });
        resolve({
          result: parsed.response,
          session_id: parsed.session_id,
          token_usage: { input: tokenInput, output: tokenOutput },
        });
      } catch {
        log("warn", "Gemini JSON parse failed, returning raw", { stdoutPreview: stdout.slice(0, 200) });
        resolve({ result: stdout.trim() });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log("error", "Gemini spawn error", { message: err.message });
      reject(err);
    });
  });
}

function callCodex(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    let args;

    if (options.sessionId) {
      args = ["exec", "resume", options.sessionId, prompt, "--json", "--full-auto", "--skip-git-repo-check"];
    } else {
      args = ["exec", prompt, "--json", "--full-auto", "--skip-git-repo-check"];
    }

    if (options.model) args.push("--model", options.model);

    log("info", "Spawning codex", {
      promptPreview: prompt.slice(0, 80),
      resumeSession: options.sessionId || null,
    });

    const proc = spawn(CODEX, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      log("error", "Codex timed out after 120s, killing");
      proc.kill("SIGKILL");
      reject(new Error("Codex timed out after 120s"));
    }, 120_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      log("info", "Codex process exited", { code, stdoutBytes: stdout.length, stderrBytes: stderr.length });

      if (stderr) log("warn", "Codex stderr", { stderr: stderr.slice(0, 500) });

      if (code !== 0) {
        log("error", "Codex failed", { code, stderr: stderr.slice(0, 500) });
        return reject(new Error(stderr || `codex exited with code ${code}`));
      }

      try {
        const parsed = parseCodexJSONL(stdout);
        if (parsed.aborted) {
          log("warn", "Codex session was aborted");
        }
        log("info", "Codex response parsed OK", {
          resultPreview: (parsed.result || "").slice(0, 100),
          sessionId: parsed.sessionId,
          hasTokenUsage: !!parsed.tokenUsage,
        });
        resolve({
          result: parsed.result,
          session_id: parsed.sessionId,
          token_usage: parsed.tokenUsage,
        });
      } catch {
        log("warn", "Codex JSONL parse failed, returning raw", { stdoutPreview: stdout.slice(0, 200) });
        resolve({ result: stdout.trim() });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log("error", "Codex spawn error", { message: err.message });
      reject(err);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function extractTokens(result, provider) {
  if (provider === "codex" && result.token_usage) {
    return {
      input: result.token_usage.input_tokens || result.token_usage.total_input_tokens || 0,
      output: result.token_usage.output_tokens || result.token_usage.total_output_tokens || 0,
    };
  }
  if (provider === "gemini" && result.token_usage) {
    return { input: result.token_usage.input || 0, output: result.token_usage.output || 0 };
  }
  if (provider === "claude" && result.usage) {
    return {
      input: (result.usage.input_tokens || 0) + (result.usage.cache_read_input_tokens || 0) + (result.usage.cache_creation_input_tokens || 0),
      output: result.usage.output_tokens || 0,
    };
  }
  return { input: 0, output: 0 };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/") {
    const htmlPath = path.join(__dirname, "index.html");
    const html = fs.readFileSync(htmlPath, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }

  // View logs endpoint
  if (req.method === "GET" && req.url === "/logs") {
    try {
      const logs = fs.readFileSync(LOG_FILE, "utf-8");
      const lines = logs.trim().split("\n").slice(-50).map((l) => JSON.parse(l));
      return sendJSON(res, 200, { logs: lines });
    } catch {
      return sendJSON(res, 200, { logs: [] });
    }
  }

  // List active sessions
  if (req.method === "GET" && req.url === "/sessions") {
    const list = {};
    for (const [convId, data] of sessions) {
      list[convId] = { sessionId: data.sessionId, turns: data.turns, created: data.created, provider: data.provider || "claude" };
    }
    return sendJSON(res, 200, { sessions: list });
  }

  // New conversation
  if (req.method === "POST" && req.url === "/new") {
    let provider = "claude";
    try {
      const body = await readBody(req);
      if (body.provider === "codex" || body.provider === "gemini") provider = body.provider;
    } catch {}
    const convId = "conv_" + Date.now();
    sessions.set(convId, { sessionId: null, turns: 0, created: new Date().toISOString(), provider });
    saveSessions();
    log("info", "New conversation created", { convId, provider });
    return sendJSON(res, 200, { conversationId: convId, provider });
  }

  // Provider availability
  if (req.method === "GET" && req.url === "/providers") {
    const codexAvailable = fs.existsSync(CODEX);
    const geminiAvailable = fs.existsSync(GEMINI);
    const availableCount = 1 + (codexAvailable ? 1 : 0) + (geminiAvailable ? 1 : 0);
    return sendJSON(res, 200, {
      providers: {
        claude: { available: true },
        codex: {
          available: codexAvailable,
          ...(codexAvailable ? {} : { warning: "Codex CLI not found at " + CODEX }),
        },
        gemini: {
          available: geminiAvailable,
          ...(geminiAvailable ? {} : { warning: "Gemini CLI not found at " + GEMINI }),
        },
      },
      discussionAvailable: availableCount >= 2,
    });
  }

  // Discussion mode endpoint
  if (req.method === "POST" && req.url === "/discuss") {
    try {
      const body = await readBody(req);
      if (!body.history || !Array.isArray(body.history)) {
        return sendJSON(res, 400, { error: "Missing 'history' array" });
      }
      const provider = body.provider;
      if (provider !== "claude" && provider !== "codex" && provider !== "gemini") {
        return sendJSON(res, 400, { error: "Invalid provider. Must be 'claude', 'codex', or 'gemini'" });
      }
      if (provider === "codex" && !fs.existsSync(CODEX)) {
        return sendJSON(res, 400, { error: "Codex CLI not found at " + CODEX });
      }
      if (provider === "gemini" && !fs.existsSync(GEMINI)) {
        return sendJSON(res, 400, { error: "Gemini CLI not found at " + GEMINI });
      }

      const participants = body.participants || [];
      const prompt = formatDiscussionPrompt(body.history, provider, participants);
      log("info", "Discussion request", { provider, historyLength: body.history.length, participants });

      const start = Date.now();
      let result;
      if (provider === "codex") {
        result = await callCodex(prompt, {});
      } else if (provider === "gemini") {
        result = await callGemini(prompt, {});
      } else {
        result = await callClaude(prompt, {});
      }

      // Extract tokens
      const tokens = extractTokens(result, provider);

      return sendJSON(res, 200, {
        result: result.result,
        provider,
        durationMs: result.duration_ms || (Date.now() - start),
        tokens,
      });
    } catch (err) {
      log("error", "Discussion request failed", { error: err.message });
      return sendJSON(res, 500, { error: err.message });
    }
  }

  if (req.method === "POST" && req.url === "/ask") {
    try {
      const body = await readBody(req);

      if (!body.prompt) {
        return sendJSON(res, 400, { error: "Missing 'prompt' field" });
      }

      // Validate provider
      const provider = body.provider || "claude";
      if (provider !== "claude" && provider !== "codex" && provider !== "gemini") {
        return sendJSON(res, 400, { error: "Invalid provider. Must be 'claude', 'codex', or 'gemini'" });
      }

      // Check CLI availability
      if (provider === "codex" && !fs.existsSync(CODEX)) {
        return sendJSON(res, 400, { error: "Codex CLI not found at " + CODEX });
      }
      if (provider === "gemini" && !fs.existsSync(GEMINI)) {
        return sendJSON(res, 400, { error: "Gemini CLI not found at " + GEMINI });
      }

      // Get or create conversation
      let convId = body.conversationId;
      if (!convId || !sessions.has(convId)) {
        convId = "conv_" + Date.now();
        sessions.set(convId, { sessionId: null, turns: 0, created: new Date().toISOString(), provider });
      }

      const conv = sessions.get(convId);

      // Prevent switching providers mid-conversation
      if (conv.turns > 0 && conv.provider && conv.provider !== provider) {
        return sendJSON(res, 400, { error: `Cannot switch provider mid-conversation. This conversation uses ${conv.provider}.` });
      }

      // Set provider on first turn
      if (!conv.provider) conv.provider = provider;

      log("info", "Request received", {
        prompt: body.prompt.slice(0, 80),
        conversationId: convId,
        provider,
        turn: conv.turns + 1,
      });

      let result;
      if (provider === "codex") {
        result = await callCodex(body.prompt, {
          model: body.model,
          sessionId: conv.sessionId,
        });
      } else if (provider === "gemini") {
        result = await callGemini(body.prompt, {
          sessionId: conv.sessionId,
        });
      } else {
        result = await callClaude(body.prompt, {
          model: body.model,
          systemPrompt: body.systemPrompt || DEFAULT_SYSTEM_PROMPT,
          sessionId: conv.sessionId,
        });
      }

      // Store the session_id for continuation
      if (result.session_id) {
        conv.sessionId = result.session_id;
      }
      conv.turns++;
      saveSessions();

      // Extract tokens
      const tokens = extractTokens(result, provider);

      return sendJSON(res, 200, {
        result: result.result,
        conversationId: convId,
        provider,
        turn: conv.turns,
        durationMs: result.duration_ms,
        tokens,
      });
    } catch (err) {
      log("error", "Request failed", { error: err.message });
      return sendJSON(res, 500, { error: err.message });
    }
  }

  sendJSON(res, 404, { error: "Not found. Use POST /ask" });
});

server.listen(PORT, () => {
  log("info", "Server started", { port: PORT });
  console.log(`debAIt running on http://localhost:${PORT}`);
  console.log(`Logs: ${LOG_FILE}`);

  // Start log writer
  setInterval(writeLogsToFile, 5000); // Write logs every 5 seconds
});

// Implement graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received. Shutting down gracefully...");
  await writeLogsToFile(); // Write any remaining logs
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Shutting down gracefully...");
  await writeLogsToFile(); // Write any remaining logs
  process.exit(0);
});
