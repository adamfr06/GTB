export const metadata = {
  title: "About GTB",
  description: "About the Minecraft block 20 questions game"
};

export default function AboutPage() {
  return (
    <main className="shell info-shell">
      <section className="topbar compact-topbar">
        <div>
          <p className="eyebrow">About</p>
          <h1>Guess That Block</h1>
          <p className="subtle">A Minecraft block guessing game built around yes/no questions.</p>
        </div>
        <a className="primary-button" href="/">Play</a>
      </section>

      <section className="info-grid">
        <article className="panel info-panel">
          <h2>How It Works</h2>
          <p>
            The server secretly picks one Minecraft block. You get 20 yes/no questions to narrow it down, then make a final guess.
          </p>
        </article>

        <article className="panel info-panel">
          <h2>How Answers Work</h2>
          <p>
            Simple facts are checked with code first. Visual questions use downloaded Minecraft Wiki texture data. Harder wording can use Gemini with Minecraft Wiki context, but the exact hidden block always matters.
          </p>
        </article>

        <article className="panel info-panel">
          <h2>Reports</h2>
          <p>
            If an answer is wrong, report it from the question history. Approved reports become correction examples for future games.
          </p>
        </article>

        <article className="panel info-panel">
          <h2>Sharing</h2>
          <p>
            Every round has a share link. Send it to someone else and they can play the same hidden block.
          </p>
        </article>
      </section>

      <footer className="site-footer">
        <a href="/">Play</a>
        <span>Guess That Block</span>
        <a href="/admin">Admin</a>
      </footer>
    </main>
  );
}
