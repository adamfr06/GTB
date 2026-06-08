"use client";

import { useEffect, useMemo, useState } from "react";

export default function AdminClient() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState(null);
  const [config, setConfig] = useState(null);
  const [reports, setReports] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const sortedReports = useMemo(() => {
    return [...reports].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [reports]);

  useEffect(() => {
    checkSession();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function checkSession() {
    try {
      const data = await api("/api/admin/me");
      setSession(data.admin);
      setConfig(data.config);
      if (data.admin) await loadAdmin();
    } catch (error) {
      setToast(error.message);
    }
  }

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        body: { username, password }
      });
      setSession(data.admin);
      setPassword("");
      setToast("Signed in.");
      await loadAdmin();
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await api("/api/admin/logout", { method: "POST" });
      setSession(null);
      setReports([]);
      setCorrections([]);
      setStats(null);
      setToast("Signed out.");
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadAdmin() {
    const data = await api("/api/admin/reports");
    setReports(data.reports);
    setCorrections(data.corrections);
    setStats(data.stats);
  }

  async function decide(id, decision) {
    setBusy(true);
    try {
      await api(`/api/admin/reports/${id}`, {
        method: "POST",
        body: { decision }
      });
      setToast(`Report ${decision}.`);
      await loadAdmin();
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell admin-shell">
      <section className="topbar compact-topbar">
        <div>
          <p className="eyebrow">Owner Console</p>
          <h1>Admin</h1>
          <p className="subtle">Review bug reports, approve corrections, and keep GTB honest.</p>
        </div>
        <div className="topbar-actions">
          <a className="ghost-button" href="/">Game</a>
          {session && (
            <button className="ghost-button" type="button" disabled={busy} onClick={logout}>
              Sign Out
            </button>
          )}
        </div>
      </section>

      {!session ? (
        <section className="auth-layout">
          <form className="panel auth-panel" onSubmit={login}>
            <h2>Sign In</h2>
            {config && !config.configured && (
              <p className="warning-box">
                Admin auth is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET in your environment.
              </p>
            )}
            <label htmlFor="adminUsername">Username</label>
            <input
              id="adminUsername"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <label htmlFor="adminPassword">Password</label>
            <input
              id="adminPassword"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="primary-button wide-button" type="submit" disabled={busy || config?.configured === false}>
              Sign In
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="admin-stats">
            <div className="panel stat-card">
              <span className="stat-label">Pending</span>
              <strong>{stats?.pendingReports ?? 0}</strong>
            </div>
            <div className="panel stat-card">
              <span className="stat-label">Reports</span>
              <strong>{stats?.totalReports ?? reports.length}</strong>
            </div>
            <div className="panel stat-card">
              <span className="stat-label">Corrections</span>
              <strong>{stats?.approvedCorrections ?? corrections.length}</strong>
            </div>
          </section>

          <section className="admin-grid">
            <section className="panel">
              <div className="section-head">
                <div>
                  <h2>Reports</h2>
                  <p className="subtle compact-copy">Pending reports appear first.</p>
                </div>
                <button className="ghost-button small" type="button" disabled={busy} onClick={loadAdmin}>
                  Refresh
                </button>
              </div>

              <div className="admin-list">
                {sortedReports.length === 0 && <p className="empty">No reports yet.</p>}
                {sortedReports.map((report) => (
                  <article className="admin-item" key={report.id} data-status={report.status}>
                    <div className="admin-item-head">
                      <strong>{report.blockId}</strong>
                      <span className="status-pill">{report.status}</span>
                    </div>
                    <dl className="report-facts">
                      <div>
                        <dt>Question</dt>
                        <dd>{report.question}</dd>
                      </div>
                      <div>
                        <dt>Current</dt>
                        <dd>{report.aiAnswer}</dd>
                      </div>
                      <div>
                        <dt>Suggested</dt>
                        <dd>{report.suggestedAnswer}</dd>
                      </div>
                    </dl>
                    <p>{report.explanation || "No explanation provided."}</p>
                    {report.status === "pending" && (
                      <div className="admin-actions">
                        <button className="primary-button small" type="button" disabled={busy} onClick={() => decide(report.id, "approved")}>
                          Approve
                        </button>
                        <button className="ghost-button small" type="button" disabled={busy} onClick={() => decide(report.id, "denied")}>
                          Deny
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="section-head">
                <div>
                  <h2>Approved Corrections</h2>
                  <p className="subtle compact-copy">These examples are fed back into future answers.</p>
                </div>
              </div>
              <div className="admin-list">
                {corrections.length === 0 && <p className="empty">No approved corrections yet.</p>}
                {corrections.map((correction) => (
                  <article className="admin-item" key={correction.id}>
                    <div className="admin-item-head">
                      <strong>{correction.blockId}</strong>
                      <span className="status-pill">{correction.answer}</span>
                    </div>
                    <p><b>Question:</b> {correction.question}</p>
                    <p>{correction.explanation}</p>
                  </article>
                ))}
              </div>
            </section>
          </section>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
