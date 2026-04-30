import "./globals.css";

export const metadata = {
  title: "Gamblyzer",
  description: "Gamblyzer v5 web app (DraftKings + Polymarket)",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#070912",
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <div className="shell">
          <header className="header">
            <div className="brand">
              <div className="logo" aria-hidden="true" />
              <div>
                <div className="title">Gamblyzer</div>
                <div className="subtitle">DraftKings + Polymarket (via The Odds API)</div>
              </div>
            </div>
            <a className="chip" href="https://vercel.com" target="_blank" rel="noreferrer">
              Deploy on Vercel
            </a>
          </header>
          <main className="main">{children}</main>
          <footer className="footer">
            <span className="muted">
              Keys are server-side only. This app does not place bets or provide guarantees.
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}

