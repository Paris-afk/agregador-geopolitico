"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";
import Nav from "@/components/Nav";

/*
 * /predicciones — La hoja de servicio del analista.
 *
 * Muestra las predicciones pendientes (las que vencen pronto destacadas),
 * las resueltas con su veredicto, y el track record del analista.
 */

const ibmPlexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["600", "700", "800"] });

type Prediction = {
  id: number;
  sourceType: "thread" | "meta";
  sourceId: number;
  threadId: number | null;
  threadTitle: string | null;
  statement: string;
  condition: string | null;
  falsificationCondition: string | null;
  reviewDate: string | null;
  status: "pending" | "confirmed" | "falsified" | "unverifiable";
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

type Stats = {
  total: number;
  pending: number;
  confirmed: number;
  falsified: number;
  unverifiable: number;
  bySourceType: Record<string, { total: number; confirmed: number; falsified: number; unverifiable: number }>;
  byThread: Array<{ threadId: number | null; title: string; total: number; confirmed: number; falsified: number }>;
};

type ThemeMode = "auto" | "light" | "dark";

function themeCSS(effective: "light" | "dark"): string {
  if (effective === "light") {
    return `
      :root {
        --page-bg: oklch(0.98 0.002 95);
        --fg: oklch(0.26 0.01 90);
        --fg-strong: oklch(0.12 0.01 85);
        --muted: oklch(0.48 0.01 82);
        --faint: oklch(0.6 0.008 85);
        --line: oklch(0 0 0 / .1);
        --line-strong: oklch(0 0 0 / .18);
        --rule: oklch(0 0 0 / .55);
        --alarm: oklch(0.55 0.18 22);
        --alarm-soft: oklch(0.55 0.18 22 / .08);
        --confirm: oklch(0.45 0.12 150);
        --confirm-soft: oklch(0.45 0.12 150 / .08);
        --falsify: oklch(0.55 0.18 22);
        --falsify-soft: oklch(0.55 0.18 22 / .08);
        --accent: oklch(0.5 0.12 250);
      }
    `;
  }
  return `
    :root {
      --page-bg: oklch(0.148 0.006 74);
      --fg: oklch(0.78 0.014 84);
      --fg-strong: oklch(0.94 0.02 88);
      --muted: oklch(0.55 0.012 82);
      --faint: oklch(0.46 0.01 82);
      --line: oklch(1 0 0 / .09);
      --line-strong: oklch(1 0 0 / .22);
      --rule: oklch(0.9 0.018 88 / .46);
      --alarm: oklch(0.65 0.19 26);
      --alarm-soft: oklch(0.65 0.19 26 / .08);
      --confirm: oklch(0.72 0.12 150);
      --confirm-soft: oklch(0.72 0.12 150 / .08);
      --falsify: oklch(0.68 0.19 26);
      --falsify-soft: oklch(0.68 0.19 26 / .08);
      --accent: oklch(0.72 0.1 250);
    }
  `;
}

export default function PredictionsPage() {
  const [data, setData] = useState<{ dueSoon: Prediction[]; pending: Prediction[]; resolved: Prediction[]; stats: Stats; todayISO: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [themePref, setThemePref] = useState<ThemeMode>("auto");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const h = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  const effectiveTheme: "light" | "dark" = themePref === "auto" ? (systemDark ? "dark" : "light") : themePref;

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/predictions");
        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const statusBadge: Record<string, { label: string; cls: string }> = {
    confirmed: { label: "CONFIRMADA", cls: "color: var(--confirm); border-color: var(--confirm); background: var(--confirm-soft)" },
    falsified: { label: "FALSADA", cls: "color: var(--falsify); border-color: var(--falsify); background: var(--falsify-soft)" },
    unverifiable: { label: "INVERIFICABLE", cls: "color: var(--faint); border-color: var(--line); background: transparent" },
    pending: { label: "EN CURSO", cls: "color: var(--muted); border-color: var(--line-strong); background: transparent" },
  };

  return (
    <>
      <style>{`${themeCSS(effectiveTheme)}`}</style>
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)", transition: "background .25s,color .25s", fontFamily: `${playfair.style.fontFamily}, Georgia, serif` }}>

        {/* Nav */}
        <div className="max-w-[960px] mx-auto pt-[26px] px-4 md:px-8">
          <div style={{ paddingTop: 14 }}>
            <Nav themePref={themePref} onThemeChange={setThemePref} />
          </div>
          <Link href="/predicciones" className={`${ibmPlexMono.className} inline-flex items-center gap-[9px] mt-[18px]`} style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)" }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>←</span>Volver a predicciones
          </Link>
        </div>

        <main className="max-w-[960px] mx-auto px-4 md:px-8 pb-[120px]">
          <h1 className="font-extrabold" style={{ margin: "36px 0 0", fontSize: "clamp(30px, 4.6vw, 48px)", letterSpacing: "-.012em", color: "var(--fg-strong)", textWrap: "pretty" }}>
            Predicciones y track record
          </h1>
          <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)", marginTop: 12 }}>
            Hoja de servicio del analista
          </div>

          {loading ? (
            <div className={`${ibmPlexMono.className} text-xs tracking-[.18em] uppercase`} style={{ color: "var(--muted)", padding: "60px 0", textAlign: "center" }}>Cargando...</div>
          ) : !data ? (
            <div className={`${ibmPlexMono.className} text-xs uppercase tracking-[.2em]`} style={{ color: "var(--muted)", padding: "60px 0", textAlign: "center" }}>Sin datos</div>
          ) : (
            <>
              {/* VENCEN PRONTO */}
              <Section title="Vencen pronto" accent="var(--alarm)" mt={40}>
                {data.dueSoon.length === 0 ? (
                  <Empty text="Ninguna predicción vence en los próximos 7 días." />
                ) : (
                  data.dueSoon.map((p) => <PredictionRow key={p.id} p={p} statusBadge={statusBadge} highlight />)
                )}
              </Section>

              {/* EN CURSO */}
              <Section title="En curso" mt={36}>
                {data.pending.length === 0 ? (
                  <Empty text="Sin predicciones en curso." />
                ) : (
                  data.pending.map((p) => <PredictionRow key={p.id} p={p} statusBadge={statusBadge} />)
                )}
              </Section>

              {/* RESUELTAS */}
              <Section title="Resueltas" mt={44}>
                {data.resolved.length === 0 ? (
                  <Empty text="Todavía no hay predicciones evaluadas." />
                ) : (
                  data.resolved.map((p) => <PredictionRow key={p.id} p={p} statusBadge={statusBadge} />)
                )}
              </Section>

              {/* TRACK RECORD */}
              <Section title="Track record" mt={48}>
                <TrackRecord stats={data.stats} />
              </Section>
            </>
          )}
        </main>
      </div>
    </>
  );
}

