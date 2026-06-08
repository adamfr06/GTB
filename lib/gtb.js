import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const root = process.cwd();
const dataDir = join(root, "data");
const mutableDataDir = process.env.VERCEL ? join(tmpdir(), "gtb-data") : dataDir;

loadEnv();

export const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
export const geminiModels = uniqueList([
  geminiModel,
  ...(process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-2.0-flash-lite")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
]);

const paths = {
  blocks: join(dataDir, "blocks.json"),
  games: join(mutableDataDir, "games.json"),
  reports: join(mutableDataDir, "reports.json"),
  corrections: join(mutableDataDir, "corrections.json"),
  textureFacts: join(dataDir, "block-textures.json"),
  wikiCache: join(mutableDataDir, "wiki-cache")
};

const fileLocks = new Map();

const extraBlockFacts = {
  "minecraft:crafting_table": {
    naturalGeneration: {
      generated: true,
      places: ["villages", "witch huts", "pillager outposts", "trail ruins"],
      note: "Can appear as a placed block in generated structures."
    }
  },
  "minecraft:furnace": {
    naturalGeneration: {
      generated: true,
      places: ["village weaponsmiths", "snowy village houses", "taiga village houses"],
      note: "Can appear as a placed block in generated village structures."
    }
  },
  "minecraft:chest": {
    naturalGeneration: {
      generated: true,
      places: [
        "monster rooms",
        "strongholds",
        "villages",
        "temples",
        "nether fortresses",
        "end cities",
        "shipwrecks",
        "bastion remnants",
        "ancient cities"
      ],
      note: "Can appear as a placed block in many generated structures."
    }
  },
  "minecraft:torch": {
    naturalGeneration: {
      generated: true,
      places: ["mineshafts", "villages", "strongholds", "igloos", "woodland mansions", "pillager outposts"],
      note: "Can appear as a placed block in generated structures."
    }
  }
};

export async function health() {
  return {
    ok: true,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    model: geminiModel,
    models: geminiModels
  };
}

export async function listBlocks() {
  const blocks = await readJson(paths.blocks);
  return blocks.map((block) => ({ id: block.id, name: block.name }));
}

export async function createGame(requestedBlockId) {
  await ensureStorage();
  return withFileLock(paths.games, async () => {
    const blocks = await readJson(paths.blocks);
    const block = requestedBlockId
      ? blocks.find((candidate) => candidate.id === requestedBlockId)
      : blocks[Math.floor(Math.random() * blocks.length)];

    if (!block) throw new HttpError(400, "Unknown block id.");

    const games = await readJson(paths.games);
    const game = {
      id: randomId(),
      hiddenBlockId: block.id,
      status: "playing",
      createdAt: new Date().toISOString(),
      questions: [],
      guesses: []
    };

    games.unshift(game);
    await writeJson(paths.games, games);
    return publicGame(game);
  });
}

export async function getPublicGame(gameId) {
  await ensureStorage();
  const game = await findGame(gameId);
  if (!game) throw new HttpError(404, "Game not found.");
  return publicGame(game);
}

export async function askQuestion(gameId, rawQuestion) {
  await ensureStorage();
  const question = String(rawQuestion || "").trim();
  if (!question) throw new HttpError(400, "Question is required.");
  if (question.length > 300) throw new HttpError(400, "Question is too long.");

  return withFileLock(paths.games, async () => {
    const games = await readJson(paths.games);
    const game = games.find((candidate) => candidate.id === gameId);
    if (!game) throw new HttpError(404, "Game not found.");
    if (game.status !== "playing") throw new HttpError(400, "This game is already over.");
    if (game.questions.length >= 20) throw new HttpError(400, "You already used all 20 questions.");

    const block = await getBlock(game.hiddenBlockId);
    const corrections = await relevantCorrections(block.id);
    const exactCorrection = corrections.find(
      (correction) => normalizeQuestion(correction.question) === normalizeQuestion(question)
    );

    const answer = exactCorrection
      ? correctionAnswer(exactCorrection)
      : await answerWithAi(block, question, corrections);

    const questionRecord = {
      id: randomId(),
      question,
      answer: answer.answer,
      confidence: answer.confidence,
      reason: answer.reason,
      source: answer.source,
      createdAt: new Date().toISOString()
    };

    game.questions.push(questionRecord);
    await writeJson(paths.games, games);

    return {
      question: questionRecord,
      remainingQuestions: Math.max(0, 20 - game.questions.length)
    };
  });
}

export async function guessBlock(gameId, rawGuess) {
  await ensureStorage();
  const guess = String(rawGuess || "").trim();
  if (!guess) throw new HttpError(400, "Guess is required.");

  return withFileLock(paths.games, async () => {
    const games = await readJson(paths.games);
    const game = games.find((candidate) => candidate.id === gameId);
    if (!game) throw new HttpError(404, "Game not found.");

    const blocks = await readJson(paths.blocks);
    const hidden = blocks.find((block) => block.id === game.hiddenBlockId);
    const guessedBlock = blocks.find(
      (block) =>
        block.id.toLowerCase() === guess.toLowerCase() ||
        block.name.toLowerCase() === guess.toLowerCase()
    );

    const correct = Boolean(guessedBlock && guessedBlock.id === hidden.id);
    const guessRecord = {
      id: randomId(),
      guess,
      matchedBlockId: guessedBlock?.id || null,
      correct,
      createdAt: new Date().toISOString()
    };

    game.guesses.push(guessRecord);
    if (correct || game.questions.length >= 20) {
      game.status = correct ? "won" : "lost";
      game.finishedAt = new Date().toISOString();
    }

    await writeJson(paths.games, games);

    return {
      correct,
      status: game.status,
      hiddenBlock: game.status === "playing" ? null : { id: hidden.id, name: hidden.name },
      guess: guessRecord
    };
  });
}

export async function createReport(body) {
  await ensureStorage();
  const game = await findGame(String(body.gameId || ""));
  if (!game) throw new HttpError(404, "Game not found.");

  const question = game.questions.find((item) => item.id === body.questionId);
  if (!question) throw new HttpError(404, "Question not found.");

  const suggestedAnswer = String(body.suggestedAnswer || "").toLowerCase();
  if (!["yes", "no", "unknown"].includes(suggestedAnswer)) {
    throw new HttpError(400, "Suggested answer must be yes, no, or unknown.");
  }

  const reports = await readJson(paths.reports);
  const report = {
    id: randomId(),
    status: "pending",
    gameId: game.id,
    blockId: game.hiddenBlockId,
    questionId: question.id,
    question: question.question,
    aiAnswer: question.answer,
    suggestedAnswer,
    explanation: String(body.explanation || "").trim().slice(0, 1000),
    createdAt: new Date().toISOString()
  };

  reports.unshift(report);
  await writeJson(paths.reports, reports);
  return report;
}

export async function getAdminData() {
  await ensureStorage();
  const reports = await readJson(paths.reports);
  const corrections = await readJson(paths.corrections);
  return {
    reports,
    corrections,
    stats: {
      pendingReports: reports.filter((report) => report.status === "pending").length,
      approvedCorrections: corrections.length,
      totalReports: reports.length
    }
  };
}

export async function decideReport(reportId, decision, reviewer = "admin") {
  await ensureStorage();
  if (!["approved", "denied"].includes(decision)) {
    throw new HttpError(400, "Decision must be approved or denied.");
  }

  const reports = await readJson(paths.reports);
  const report = reports.find((candidate) => candidate.id === reportId);
  if (!report) throw new HttpError(404, "Report not found.");

  report.status = decision;
  report.reviewedAt = new Date().toISOString();
  report.reviewedBy = reviewer;

  let correction = null;
  if (decision === "approved") {
    const corrections = await readJson(paths.corrections);
    correction = {
      id: randomId(),
      blockId: report.blockId,
      question: report.question,
      answer: report.suggestedAnswer,
      explanation: report.explanation || "Approved admin correction.",
      sourceReportId: report.id,
      createdBy: reviewer,
      createdAt: new Date().toISOString()
    };
    corrections.unshift(correction);
    await writeJson(paths.corrections, corrections);
  }

  await writeJson(paths.reports, reports);
  return { report, correction };
}

async function answerWithAi(block, question, corrections) {
  const deterministic = deterministicAnswer(block, question);
  if (deterministic) return deterministic;
  const textureColor = await textureColorAnswer(block, question);
  if (textureColor) return textureColor;
  const localColor = localColorAnswer(block, question);
  if (localColor) return localColor;
  const localFact = localFactAnswer(block, question);
  if (localFact) return localFact;

  if (!process.env.GEMINI_API_KEY) {
    return heuristicAnswer(block, question);
  }

  const facts = expandBlockFacts(block);
  const wikiContext = await getWikiContext(facts, question);
  const textureContext = await getTextureContext(block.id);
  const wikiFact = wikiEvidenceAnswer(facts, question, wikiContext.text);
  if (wikiFact) return wikiFact;

  const prompt = [
    "You are the rules judge for GTB, a Minecraft block 20 questions game.",
    "Answer the player's yes/no question about the exact secret block only.",
    "You are a last-resort interpreter for questions code could not answer. Do not override supplied exact block facts or focused wiki evidence.",
    "Use this source order: approved corrections first, exact code results second, focused wiki evidence third, texture analysis fourth, supplied local block facts fifth, Minecraft Wiki excerpts sixth.",
    "Approved corrections are semantic examples, not just exact strings. If a correction says one phrasing should be yes/no, apply it to obvious paraphrases unless the new question adds a meaningful condition like 'excluding structures' or 'in Java Edition only'.",
    "For questions about letters, word counts, exact names, IDs, or direct string checks, do not answer yourself. Return a tool request JSON instead.",
    "Do not use code tools for color, texture, material, crafting, natural generation, light, sound, trading, or gameplay property questions.",
    "Tool request format: {\"tool\":\"name_contains_letter\",\"args\":{\"letter\":\"a\",\"target\":\"name\"},\"reason\":\"string check\"} or {\"tool\":\"name_word_count\",\"args\":{\"count\":2},\"reason\":\"word count check\"}.",
    "For visual/color questions, prioritize texture analysis context over broad wiki text or guessed local colors. If texture analysis says a specific unoxidized block texture is orange-only, do not count green from related oxidized variants.",
    "The secret block ID is exact. Do not answer for a base block, container block, related block, item form, future state, waxed variant, weathered variant, oxidized variant, or generic family unless the player explicitly asks about that broader thing. For example, minecraft:potted_torchflower is not generic minecraft:flower_pot, and minecraft:copper_door is not minecraft:weathered_copper_door.",
    "For this game, 'naturally generated' means the block can appear from world generation as terrain, fluid, ore, vegetation, or as a placed block in a generated structure. A crafted block can still naturally generate inside structures.",
    "If the player says 'excluding structures', 'not in structures', 'terrain only', or similar, do not count blocks that only appear as placed blocks inside generated structures.",
    "You may use reliable general Minecraft knowledge to answer common properties not explicitly listed, such as whether a block naturally generates, emits light, is crafted, is a full cube, or appears in a dimension.",
    "If the question depends on version, edition, texture-pack appearance, obscure mechanics, or wording that is too vague, answer unknown unless the supplied facts or corrections settle it.",
    "For added-before/after version questions, use the earliest relevant History row that says Added/introduced. Later rows about texture changes, loot, generation, tags, or renames are not the initial added version.",
    "Compare Minecraft versions numerically: 1.7.2 is before 1.16; 1.17 is after 1.16; 1.13 is before 1.19.",
    "If your reason says the block was added before the asked version, the answer to 'added after that version' must be no. Keep answer and reason logically consistent.",
    "Return only valid JSON with keys: answer, confidence, reason.",
    "answer must be exactly yes, no, or unknown.",
    "confidence must be a number from 0 to 1, not a word.",
    "",
    `Secret block facts:\n${JSON.stringify(facts, null, 2)}`,
    "",
    `Texture analysis context:\n${textureContext}`,
    "",
    `Minecraft Wiki context:\n${wikiContext.text}`,
    "",
    `Approved corrections for this block:\n${JSON.stringify(corrections, null, 2)}`,
    "",
    `Player question: ${question}`
  ].join("\n");

  let lastError = null;
  for (const model of geminiModels) {
    const result = await callGemini(model, prompt);
    if (result.ok) {
      const parsed = safeParseJson(result.text);
      const toolAnswer = runAnswerTool(block, parsed, question);
      if (toolAnswer) return toolAnswer;
      return cleanAiAnswer(parsed, wikiContext.available ? "gemini+wiki" : "gemini");
    }
    lastError = result;
    console.error(`Gemini error (${model}):`, result.text);
  }

  return {
    ...heuristicAnswer(block, question),
    reason: fallbackReason(lastError)
  };
}

async function getTextureContext(blockId) {
  try {
    const textureFacts = await readJson(paths.textureFacts);
    const entry = textureFacts[blockId];
    if (!entry) return "No texture analysis is available for this block yet.";
    return JSON.stringify(entry, null, 2);
  } catch {
    return "No texture analysis file exists yet. Run npm run import:textures after implementing the Python scraper.";
  }
}

async function textureColorAnswer(block, question) {
  const askedColor = extractAskedColor(question);
  if (!askedColor) return null;

  try {
    const textureFacts = await readJson(paths.textureFacts);
    const entry = textureFacts[block.id];
    const colors = (entry?.colors || []).map((color) => normalizeColor(color));
    if (!colors.length) return null;

    const hasColor = colors.includes(normalizeColor(askedColor));
    return {
      answer: hasColor ? "yes" : "no",
      confidence: 0.9,
      reason: `Checked downloaded texture analysis for ${block.name}: ${colors.join(", ")}. Related block variants were not counted.`,
      source: "texture"
    };
  } catch {
    return null;
  }
}

async function callGemini(model, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, text };

  const payload = safeParseJson(text);
  return {
    ok: true,
    status: response.status,
    text: payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"
  };
}

