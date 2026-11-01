const modules = [
  ["01", "Group fleet", "إدارة كل المجموعات المتصلة من مساحة عمل واحدة.", "Group fleet"],
  ["02", "Member intelligence", "ملفات الأعضاء والنشاط والتحذيرات وسجل الإجراءات.", "Members"],
  ["03", "Protection center", "منع الإغراق والروابط المخالفة وتنبيهات النشاط المشبوه.", "Protection"],
  ["04", "Moderation", "تحذير وكتم وتقييد وحظر مع أسباب ومسارات تدقيق.", "Moderation"],
  ["05", "Automation", "تدفقات الترحيب والوداع والرسائل المجدولة وقواعد الكلمات.", "Automation"],
  ["06", "Analytics", "النمو والتفاعل وأداء أنظمة الحماية.", "Analytics"],
  ["07", "Permissions", "أدوار وصلاحيات دقيقة لكل مشرف مع سجل تدقيق ثابت.", "Governance"],
  ["08", "Notifications", "تنبيهات قابلة للتخصيص للمجموعة أو الخاص أو فريق الإدارة.", "Alerts"],
];

const steps = [
  ["1", "افتح البوت", "أرسل /start إلى PRE CRIME في الخاص."],
  ["2", "أضفه للمجموعة", "اضغط «إضافة البوت إلى مجموعتي» واختر المجموعة."],
  ["3", "ارفعه مشرفًا", "امنحه صلاحيات حذف الرسائل وحظر الأعضاء ودعوة المستخدمين."],
  ["4", "افتح لوحة التحكم", "ستصلك رسالة «تمت الإضافة» مع لوحة التحكم الكاملة."],
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 24px 80px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div style={{ letterSpacing: 3, fontWeight: 800 }}>PRE-CRIME</div>
        <div style={{ color: "#8b9ab0", fontSize: 13 }}>حماية وإدارة مجموعات تيليجرام</div>
      </header>

      <section style={{ padding: "72px 0 40px" }}>
        <div style={{ color: "#53d5c2", fontSize: 12, letterSpacing: 3, fontWeight: 700 }}>
          ذكاء · حماية · تحكم
        </div>
        <h1 style={{ fontSize: "clamp(40px, 6.5vw, 68px)", lineHeight: 1.04, maxWidth: 820, margin: "20px 0", direction: "rtl" }}>
          ترى الخطر مبكرًا.<br />
          <span style={{ color: "#53d5c2" }}>وتتحكم في كل مجموعة.</span>
        </h1>
        <p style={{ color: "#a8b6c9", fontSize: 18, lineHeight: 1.75, maxWidth: 680, direction: "rtl" }}>
          غرفة قيادة واحدة لمجتمعاتك على تيليجرام. سياسات مستقلة لكل مجموعة، صلاحيات دقيقة، وإدارة شفافة قابلة للتدقيق.
        </p>
        <div style={{ display: "inline-flex", marginTop: 20, padding: "12px 16px", border: "1px solid #285d64", borderRadius: 10, color: "#8ce8dc", background: "rgba(83,213,194,.07)", fontSize: 13, direction: "rtl" }}>
          ✅ البوت متصل — لوحة التحكم تعمل من داخل محادثة البوت مباشرة
        </div>
      </section>

      <section style={{ marginBottom: 56 }}>
        <h2 style={{ color: "#edf3fb", fontSize: 22, margin: "0 0 20px", direction: "rtl" }}>كيف تبدأ؟</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          {steps.map(([n, title, desc]) => (
            <article key={n} style={{ border: "1px solid #243247", borderRadius: 16, padding: 22, background: "rgba(16,23,37,.82)" }}>
              <div style={{ color: "#53d5c2", fontSize: 12, letterSpacing: 2 }}>{n}</div>
              <h3 style={{ fontSize: 17, margin: "12px 0 8px", direction: "rtl" }}>{title}</h3>
              <p style={{ color: "#8b9ab0", lineHeight: 1.6, margin: 0, fontSize: 14, direction: "rtl" }}>{desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {modules.map(([number, title, description]) => (
          <article key={number} style={{ border: "1px solid #243247", borderRadius: 16, padding: 22, background: "rgba(16,23,37,.82)", minHeight: 150 }}>
            <div style={{ color: "#53d5c2", fontSize: 12, letterSpacing: 2 }}>{number}</div>
            <h2 style={{ fontSize: 19, margin: "14px 0 8px" }}>{title}</h2>
            <p style={{ color: "#8b9ab0", lineHeight: 1.6, margin: 0, fontSize: 14, direction: "rtl" }}>{description}</p>
          </article>
        ))}
      </section>

      <footer style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid #243247", color: "#65758b", fontSize: 12, direction: "rtl" }}>
        PRE CRIME • الخصوصية أولًا • مصمّم لتيليجرام
      </footer>
    </main>
  );
}