function Section({ title, children, mt, accent }: { title: string; children: React.ReactNode; mt: number; accent?: string }) {
  return (
    <section style={{ marginTop: mt }}>
      <div className="flex items-center gap-[14px] mb-4">
        <span className={`${ibmPlexMono.className}`} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: accent ?? "var(--fg-strong)", fontWeight: 600 }}>{title}</span>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className={`${ibmPlexMono.className} text-xs uppercase tracking-[.14em]`} style={{ color: "var(--faint)", padding: "14px 0" }}>{text}</div>;
}

function PredictionRow({ p, statusBadge, highlight }: { p: Prediction; statusBadge: Record<string, { label: string; cls: string }>; highlight?: boolean }) {
  const badge = statusBadge[p.status];
  return (
    <Link href={`/predicciones/${p.id}`} style={{ textDecoration: "none" }}>
      <div style={{
        border: `1px solid ${highlight ? "var(--alarm)" : "var(--line)"}`,
        borderLeft: `3px solid ${highlight ? "var(--alarm)" : "var(--line-strong)"}`,
        borderRadius: 2, padding: "16px 20px", marginBottom: 10, cursor: "pointer",
        background: highlight ? "var(--alarm-soft)" : "transparent",
      }}>
        <div className="flex justify-between items-center gap-3 flex-wrap">
          <span className={`${ibmPlexMono.className}`} style={{ fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {p.sourceType === "meta" ? "Sistémica" : (p.threadTitle ?? `Teatro ${p.threadId}`)}
          </span>
          <span style={{ display: "inline-block", padding: "2px 8px", border: "1px solid", borderRadius: 2, fontSize: 9.5, letterSpacing: ".12em", fontWeight: 600, ...parseCss(badge.cls) }}>
            {badge.label}
          </span>
        </div>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.5, color: "var(--fg-strong)", fontWeight: 500, textWrap: "pretty" }}>{p.statement}</p>
        <div className={`${ibmPlexMono.className}`} style={{ marginTop: 8, fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--faint)" }}>
          {p.reviewDate ? `Revisión: ${p.reviewDate}` : "Sin fecha de revisión"} {p.resolvedAt ? ` · Resuelta: ${p.resolvedAt.slice(0, 10)}` : ""}
        </div>
      </div>
    </Link>
  );
}

function TrackRecord({ stats }: { stats: Stats }) {
  const resolved = stats.confirmed + stats.falsified + stats.unverifiable;
  const confirmedPct = resolved ? Math.round((stats.confirmed / resolved) * 100) : 0;
  const falsifiedPct = resolved ? Math.round((stats.falsified / resolved) * 100) : 0;

  return (
    <div>
      {/* Resumen numérico */}
      <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 2, overflow: "hidden", marginBottom: 20 }}>
        <StatCell label="Total" value={stats.total} />
        <StatCell label="Confirmadas" value={stats.confirmed} color="var(--confirm)" />
        <StatCell label="Falsadas" value={stats.falsified} color="var(--falsify)" />
        <StatCell label="Inverificables" value={stats.unverifiable} color="var(--faint)" />
        <StatCell label="Pendientes" value={stats.pending} color="var(--accent)" last />
      </div>

      {resolved > 0 && (
        <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 14 }}>
          Acierto sobre resueltas: <b style={{ color: "var(--confirm)" }}>{confirmedPct}%</b> confirmadas · <b style={{ color: "var(--falsify)" }}>{falsifiedPct}%</b> falsadas
        </div>
      )}

      {/* Por tipo */}
      <div style={{ marginBottom: 16 }}>
        <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>Por nivel</div>
        {Object.entries(stats.bySourceType).map(([type, s]) => (
          <div key={type} className={`${ibmPlexMono.className}`} style={{ fontSize: 12, color: "var(--fg)", marginBottom: 4 }}>
            {type === "thread" ? "Teatro" : "Sistémica"}: {s.total} totales · {s.confirmed} confirmadas · {s.falsified} falsadas · {s.unverifiable} inverificables
          </div>
        ))}
      </div>

      {/* Por teatro */}
      {stats.byThread.length > 0 && (
        <div>
          <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>Por teatro</div>
          {stats.byThread.slice(0, 12).map((t) => (
            <div key={t.threadId} className={`${ibmPlexMono.className}`} style={{ fontSize: 12, color: "var(--fg)", marginBottom: 4 }}>
              {t.threadId ? (
                <Link href={`/dashboard/${t.threadId}`} style={{ color: "var(--accent)" }}>{t.title || `#${t.threadId}`}</Link>
              ) : (
                t.title || `#${t.threadId}`
              )}: {t.total} · {t.confirmed} ✓ · {t.falsified} ✗
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, color, last }: { label: string; value: number; color?: string; last?: boolean }) {
  return (
    <div className="flex-1 text-center py-3 px-2" style={{ borderRight: last ? "none" : "1px solid var(--line)" }}>
      <div className={`${ibmPlexMono.className}`} style={{ fontSize: 22, fontWeight: 600, color: color ?? "var(--fg-strong)" }}>{value}</div>
      <div className={`${ibmPlexMono.className}`} style={{ fontSize: 8, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

function parseCss(css: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of css.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out as React.CSSProperties;
}