async function getWikiContext(block, question = "") {
  if (process.env.WIKI_CONTEXT === "0") {
    return { available: false, text: "Wiki context disabled." };
  }

  try {
    const page = await getCachedWikiPage(block);
    if (!page.extract) return { available: false, text: "No Minecraft Wiki extract found." };

    const text = [
      `Page title: ${page.title}`,
      `Source: ${page.url}`,
      "",
      focusedWikiFacts(page, question),
      "",
      filterWikiExtract(page.extract),
      page.tableContext ? `\n\n== Wiki table context ==\n${page.tableContext}` : ""
    ].join("\n");

    return { available: true, text: text.slice(0, 30000) };
  } catch (error) {
    console.error("Wiki context error:", error.message);
    return { available: false, text: "Minecraft Wiki context could not be loaded." };
  }
}

function focusedWikiFacts(page, question) {
  const q = question.toLowerCase();
  const facts = [];

  if (/\b(added|introduced|released|came out|before|after|existed|exist|version|1\.\d+)\b/.test(q)) {
    const history = extractHistoryEvidence(page.tableContext || page.extract || "");
    if (history.length) {
      facts.push(
        "== Focused version evidence ==",
        "Use these rows first for added-before/after questions:",
        ...history.map((line) => `- ${line}`)
      );
    }
  }

  return facts.join("\n");
}

