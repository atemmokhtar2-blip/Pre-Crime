const modules = [
  ["01", "Group fleet", "Manage every connected group from one workspace."],
  ["02", "Member intelligence", "Profiles, activity, warnings, and moderation history."],
  ["03", "Protection center", "Anti-flood, link policies, and suspicious activity alerts."],
  ["04", "Moderation", "Controlled actions with reasons, permissions, and audit trails."],
  ["05", "Automation", "Welcome flows, scheduled announcements, and event rules."],
  ["06", "Analytics", "Growth, engagement, and moderation performance."],
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 1120, margin: "0 auto", padding: "56px 24px 80px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div style={{ letterSpacing: 3, fontWeight: 800 }}>PRE-CRIME</div>
        <div style={{ color: "#8b9ab0", fontSize: 13 }}>ENTERPRISE GROUP CONTROL</div>
      </header>
      <section style={{ padding: "88px 0 54px" }}>
        <div style={{ color: "#53d5c2", fontSize: 12, letterSpacing: 3, fontWeight: 700 }}>INTELLIGENCE · PROTECTION · CONTROL</div>
        <h1 style={{ fontSize: "clamp(42px, 7vw, 76px)", lineHeight: 1.02, maxWidth: 820, margin: "20px 0" }}>
          See risk early.<br /><span style={{ color: "#53d5c2" }}>Control every group.</span>
        </h1>
        <p style={{ color: "#a8b6c9", fontSize: 18, lineHeight: 1.7, maxWidth: 680 }}>
          One command center for Telegram communities. Independent group policies, precise permissions, transparent moderation, and actionable intelligence.
        </p>
        <div style={{ display: "inline-flex", marginTop: 20, padding: "12px 16px", border: "1px solid #285d64", borderRadius: 10, color: "#8ce8dc", background: "rgba(83,213,194,.07)", fontSize: 13 }}>
          Foundation online · Telegram webhook activation pending secure infrastructure
        </div>
      </section>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {modules.map(([number, title, description]) => (
          <article key={number} style={{ border: "1px solid #243247", borderRadius: 16, padding: 22, background: "rgba(16,23,37,.82)", minHeight: 150 }}>
            <div style={{ color: "#53d5c2", fontSize: 12, letterSpacing: 2 }}>{number}</div>
            <h2 style={{ fontSize: 19, margin: "14px 0 8px" }}>{title}</h2>
            <p style={{ color: "#8b9ab0", lineHeight: 1.6, margin: 0, fontSize: 14 }}>{description}</p>
          </article>
        ))}
      </section>
      <footer style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid #243247", color: "#65758b", fontSize: 12 }}>
        PRE-CRIME · PRIVATE BY DESIGN · BUILT FOR TELEGRAM
      </footer>
    </main>
  );
}
