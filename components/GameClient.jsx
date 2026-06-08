"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const emptyGame = null;

export default function GameClient({ initialGameId = null }) {
  const [game, setGame] = useState(emptyGame);
  const [blocks, setBlocks] = useState([]);
  const [question, setQuestion] = useState("");
  const [guess, setGuess] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [debugMode, setDebugMode] = useState(false);
  const [reportingQuestion, setReportingQuestion] = useState(null);
  const [suggestedAnswer, setSuggestedAnswer] = useState("yes");
  const [reportExplanation, setReportExplanation] = useState("");
  const reportDialogRef = useRef(null);

  const count = game?.questions?.length || 0;
  const gameOver = !game || game.status !== "playing";
  const questionDisabled = busy || gameOver || count >= 20;
  const latest = game?.questions?.at(-1);
  const shareUrl = useMemo(() => {
    if (!game || typeof window === "undefined") return "";
    return `${window.location.origin}/game/${game.id}`;
  }, [game]);

  useEffect(() => {
    loadBlocks();
    if (initialGameId) {
      loadGame(initialGameId);
    } else {
      newGame();
    }
  }, [initialGameId]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), toast.toLowerCase().includes("quota") ? 6500 : 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function loadBlocks() {
    const data = await api("/api/blocks");
    setBlocks(data.blocks);
  }

  async function newGame() {
    setBusy(true);
    try {
      const nextGame = await api("/api/games", { method: "POST", body: {} });
      setGame(nextGame);
      setQuestion("");
      setGuess("");
      if (!initialGameId) window.history.replaceState(null, "", "/");
      setToast("New block selected.");
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadGame(gameId) {
    setBusy(true);
    try {
      setGame(await api(`/api/games/${gameId}`));
    } catch (error) {
      setToast(error.message);
      await newGame();
    } finally {
      setBusy(false);
    }
  }

  async function askQuestion(event) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || !game) return;

    setBusy(true);
    try {
      const data = await api(`/api/games/${game.id}/question`, {
        method: "POST",
        body: { question: trimmed }
      });
      setGame((current) => ({
        ...current,
        questions: [...current.questions, data.question],
        remainingQuestions: data.remainingQuestions
      }));
      setQuestion("");
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitGuess() {
    const trimmed = guess.trim();
    if (!trimmed || !game) return;

    setBusy(true);
    try {
      const data = await api(`/api/games/${game.id}/guess`, {
        method: "POST",
        body: { guess: trimmed }
      });
      setGame((current) => ({
        ...current,
        status: data.status,
        guesses: [...current.guesses, data.guess]
      }));

      if (data.correct) setToast("Correct. You got it.");
      else if (data.hiddenBlock) setToast(`Game over. It was ${data.hiddenBlock.name}.`);
      else setToast("Not that block.");
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  function openReport(item) {
    setReportingQuestion(item);
    setSuggestedAnswer(item.answer === "yes" ? "no" : "yes");
    setReportExplanation("");
    window.setTimeout(() => reportDialogRef.current?.showModal(), 0);
  }

  async function submitReport(event) {
    event.preventDefault();
    if (!reportingQuestion || !game) return;

    try {
      await api("/api/reports", {
        method: "POST",
        body: {
          gameId: game.id,
          questionId: reportingQuestion.id,
          suggestedAnswer,
          explanation: reportExplanation
        }
      });
      reportDialogRef.current?.close();
      setToast("Report submitted.");
    } catch (error) {
      setToast(error.message);
    }
  }

  async function copyShareUrl() {
    await navigator.clipboard.writeText(shareUrl);
    setToast("Share link copied.");
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Guess That Block</h1>
          <p className="subtle">{initialGameId ? "Shared Minecraft block round" : "   20 Questions to guess the block"}</p>
        </div>
        <div className="topbar-actions">
          <a className="ghost-button" href="/about">About</a>
          <button className="primary-button" type="button" disabled={busy} onClick={newGame}>
            New Game
          </button>
        </div>
      </section>

      <section className="game-layout">
        <aside className="panel state-panel">
          <div className="stat-grid">
            <div>
              <span className="stat-label">Questions</span>
              <strong>{count} / 20</strong>
            </div>
            <div>
              <span className="stat-label">Status</span>
              <strong>{titleCase(game?.status || "loading")}</strong>
            </div>
          </div>

          <div className="share-box">
            <label htmlFor="shareUrl">Share</label>
            <div className="copy-row">
              <input id="shareUrl" readOnly value={shareUrl} />
              <button type="button" className="icon-button" title="Copy share link" onClick={copyShareUrl}>
                Copy
              </button>
            </div>
          </div>

          <div className="guess-box">
            <label htmlFor="guessInput">Final Guess</label>
            <div className="copy-row">
              <input id="guessInput" list="blockList" placeholder="Block name" value={guess} onChange={(event) => setGuess(event.target.value)} />
              <button type="button" className="primary-button" disabled={gameOver || busy} onClick={submitGuess}>
                Guess
              </button>
            </div>
            <datalist id="blockList">
              {blocks.map((block) => (
                <option key={block.id} value={block.name} />
              ))}
            </datalist>
          </div>

          <div className="debug-box">
            <label className="toggle-row" htmlFor="debugMode">
              <input
                id="debugMode"
                type="checkbox"
                checked={debugMode}
                onChange={(event) => setDebugMode(event.target.checked)}
              />
              <span>Debug mode</span>
            </label>
          </div>
        </aside>

        <section className="panel play-panel">
          <form className="question-form" onSubmit={askQuestion}>
            <label htmlFor="questionInput">Question</label>
            <div className="question-row">
              <input
                id="questionInput"
                maxLength={300}
                autoComplete="off"
                placeholder="Does it have blue in it?"
                disabled={questionDisabled}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <button type="submit" className="primary-button" disabled={questionDisabled}>
                Ask
              </button>
            </div>
          </form>

          {latest && (
            <div className="answer-strip">
              <span className="answer-badge" data-answer={latest.answer}>{latest.answer[0].toUpperCase()}</span>
              <div>
                <strong>{latest.answer.toUpperCase()}</strong>
                {debugMode && <p>{latest.reason}</p>}
              </div>
            </div>
          )}

          <ol className="history-list">
            {game?.questions?.map((item, index) => (
              <li className="history-item" key={item.id}>
                <div className="history-main">
                  <span className="history-number">{index + 1}</span>
                  <div>
                    <strong>{item.question}</strong>
                    {debugMode && (
                      <p>
                        {item.reason} <span className="source-tag">{item.source}</span>
                        <span className="source-tag">{Math.round(item.confidence * 100)}%</span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="history-actions">
                  <span className="mini-answer" data-answer={item.answer}>{item.answer}</span>
                  <button type="button" className="ghost-button small" onClick={() => openReport(item)}>
                    Report
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </section>

      <dialog ref={reportDialogRef} className="report-dialog">
        <form onSubmit={submitReport}>
          <h2>Report Answer</h2>
          <p className="subtle">
            {reportingQuestion ? `${reportingQuestion.question} Answered: ${reportingQuestion.answer.toUpperCase()}` : ""}
          </p>
          <label htmlFor="suggestedAnswer">Correct answer</label>
          <select id="suggestedAnswer" value={suggestedAnswer} onChange={(event) => setSuggestedAnswer(event.target.value)}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="unknown">Unknown</option>
          </select>
          <label htmlFor="reportExplanation">Explanation</label>
          <textarea
            id="reportExplanation"
            rows={4}
            placeholder="Why should this be corrected?"
            value={reportExplanation}
            onChange={(event) => setReportExplanation(event.target.value)}
          />
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={() => reportDialogRef.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="primary-button">Submit</button>
          </div>
        </form>
      </dialog>

      <footer className="site-footer">
        <a href="/about">About</a>
        <span>GTB</span>
        <a href="/admin">Admin</a>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 30000);

  try {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The request took too long. Try again in a moment.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function titleCase(value) {
  return String(value || "").replace(/^\w/, (letter) => letter.toUpperCase());
}