function extractHistoryEvidence(text) {
  const normalized = String(text)
    .replace(/&#x200b;/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/\s+/g, " ");

  const evidence = [];
  const addedPattern = /((?:Java Edition|Bedrock Edition|Pocket Edition Alpha|Legacy Console Edition|New Nintendo 3DS Edition)[^|]{0,80}\|\s*(?:v?\d+(?:\.\d+){0,2}|TU\d+|CU\d+|Patch \d+)[^|]{0,80}\|\s*(?:[^|]{0,80}\|\s*)?(?:Added|Introduced)[^|.]{0,180}(?:\.| \|))/gi;
  for (const match of normalized.matchAll(addedPattern)) {
    evidence.push(cleanEvidenceLine(match[1]));
  }

  const sentencePattern = /((?:Added|Introduced)[^.]{0,180}\.)/gi;
  for (const match of normalized.matchAll(sentencePattern)) {
    evidence.push(cleanEvidenceLine(match[1]));
  }

  return uniqueList(evidence).slice(0, 8);
}

function cleanEvidenceLine(line) {
  return String(line)
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .replace(/\s+\.$/, ".")
    .trim();
}

async function getCachedWikiPage(block) {
  await mkdir(paths.wikiCache, { recursive: true });

  const cachePath = join(paths.wikiCache, `${safeFileName(block.id)}.json`);
  try {
    const cached = await readJson(cachePath);
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    if (ageMs < 1000 * 60 * 60 * 24 * 7 && cached.tableContext !== undefined) return cached;
  } catch {
    // Missing or invalid cache; fetch a fresh copy.
  }

  const title = wikiTitleForBlock(block);
  const url = new URL("https://minecraft.wiki/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", title);

  const response = await fetch(url, {
    headers: { "User-Agent": "GTBGame/0.1 local development; wiki context cache" }
  });
  if (!response.ok) throw new Error(`Minecraft Wiki returned ${response.status}`);

  const payload = await response.json();
  const pages = Object.values(payload?.query?.pages || {});
  const page = pages.find((candidate) => !candidate.missing) || {};
  const cached = {
    blockId: block.id,
    requestedTitle: title,
    title: page.title || title,
    url: `https://minecraft.wiki/w/${encodeURIComponent((page.title || title).replaceAll(" ", "_"))}`,
    extract: page.extract || "",
    tableContext: await getWikiTableContext(page.title || title),
    fetchedAt: new Date().toISOString()
  };

  await writeJson(cachePath, cached);
  return cached;
}

async function getWikiTableContext(title) {
  try {
    const url = new URL("https://minecraft.wiki/api.php");
    url.searchParams.set("action", "parse");
    url.searchParams.set("format", "json");
    url.searchParams.set("prop", "text");
    url.searchParams.set("disableeditsection", "1");
    url.searchParams.set("page", title);

    const response = await fetch(url, {
      headers: { "User-Agent": "GTBGame/0.1 local development; wiki table context cache" }
    });
    if (!response.ok) throw new Error(`Minecraft Wiki parse returned ${response.status}`);

    const payload = await response.json();
    const html = payload?.parse?.text?.["*"] || "";
    const sections = [
      extractHtmlSection(html, "History"),
      extractHtmlSection(html, "Obtaining"),
      extractHtmlSection(html, "Usage"),
      extractHtmlSection(html, "Data_values")
    ].filter(Boolean);

    return sections.join("\n\n").slice(0, 18000);
  } catch (error) {
    console.error("Wiki table context error:", error.message);
    return "";
  }
}

function filterWikiExtract(extract) {
  const junkHeadings = new Set([
    "achievements",
    "advancements",
    "announcements",
    "concept artwork",
    "external links",
    "gallery",
    "in other media",
    "issues",
    "navigation",
    "references",
    "screenshots",
    "videos"
  ]);
  const sections = parseWikiSections(extract);
  return sections
    .filter((section) => !junkHeadings.has(section.heading.toLowerCase()))
    .filter((section) => section.text.replace(/\s+/g, "").length > 20)
    .map((section) => section.heading === "summary" ? section.text : `== ${section.heading} ==\n${section.text}`)
    .join("\n\n");
}

function parseWikiSections(extract) {
  const sections = [{ heading: "summary", text: "" }];
  let current = sections[0];

  for (const line of extract.split("\n")) {
    const headingMatch = line.match(/^={2,6}\s*(.*?)\s*={2,6}$/);
    if (headingMatch) {
      current = { heading: headingMatch[1], text: "" };
      sections.push(current);
      continue;
    }
    current.text += `${line}\n`;
  }

  return sections.map((section) => ({
    heading: section.heading,
    text: section.text.replace(/\n{3,}/g, "\n\n").trim()
  }));
}

function extractHtmlSection(html, headingId) {
  const start = html.indexOf(`id="${headingId}"`);
  if (start === -1) return "";

  const nextHeading = html.slice(start + headingId.length).search(/<h2\b/i);
  const end = nextHeading === -1 ? html.length : start + headingId.length + nextHeading;
  const sectionHtml = html.slice(start, end);
  const text = htmlToPlainText(sectionHtml)
    .replace(/\[\s*edit(?: \| edit source)?\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 40) return "";
  return `== ${headingId.replaceAll("_", " ")} tables and rendered data ==\n${text}`;
}

function htmlToPlainText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<sup[\s\S]*?<\/sup>/gi, " ")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h2|h3|h4|table)>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}

function deterministicAnswer(block, question) {
  const q = question.toLowerCase();
  const facts = expandBlockFacts(block);
  const letterMatch =
    q.match(/\bletter\s+["']?([a-z0-9])["']?\b/) ||
    q.match(/\bcontains?\s+["']?([a-z0-9])["']?\b/) ||
    q.match(/\bhave\s+["']?([a-z0-9])["']?\s+in\b/) ||
    q.match(/\bhas\s+["']?([a-z0-9])["']?\s+in\b/) ||
    q.match(/\bis\s+["']?([a-z0-9])["']?\s+in\b/);
  const asksAboutId = /\b(id|identifier|block id|minecraft id)\b/.test(q);
  const asksAboutName = /\b(name|display name|block name|called)\b/.test(q);

  if (letterMatch && (asksAboutName || asksAboutId)) {
    const letter = letterMatch[1];
    const target = asksAboutId ? facts.id : facts.name;
    return {
      answer: target.toLowerCase().includes(letter) ? "yes" : "no",
      confidence: 1,
      reason: `Checked the ${asksAboutId ? "block id" : "block name"} directly: ${target}.`,
      source: "code"
    };
  }

  return null;
}

function localColorAnswer(block, question) {
  const facts = expandBlockFacts(block);
  const askedColor = extractAskedColor(question);
  if (!askedColor) return null;

  const normalizedAsked = normalizeColor(askedColor);
  const colors = (facts.colors || []).map((color) => normalizeColor(color));
  const hasColor = colors.includes(normalizedAsked);
  return {
    answer: hasColor ? "yes" : "no",
    confidence: 0.82,
    reason: `Checked exact-block imported color facts for ${facts.name}: ${facts.colors?.join(", ") || "none"}. Related variants were not counted.`,
    source: "code"
  };
}

function localFactAnswer(block, question) {
  const q = question.toLowerCase();
  const facts = expandBlockFacts(block);

  const nameTextMatch =
    q.match(/\b(?:have|has|contain|contains|include|includes)\s+(?:the\s+)?(?:word\s+)?["']?([a-z0-9_ -]+?)["']?\s+(?:in|inside)\s+(?:the\s+)?(?:name|block name|display name)\b/) ||
    q.match(/\b(?:is|are)\s+["']?([a-z0-9_ -]+?)["']?\s+(?:in|inside)\s+(?:the\s+)?(?:name|block name|display name)\b/);
  if (nameTextMatch) {
    const needle = cleanNameNeedle(nameTextMatch[1]);
    if (needle) {
      return {
        answer: facts.name.toLowerCase().includes(needle) ? "yes" : "no",
        confidence: 1,
        reason: `Checked the exact block name directly: ${facts.name}.`,
        source: "code"
      };
    }
  }

  const asksCraftable = /\b(craft|crafted|craftable|recipe|made in crafting)\b/.test(q);
  if (asksCraftable) {
    return {
      answer: facts.craftable ? "yes" : "no",
      confidence: 0.9,
      reason: `Checked exact local facts for ${facts.name}: craftable is ${Boolean(facts.craftable)}.`,
      source: "code"
    };
  }

  const asksNatural = /\b(natural|naturally|generate|generated|generates|spawn|spawns|world generation)\b/.test(q);
  if (asksNatural) {
    const excludesStructures =
      q.includes("excluding structure") ||
      q.includes("exclude structure") ||
      q.includes("not in structure") ||
      q.includes("outside structure") ||
      q.includes("terrain only") ||
      q.includes("not structures");
    const value = excludesStructures
      ? Boolean(facts.generation?.terrainOrFeature)
      : Boolean(facts.naturalGeneration?.generated);
    return {
      answer: value ? "yes" : "no",
      confidence: 0.88,
      reason: `Checked exact local generation facts for ${facts.name}: ${facts.naturalGeneration?.note || "no natural generation note"}`,
      source: "code"
    };
  }

  const asksDimension = /\b(overworld|nether|end)\b/.test(q);
  const normalizedDimensionQuestion = q.replaceAll("overworked", "overworld");
  if (/\b(overworld|nether|end)\b/.test(normalizedDimensionQuestion)) {
    const dimensions = facts.dimensions || [];
    const asksOverworld = normalizedDimensionQuestion.includes("overworld");
    const asksNether = normalizedDimensionQuestion.includes("nether");
    const asksEnd = /\bend\b/.test(normalizedDimensionQuestion);
    const wantsAny = /\b(or|either|any)\b/.test(normalizedDimensionQuestion);
    const checks = [];
    if (asksOverworld) checks.push(dimensions.includes("overworld"));
    if (asksNether) checks.push(dimensions.includes("nether"));
    if (asksEnd) checks.push(dimensions.includes("end"));
    if (checks.length) {
      const value = wantsAny ? checks.some(Boolean) : checks.every(Boolean);
      return {
        answer: value ? "yes" : "no",
        confidence: 0.9,
        reason: `Checked exact local dimension facts for ${facts.name}: ${dimensions.join(", ") || "none"}.`,
        source: "code"
      };
    }
  }

  const booleanChecks = [
    { pattern: /\b(full block|full cube)\b/, value: facts.solid && !facts.transparent, label: "full block" },
    { pattern: /\btransparent\b/, value: facts.transparent, label: "transparent" },
    { pattern: /\bsolid\b/, value: facts.solid, label: "solid" },
    { pattern: /\bgravity|falling block|falls\b/, value: facts.gravity, label: "gravity" },
    { pattern: /\bflammable|burns|catch fire|catches fire\b/, value: facts.flammable, label: "flammable" },
    { pattern: /\blight|emit light|emits light|glow\b/, value: facts.categories?.includes("light"), label: "light-emitting category" },
    { pattern: /\bwood|wooden\b/, value: facts.categories?.includes("wood"), label: "wood category" }
  ];
  for (const check of booleanChecks) {
    if (check.pattern.test(q)) {
      return {
        answer: check.value ? "yes" : "no",
        confidence: 0.82,
        reason: `Checked exact local facts for ${facts.name}: ${check.label} is ${Boolean(check.value)}.`,
        source: "code"
      };
    }
  }

  return null;
}

function cleanNameNeedle(value) {
  return String(value)
    .toLowerCase()
    .replace(/\b(the|word|letter)\b/g, " ")
    .replace(/[^a-z0-9 _-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wikiEvidenceAnswer(block, question, wikiText) {
  const q = question.toLowerCase();
  if (!/\b(added|introduced|released|came out|before|after|existed|exist|version|1\.\d+)\b/.test(q)) return null;

  const targetVersion = q.match(/\b(\d+(?:\.\d+){0,2})\b/)?.[1];
  if (!targetVersion) return null;

  const evidence = bestAddedVersionEvidence(block, wikiText);
  if (!evidence) return null;

  const comparison = compareMinecraftVersions(evidence.version, targetVersion);
  const asksAfter = /\b(after|newer than|later than)\b/.test(q);
  const asksBefore = /\b(before|older than|prior to|pre[- ]?)\b/.test(q);
  const asksExist = /\b(existed|exist|around|already|by|in)\b/.test(q) && !/\badded\b/.test(q);
  if (!asksAfter && !asksBefore && !asksExist) return null;

  let value;
  if (asksAfter) value = comparison > 0;
  else if (asksBefore) value = comparison < 0;
  else value = comparison <= 0;

  return {
    answer: value ? "yes" : "no",
    confidence: 0.92,
    reason: `Used scraped Minecraft Wiki History evidence for the exact block: ${evidence.line}`,
    source: "wiki+code"
  };
}

function bestAddedVersionEvidence(block, wikiText) {
  const blockWords = block.name.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  const idWords = block.id.replace("minecraft:", "").split("_").filter((word) => word.length > 2);
  const aliases = historyAliasesForBlock(block);
  const importantWords = uniqueList([...blockWords, ...idWords, ...aliases]).filter((word) => word !== "block");
  const exactName = block.name.toLowerCase();
  const pluralName = `${exactName}s`;
  const lines = String(wikiText)
    .split(/\n|(?=\b(?:Java Edition|Bedrock Edition|Pocket Edition Alpha)\b)/)
    .flatMap((line) => line.split(/\s+\|\s+/).reduce((chunks, part, index, parts) => {
      if (/\b(added|introduced|can now be placed|available without)\b/i.test(part)) {
        chunks.push(parts.slice(Math.max(0, index - 3), Math.min(parts.length, index + 2)).join(" | "));
      }
      return chunks;
    }, []))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const scored = lines
    .map((line) => {
      const lower = line.toLowerCase();
      if (/\b(not yet|not been|has not|have not|no longer|removed)\b.{0,80}\badded\b|\badded\b.{0,80}\b(not yet|not been|has not|have not|removed)\b/.test(lower)) {
        return null;
      }
      const version = extractMinecraftVersion(line);
      if (!version) return null;
      let score = importantWords.reduce((total, word) => total + (lower.includes(word) ? 1 : 0), 0);
      if (lower.includes(exactName) || lower.includes(pluralName)) score += 8;
      if (aliases.some((alias) => lower.includes(alias))) score += 4;
      if (block.id === "minecraft:white_wool" && lower.includes("added cloth in 16 colors") && lower.includes("cloth has white")) score += 20;
      if (/\bjava edition|classic|indev|infdev|alpha|beta\b/.test(lower)) score += 3;
      if (/\bpocket edition|bedrock edition\b/.test(lower)) score -= 2;
      if (/\bavailable without\b/.test(lower)) score += 2;
      if (/\bexperiment\b/.test(lower) && !/\bavailable without\b/.test(lower)) score -= 2;
      return { line, version, score };
    })
    .filter(Boolean)
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareMinecraftVersions(a.version, b.version));

  return scored[0] || null;
}

function historyAliasesForBlock(block) {
  const idName = block.id.replace("minecraft:", "");
  const aliases = [];
  if (idName.endsWith("_wool")) aliases.push("cloth");
  if (idName === "white_wool") aliases.push("white cloth");
  if (idName.includes("short_grass") || idName.includes("tall_grass")) aliases.push("tallgrass", "double tallgrass");
  return aliases;
}

function compareMinecraftVersions(left, right) {
  const a = parseMinecraftVersion(left);
  const b = parseMinecraftVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseMinecraftVersion(value) {
  return String(value).replace(/^v/i, "").match(/\d+/g)?.map(Number) || [];
}

function extractMinecraftVersion(line) {
  const match = String(line).match(/(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+)?[a-z]?)/i);
  return match?.[1] || null;
}

function extractAskedColor(question) {
  const q = question.toLowerCase();
  const asksColor = /\b(color|colour|texture|green|blue|red|pink|orange|yellow|brown|black|white|gray|grey|teal|purple|cyan|lime|magenta|tan|light gray|light grey|light blue)\b/.test(q);
  if (!asksColor) return null;

  const colorWords = [
    "light blue",
    "light gray",
    "light grey",
    "white",
    "orange",
    "magenta",
    "yellow",
    "lime",
    "pink",
    "gray",
    "grey",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black",
    "teal",
    "tan"
  ];

  return colorWords.find((color) => q.includes(color)) || null;
}

function normalizeColor(color) {
  return String(color).replace("grey", "gray").toLowerCase();
}

function runAnswerTool(block, parsed, question) {
  if (!parsed || typeof parsed !== "object" || !parsed.tool) return null;

  const q = question.toLowerCase();
  const asksStringQuestion = /\b(letter|word|words|name|display name|block name|id|identifier|called)\b/.test(q);
  if (!asksStringQuestion) return null;

  const facts = expandBlockFacts(block);
  if (parsed.tool === "name_contains_letter") {
    const letter = String(parsed.args?.letter || "").toLowerCase().slice(0, 1);
    const target = parsed.args?.target === "id" ? facts.id : facts.name;
    if (!letter) return null;
    return {
      answer: target.toLowerCase().includes(letter) ? "yes" : "no",
      confidence: 1,
      reason: `Gemini requested a code string check. Checked the ${parsed.args?.target === "id" ? "block id" : "block name"} directly: ${target}.`,
      source: "code"
    };
  }

  if (parsed.tool === "name_word_count") {
    const expected = Number(parsed.args?.count);
    const words = facts.name.trim().split(/\s+/).filter(Boolean);
    if (!Number.isFinite(expected)) return null;
    return {
      answer: words.length === expected ? "yes" : "no",
      confidence: 1,
      reason: `Gemini requested a code word-count check. ${facts.name} has ${words.length} word(s).`,
      source: "code"
    };
  }

  return null;
}

function heuristicAnswer(block, question) {
  const q = question.toLowerCase();
  const facts = expandBlockFacts(block);
  const excludesStructures =
    q.includes("excluding structure") ||
    q.includes("exclude structure") ||
    q.includes("not in structure") ||
    q.includes("outside structure") ||
    q.includes("terrain only") ||
    q.includes("not structures");

  if (excludesStructures && (q.includes("natural") || q.includes("spawn") || q.includes("generate"))) {
    const terrainGeneration = Boolean(facts.generation?.terrainOrFeature ?? facts.categories?.includes("natural"));
    return {
      answer: terrainGeneration ? "yes" : "no",
      confidence: 0.78,
      reason: "Starter fallback treated this as natural terrain/feature generation, excluding placed blocks in generated structures.",
      source: "fallback"
    };
  }

  const searchable = [
    facts.id,
    facts.name,
    ...(facts.colors || []),
    ...(facts.dimensions || []),
    ...(facts.categories || []),
    facts.added,
    facts.tool,
    facts.notes,
    facts.naturalGeneration?.note,
    ...(facts.naturalGeneration?.places || [])
  ].join(" ").toLowerCase();

  const checks = [
    ["spawn naturally", facts.naturalGeneration.generated],
    ["spawns naturally", facts.naturalGeneration.generated],
    ["generate naturally", facts.naturalGeneration.generated],
    ["generates naturally", facts.naturalGeneration.generated],
    ["naturally generate", facts.naturalGeneration.generated],
    ["naturally generates", facts.naturalGeneration.generated],
    ["natural generation", facts.naturalGeneration.generated],
    ["natural", facts.naturalGeneration.generated],
    ["overworld", facts.dimensions?.includes("overworld")],
    ["nether", facts.dimensions?.includes("nether")],
    ["end", facts.dimensions?.includes("end")],
    ["blue", facts.colors?.some((color) => color.includes("blue"))],
    ["yellow", facts.colors?.some((color) => color.includes("yellow") || color.includes("gold"))],
    ["red", facts.colors?.some((color) => color.includes("red") || color.includes("maroon"))],
    ["green", facts.colors?.includes("green")],
    ["brown", facts.colors?.includes("brown")],
    ["gray", facts.colors?.some((color) => color.includes("gray"))],
    ["transparent", facts.transparent],
    ["solid", facts.solid],
    ["gravity", facts.gravity],
    ["flammable", facts.flammable],
    ["craft", facts.craftable],
    ["pickaxe", facts.tool?.includes("pickaxe")],
    ["shovel", facts.tool === "shovel"],
    ["axe", facts.tool === "axe"],
    ["wood", facts.categories?.includes("wood")],
    ["liquid", facts.categories?.includes("liquid")],
    ["light", facts.categories?.includes("light")]
  ];

  for (const [keyword, value] of checks) {
    if (q.includes(keyword)) {
      return {
        answer: value ? "yes" : "no",
        confidence: 0.72,
        reason: "Starter fallback matched this question to a known block fact.",
        source: "fallback"
      };
    }
  }

  const nameWords = facts.name.toLowerCase().split(/\s+/);
  if (nameWords.some((word) => word.length > 3 && q.includes(word))) {
    return {
      answer: "yes",
      confidence: 0.65,
      reason: "Local fallback rules matched the question to the block name.",
      source: "fallback"
    };
  }

  if (searchable.includes(q.replace(/[^a-z0-9 ]/g, "").trim())) {
    return {
      answer: "yes",
      confidence: 0.55,
      reason: "Local fallback rules found similar text in the block facts.",
      source: "fallback"
    };
  }

  return {
    answer: "unknown",
    confidence: 0.35,
    reason: "No Gemini key is configured and the local fallback rules could not map the question to a known fact.",
    source: "fallback"
  };
}

function expandBlockFacts(block) {
  const extra = extraBlockFacts[block.id] || {};
  const pottedPatch = block.id.includes(":potted_")
    ? {
        categories: (block.categories || []).filter((category) => category !== "natural"),
        craftable: false,
        generation: {
          terrainOrFeature: false,
          structurePlaced: false
        },
        naturalGeneration: {
          generated: false,
          places: [],
          note: "Potted plant blocks are placed container variants; this exact potted block has no known natural generation in the local database."
        }
      }
    : {};
  const patchedBlock = { ...block, ...pottedPatch };
  const generation = extra.generation ||
    patchedBlock.generation || {
      terrainOrFeature: Boolean(patchedBlock.categories?.includes("natural")),
      structurePlaced: Boolean(extra.naturalGeneration?.generated && !patchedBlock.categories?.includes("natural"))
    };
  const naturalGeneration =
    extra.naturalGeneration ||
    patchedBlock.naturalGeneration || {
      generated: Boolean(patchedBlock.categories?.includes("natural")),
      places: patchedBlock.categories?.includes("natural") ? patchedBlock.dimensions || [] : [],
      note: patchedBlock.categories?.includes("natural")
        ? "Generates as part of terrain, fluids, or natural world features."
        : "No known natural generation in this starter database."
    };

  return { ...patchedBlock, ...extra, generation, naturalGeneration };
}

async function getBlock(blockId) {
  const blocks = await readJson(paths.blocks);
  const block = blocks.find((candidate) => candidate.id === blockId);
  if (!block) throw new HttpError(500, "Hidden block is missing from block database.");
  return block;
}

async function relevantCorrections(blockId) {
  const corrections = await readJson(paths.corrections);
  return corrections.filter((correction) => correction.blockId === blockId);
}

async function findGame(gameId) {
  const games = await readJson(paths.games);
  return games.find((game) => game.id === gameId);
}

function publicGame(game) {
  return {
    id: game.id,
    status: game.status,
    createdAt: game.createdAt,
    questions: game.questions,
    guesses: game.guesses,
    remainingQuestions: Math.max(0, 20 - game.questions.length),
    shareUrl: `/game/${game.id}`
  };
}

async function ensureStorage() {
  await mkdir(mutableDataDir, { recursive: true });
  for (const path of [paths.games, paths.reports, paths.corrections]) {
    try {
      await stat(path);
    } catch {
      await writeJson(path, []);
    }
  }
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function writeJson(path, value) {
  const tempPath = `${path}.${randomId()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

async function withFileLock(key, fn) {
  const previous = fileLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  fileLocks.set(key, next);

  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  }
}

function correctionAnswer(correction) {
  return {
    answer: correction.answer,
    confidence: 1,
    reason: `Approved correction: ${correction.explanation}`,
    source: "correction"
  };
}

function cleanAiAnswer(value, source) {
  const answer = ["yes", "no", "unknown"].includes(String(value.answer).toLowerCase())
    ? String(value.answer).toLowerCase()
    : "unknown";
  const confidence = Number(value.confidence);

  return {
    answer,
    confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5,
    reason: String(value.reason || "Answered from supplied block facts.").slice(0, 600),
    source
  };
}

function fallbackReason(error) {
  const text = error?.text || "";
  const parsed = safeParseJson(text);
  const message = parsed?.error?.message || "";
  if (error?.status === 429 || message.includes("quota")) {
    return "Gemini quota/rate limit was hit, so the server used local fallback rules. Wait a minute or switch models.";
  }
  return "Gemini could not answer, so the server used local fallback rules.";
}

function wikiTitleForBlock(block) {
  const overrides = {
    "minecraft:diamond_block": "Block of Diamond",
    "minecraft:lapis_block": "Lapis Lazuli Block"
  };
  return overrides[block.id] || block.name;
}

function loadEnv() {
  try {
    const text = readFileSync(join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!process.env[key]) process.env[key] = rest.join("=").trim();
    }
  } catch {
    // .env is optional.
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function normalizeQuestion(question) {
  return String(question).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueList(values) {
  return [...new Set(values)];
}

function randomId() {
  return randomUUID().slice(0, 8);
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
