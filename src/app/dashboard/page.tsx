"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";
import { BIAS_LABELS, type BiasValue } from "@/lib/sources-types";

/*
 * ============================================================================
 * DASHBOARD — Boletín de titulares con navegación a página de detalle.
 *
 * Cambios respecto a la versión anterior:
 *   - Las tarjetas YA NO se expanden. Son titulares limpios que enlazan
 *     a /dashboard/[threadId] para leer el análisis completo.
 *   - Marcar-leído está en la PÁGINA DE DETALLE (se marca automáticamente
 *     al entrar). Aquí solo mostramos el estado leído/no leído.
 *   - Se conserva: orden por score, optimistic toggleRead (si quieres
 *     marcar desde aquí), filtro "solo no leídos", filtro por fuente, temas.
 * ============================================================================
 */

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-serif",
});

// --- Tipos ---

type Thread = { id: number; title: string; description: string | null; state: string | null };

type Analysis = {
  id: number;
  threadId: number | null;
  summary: string;
  cuiBono: string;
  saidVsDone: string;
  deviation: string | null;
  prediction: string | null;
  verdict: string;
  analysisDate: string;
  createdAt: string;
  read: boolean;
};

type Perspective = { bias: string; count: number };

type DashboardRow = {
  thread: Thread;
  latestAnalysis: Analysis;
  perspectiveCoverage: {
    totalArticles: number;
    perspectives: Perspective[];
    isTriangulable: boolean;
  };
  newArticlesToday: number;
  heroImage: string | null;
};

type DashboardData = { rows: DashboardRow[]; unreadCount: number };

// --- Colores por bias ---

const BIAS_INFO: Record<string, { color: string; label: string }> = {
  greek: { color: "oklch(0.65 0.14 240)", label: "Griega" },
  turkish: { color: "oklch(0.68 0.16 20)", label: "Turca" },
  russian: { color: "oklch(0.7 0.04 140)", label: "Rusa" },
  chinese: { color: "oklch(0.72 0.12 55)", label: "China" },
  european: { color: "oklch(0.68 0.1 265)", label: "Europea" },
  western_thinktank: { color: "oklch(0.66 0.1 160)", label: "Think Tank Occ." },
  other: { color: "oklch(0.6 0.01 82)", label: "Otra" },
};

// --- Tema ---

type ThemeMode = "auto" | "light" | "dark";

function themeCSS(effective: "light" | "dark"): string {
  if (effective === "light") {
    return `
      :root {
        --page-bg: oklch(0.98 0.002 95);
        --page-bg2: oklch(0.94 0.004 95);
        --fg: oklch(0.28 0.01 90);
        --fg-strong: oklch(0.12 0.01 85);
        --muted: oklch(0.48 0.01 82);
        --faint: oklch(0.6 0.008 85);
        --line: oklch(0 0 0 / .1);
        --line-strong: oklch(0 0 0 / .18);
        --rule: oklch(0 0 0 / .55);
        --alarm: oklch(0.55 0.18 22);
        --alarm-fg: oklch(0.45 0.14 22);
        --alarm-soft: oklch(0.55 0.18 22 / .08);
        --unread: oklch(0.58 0.16 44);
        --chip-fg: oklch(0.18 0.01 85);
      }
    `;
  }
  return `
    :root {
      --page-bg: oklch(0.148 0.006 74);
      --page-bg2: oklch(0.2 0.007 76);
      --fg: oklch(0.78 0.014 84);
      --fg-strong: oklch(0.94 0.02 88);
      --muted: oklch(0.55 0.012 82);
      --faint: oklch(0.46 0.01 82);
      --line: oklch(1 0 0 / .09);
      --line-strong: oklch(1 0 0 / .22);
      --rule: oklch(0.9 0.018 88 / .46);
      --alarm: oklch(0.65 0.19 26);
      --alarm-fg: oklch(0.82 0.1 28);
      --alarm-soft: oklch(0.65 0.19 26 / .08);
      --unread: oklch(0.82 0.12 80);
      --chip-fg: oklch(0.86 0.015 88);
    }
  `;
}

// --- Helpers ---

function hasDeviation(d: string | null): boolean {
  if (!d) return false;
  const lower = d.toLowerCase();
  return !(
    lower.includes("no aplica") ||
    lower.includes("primer análisis") ||
    lower.includes("sin desviaciones") ||
    lower.includes("no hay desviación")
  );
}

function formatTimeShort(iso: string) {
  return new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function todayEs() {
  return new Date().toLocaleDateString("es-ES", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

// ============================================================================

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [activeSource, setActiveSource] = useState<BiasValue | null>(null);
  const [themePref, setThemePref] = useState<ThemeMode>("auto");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const effectiveTheme: "light" | "dark" = themePref === "auto" ? (systemDark ? "dark" : "light") : themePref;

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/dashboard");
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Optimistic toggleRead
  async function toggleRead(analysisId: number) {
    if (!data) return;
    const prevData = data;
    setData((current) => {
      if (!current) return current;
      const item = current.rows.find((r) => r.latestAnalysis.id === analysisId);
      const currentlyRead = item?.latestAnalysis.read ?? false;
      return {
        ...current,
        unreadCount: Math.max(0, current.unreadCount + (currentlyRead ? 1 : -1)),
        rows: current.rows.map((row) =>
          row.latestAnalysis.id === analysisId
            ? { ...row, latestAnalysis: { ...row.latestAnalysis, read: !currentlyRead } }
            : row
        ),
      };
    });
    try {
      const item = prevData.rows.find((r) => r.latestAnalysis.id === analysisId);
      const newRead = !item?.latestAnalysis.read;
      const res = await fetch(`/api/analyses/${analysisId}/read`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ read: newRead }) });
      if (!res.ok) throw new Error("PATCH failed");
    } catch {
      setData(prevData);
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--page-bg)" }} className="flex items-center justify-center">
        <p className={`${ibmPlexMono.className} text-xs tracking-[.18em] uppercase`} style={{ color: "var(--muted)" }}>Cargando briefing...</p>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)" }} className="flex flex-col items-center justify-center gap-3">
        <p className={`${playfair.className} text-lg`} style={{ color: "var(--muted)" }}>Sin análisis disponibles</p>
        <p className={`${ibmPlexMono.className} text-xs tracking-[.14em] uppercase`} style={{ color: "var(--faint)" }}>Ejecuta /api/analyze para generar el primer briefing</p>
      </div>
    );
  }

  let rows = showUnreadOnly ? data.rows.filter((r) => !r.latestAnalysis.read) : data.rows;
  if (activeSource) {
    rows = rows.filter((r) => r.perspectiveCoverage.perspectives.some((p) => p.bias === activeSource));
  }

  const lead = rows[0];
  const mainCards = rows.slice(1, 6);
  const railCards = rows.slice(6);
  const empty = rows.length === 0;
  const deviationCount = rows.filter((r) => hasDeviation(r.latestAnalysis.deviation)).length;

  const allBiases = Object.keys(BIAS_INFO) as BiasValue[];
  const legendItems = allBiases.map((bias) => {
    const total = data.rows
      .filter((r) => r.perspectiveCoverage.perspectives.some((p) => p.bias === bias))
      .reduce((sum, r) => sum + (r.perspectiveCoverage.perspectives.find((p) => p.bias === bias)?.count ?? 0), 0);
    const info = BIAS_INFO[bias];
    return { bias, name: info.label, color: info.color, total, isActive: activeSource === bias };
  });

  const clearSource = () => setActiveSource(null);

  const themeSegs = ([
    { key: "light" as ThemeMode, label: "Claro" },
    { key: "dark" as ThemeMode, label: "Oscuro" },
    { key: "auto" as ThemeMode, label: "Auto" },
  ]).map((t) => ({ isActive: themePref === t.key, onClick: () => setThemePref(t.key), key: t.key, label: t.label }));

  return (
    <>
      <style>{`
        @keyframes bgPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
        ${themeCSS(effectiveTheme)}
      `}</style>

      <div style={{
        minHeight: "100vh",
        background: effectiveTheme === "dark"
          ? "radial-gradient(120% 80% at 50% -10%, oklch(0.185 0.007 78) 0%, oklch(0.148 0.006 74) 55%)"
          : "var(--page-bg)",
        color: "var(--fg)", transition: "background .25s,color .25s",
        fontFamily: `${playfair.style.fontFamily}, Georgia, serif`,
      }}>
        {/* Masthead */}
        <header className="max-w-[1220px] mx-auto pt-8 md:pt-[36px] px-4 md:px-[44px]">
          <div className={`${ibmPlexMono.className} flex flex-col md:flex-row justify-between items-start md:items-center gap-1 md:gap-4 pb-[13px]`} style={{
            fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--muted)",
          }}>
            <span>Briefing diario de inteligencia</span>
            <span style={{ letterSpacing: ".16em", color: "var(--faint)" }}>Vol. VII · Ed. 194</span>
            <span style={{ color: "var(--alarm)", display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 6, height: 6, background: "var(--alarm)", transform: "rotate(45deg)" }}></span>
              Evaluación reservada
            </span>
          </div>
          <div style={{ borderTop: "2px solid var(--rule)", borderBottom: "1px solid var(--line)", padding: "22px 0 16px", textAlign: "center" }}>
            <h1 className="font-extrabold leading-[.94] tracking-[.005em]" style={{
              margin: 0, fontSize: "clamp(34px, 6.4vw, 64px)", color: "var(--fg-strong)",
            }}>BOLETÍN GEOPOLÍTICO</h1>
          </div>
          <div className={`${ibmPlexMono.className} flex flex-col md:flex-row justify-between items-start md:items-center gap-1 md:gap-4 flex-wrap`} style={{
            fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)",
            paddingTop: 10, paddingBottom: 12, borderBottom: "3px double var(--rule)",
          }}>
            <span>{todayEs()}</span>
            <span className="hidden md:inline" style={{ letterSpacing: ".24em", color: "var(--faint)" }}>Lectura estructural · sin concesiones</span>
            <span style={{ color: "var(--unread)" }}><b style={{ fontWeight: 600 }}>{data.unreadCount}</b> sin leer</span>
          </div>
        </header>

        {/* Barra de filtros */}
        <div className="max-w-[1220px] mx-auto pt-4 px-4 md:px-[44px]">
          <div className="flex items-center gap-[14px] flex-wrap pb-[15px]" style={{ borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "inline-flex", border: "1px solid var(--line-strong)", borderRadius: 3, overflow: "hidden" }}>
              {themeSegs.map((seg) => (
                <button key={seg.key} onClick={seg.onClick} className={ibmPlexMono.className} style={{
                  fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", border: "none", cursor: "pointer", padding: "5px 12px", fontWeight: 500,
                  background: seg.isActive ? "var(--line-strong)" : "transparent", color: seg.isActive ? "var(--fg-strong)" : "var(--muted)",
                }}>{seg.label}</button>
              ))}
            </div>
            <span style={{ width: 1, height: 20, background: "var(--line)" }}></span>
            <button onClick={() => setShowUnreadOnly(!showUnreadOnly)} className={ibmPlexMono.className} style={{
              display: "inline-flex", alignItems: "center", gap: 7, fontSize: 9.5, letterSpacing: ".16em",
              textTransform: "uppercase", border: "none", cursor: "pointer", borderRadius: 3, padding: "5px 12px", fontWeight: 500,
              background: showUnreadOnly ? "var(--line-strong)" : "transparent",
              color: showUnreadOnly ? "var(--unread)" : "var(--muted)",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--unread)", flex: "none" }}></span>
              Solo no leídos
            </button>
            <span style={{ width: 1, height: 20, background: "var(--line)" }}></span>
            <span className={ibmPlexMono.className} style={{ fontSize: 9.5, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)" }}>Fuentes</span>
            {legendItems.map((item) => (
              <button key={item.bias} onClick={() => setActiveSource(activeSource === item.bias ? null : item.bias)} className={ibmPlexMono.className} style={{
                display: "inline-flex", alignItems: "center", gap: 6, fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase",
                border: `1px solid ${item.isActive ? item.color : "var(--line)"}`, borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                background: item.isActive ? `${item.color} / .12` : "transparent",
                color: item.isActive ? item.color : "var(--muted)", fontWeight: 500,
              }}>
                <span style={{ width: 8, height: 8, background: item.color, borderRadius: 1, flex: "none" }}></span>
                {item.name}<span style={{ opacity: .7, fontWeight: 600 }}>{item.total}</span>
              </button>
            ))}
            {activeSource && (
              <button onClick={clearSource} className={ibmPlexMono.className} style={{
                background: "none", border: "none", cursor: "pointer", fontSize: 10, letterSpacing: ".1em",
                textTransform: "uppercase", color: "var(--alarm)", padding: "4px 6px",
              }}>✕ quitar filtro</button>
            )}
          </div>
        </div>

        {/* Contenido principal */}
        <main className="max-w-[1220px] mx-auto px-4 md:px-[44px] pb-[90px]">
          {!empty && lead ? (
            <LeadCard row={lead} onNavigate={() => router.push(`/dashboard/${lead.thread.id}`)} onToggleRead={() => toggleRead(lead.latestAnalysis.id)} />
          ) : (
            <div className={ibmPlexMono.className} style={{ padding: "70px 0", textAlign: "center", fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)" }}>
              Sin análisis para el filtro activo
            </div>
          )}

          <div className="flex flex-wrap lg:flex-nowrap gap-0 lg:gap-[52px] items-start pt-[6px]">
            <section className="flex-[2.6_1_440px] min-w-0">
              <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--faint)", padding: "22px 0 4px" }}>Análisis</div>
              {mainCards.map((row) => (
                <MainCard key={row.latestAnalysis.id} row={row} onNavigate={() => router.push(`/dashboard/${row.thread.id}`)} onToggleRead={() => toggleRead(row.latestAnalysis.id)} />
              ))}
              {mainCards.length === 0 && lead && (
                <div className={ibmPlexMono.className} style={{ padding: "18px 0", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>Sin más teatros</div>
              )}
            </section>

            <aside className="flex-[1_1_270px] min-w-0 mt-4 lg:mt-0">
              <div style={{ borderTop: "2px solid var(--rule)", marginTop: 22, paddingTop: 14 }}>
                <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 12 }}>Índice del briefing</div>
                <div className="flex border rounded-sm overflow-hidden" style={{ borderColor: "var(--line)" }}>
                  <IndexBox label="Señales" value={data.rows.length} color="var(--fg-strong)" />
                  <IndexBox label="Desviac." value={deviationCount} color="var(--alarm)" />
                  <IndexBox label="Sin leer" value={data.unreadCount} color="var(--unread)" last />
                </div>
              </div>
              <div style={{ marginTop: 26 }}>
                <div className={`${ibmPlexMono.className} flex items-center gap-2 pb-[10px]`} style={{ fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--faint)", borderBottom: "1px solid var(--line-strong)" }}>
                  <span style={{ width: 6, height: 6, background: "var(--unread)", borderRadius: "50%" }}></span>Radar de señales
                </div>
                {railCards.map((row) => (
                  <RailCard key={row.latestAnalysis.id} row={row} onNavigate={() => router.push(`/dashboard/${row.thread.id}`)} onToggleRead={() => toggleRead(row.latestAnalysis.id)} />
                ))}
                {railCards.length === 0 && (
                  <div className={ibmPlexMono.className} style={{ padding: "22px 0", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>Sin señales secundarias</div>
                )}
              </div>
            </aside>
          </div>

          <footer className={`${ibmPlexMono.className} flex justify-between items-center flex-wrap gap-[10px]`} style={{
            marginTop: 40, paddingTop: 16, borderTop: "1px solid var(--line)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)",
          }}>
            <span>Fin del briefing</span>
            <span>Fuente única · no redistribuir</span>
          </footer>
        </main>
      </div>
    </>
  );
}

// --- Subcomponentes ---

function IndexBox({ label, value, color, last }: { label: string; value: number; color: string; last?: boolean }) {
  return (
    <div className="flex-1 text-center py-3 px-4" style={{ borderRight: last ? "none" : "1px solid var(--line)" }}>
      <div className={ibmPlexMono.className} style={{ fontSize: 24, fontWeight: 600, color }}>{value}</div>
      <div className={ibmPlexMono.className} style={{ fontSize: "8.5px", letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

// --- Lead Card (portada — clic navega a detalle) ---

function LeadCard({ row, onNavigate, onToggleRead }: { row: DashboardRow; onNavigate: () => void; onToggleRead: () => void }) {
  const a = row.latestAnalysis;
  const dev = hasDeviation(a.deviation);
  const read = a.read;
  const badges = row.perspectiveCoverage.perspectives.map((p) => {
    const info = BIAS_INFO[p.bias] ?? BIAS_INFO.other;
    return { name: info.label, color: info.color, count: p.count, bias: p.bias };
  });

  return (
    <article style={{ padding: "34px 0 32px", borderBottom: "1px solid var(--line)", position: "relative" }}>
      <div style={{ position: "absolute", top: 34, left: -44, width: 3, height: 36, background: "var(--alarm)" }} className="hidden md:block"></div>
      <div style={{ opacity: read ? 0.5 : 1 }}>
        <div onClick={onNavigate} style={{ cursor: "pointer" }}>
          <div className={`${ibmPlexMono.className} flex items-center gap-3`} style={{ fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 14 }}>
            <span style={{ color: "var(--alarm)", fontWeight: 600 }}>Portada</span>
            <span style={{ width: 14, height: 1, background: "var(--line-strong)" }}></span>
            <span className="truncate">{row.thread.title}</span>
            {dev && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--alarm)", letterSpacing: ".14em", flex: "none" }}>▲ Desviación</span>}
            {!read && <span className="ml-auto w-2 h-2 rounded-full flex-none" style={{ background: "var(--unread)", animation: "bgPulse 2.4s ease-in-out infinite" }}></span>}
            {read && <span className="ml-auto flex-none" style={{ letterSpacing: ".16em", color: "var(--faint)" }}>Leído</span>}
          </div>
          <div className="flex items-start justify-between gap-4">
            <h2 className="font-semibold leading-[1.28] tracking-[-.006em] max-w-[24ch] flex-1 min-w-0" style={{
              margin: 0, fontSize: "clamp(25px, 3.1vw, 33px)", color: "var(--fg-strong)", textWrap: "pretty",
            }}>{a.verdict}</h2>
            {row.heroImage && (
              <img
                src={row.heroImage}
                alt=""
                loading="lazy"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                className="w-24 h-16 md:w-32 md:h-20 object-cover rounded-sm flex-none mt-1"
                style={{ border: "1px solid var(--line)" }}
              />
            )}
          </div>
        </div>

        {/* Footer: badges + toggle read + hora */}
        <div className="flex justify-between items-end gap-[18px] mt-5 flex-wrap">
          <div className="flex flex-wrap gap-[6px]">
            {badges.map((b) => (
              <span key={b.bias} className={`${ibmPlexMono.className} inline-flex items-center gap-[6px] px-2 py-[3px] border rounded-sm whitespace-nowrap`} style={{
                fontSize: 10, fontWeight: 500, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--chip-fg)",
                borderColor: `${b.color} / .35`, background: `${b.color} / .12`,
              }}>
                <span style={{ width: 6, height: 6, background: b.color, borderRadius: 1, flex: "none" }}></span>
                {b.name}<span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
              </span>
            ))}
            {row.newArticlesToday > 0 && (
              <span className={ibmPlexMono.className} style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 2, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--unread)", background: "var(--line-strong)" }}>+{row.newArticlesToday} hoy</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={(e) => { e.stopPropagation(); onToggleRead(); }} className={ibmPlexMono.className} style={{
              fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer",
              border: `1px solid ${read ? "var(--line)" : "var(--unread)"}`, borderRadius: 3, padding: "3px 10px",
              background: "transparent", color: read ? "var(--muted)" : "var(--unread)",
            }}>{read ? "Leído" : "Marcar leído"}</button>
            <span className={ibmPlexMono.className} style={{ fontSize: 11, letterSpacing: ".06em", color: "var(--muted)", whiteSpace: "nowrap" }}>{formatTimeShort(a.analysisDate)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

// --- Main Card (columna "Análisis" — clic navega a detalle) ---

function MainCard({ row, onNavigate, onToggleRead }: { row: DashboardRow; onNavigate: () => void; onToggleRead: () => void }) {
  const a = row.latestAnalysis;
  const dev = hasDeviation(a.deviation);
  const read = a.read;
  const badges = row.perspectiveCoverage.perspectives.map((p) => {
    const info = BIAS_INFO[p.bias] ?? BIAS_INFO.other;
    return { name: info.label, color: info.color, count: p.count, bias: p.bias };
  });

  return (
    <article style={{ borderTop: "1px solid var(--line)", padding: "22px 0" }}>
      <div style={{ opacity: read ? 0.5 : 1 }}>
        <div onClick={onNavigate} style={{ cursor: "pointer" }}>
          <div className={`${ibmPlexMono.className} flex items-center gap-[10px]`} style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>
            <span className="truncate">{row.thread.title}</span>
            {dev && <span style={{ color: "var(--alarm)", flex: "none" }}>▲</span>}
            {!read && <span className="ml-auto w-[7px] h-[7px] rounded-full flex-none" style={{ background: "var(--unread)", animation: "bgPulse 2.4s ease-in-out infinite" }}></span>}
            {read && <span className="ml-auto flex-none" style={{ letterSpacing: ".16em", color: "var(--faint)" }}>Leído</span>}
          </div>
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold leading-[1.32] tracking-[-.004em] flex-1 min-w-0" style={{
              margin: 0, fontSize: 22, color: "var(--fg-strong)", textWrap: "pretty",
            }}>{a.verdict}</h3>
            {row.heroImage && (
              <img
                src={row.heroImage}
                alt=""
                loading="lazy"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                className="w-16 h-11 object-cover rounded-sm flex-none mt-0.5"
                style={{ border: "1px solid var(--line)" }}
              />
            )}
          </div>
        </div>

        <div className="flex justify-between items-end gap-[14px] mt-[14px] flex-wrap">
          <div className="flex flex-wrap gap-[5px]">
            {badges.slice(0, 3).map((b) => (
              <span key={b.bias} className={`${ibmPlexMono.className} inline-flex items-center gap-[5px] px-[7px] py-[2px] border rounded-sm whitespace-nowrap`} style={{
                fontSize: 9.5, fontWeight: 500, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--chip-fg)",
                borderColor: `${b.color} / .3`, background: `${b.color} / .1`,
              }}>
                <span style={{ width: 5, height: 5, background: b.color, borderRadius: 1, flex: "none" }}></span>
                {b.name}<span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
              </span>
            ))}
            {badges.length > 3 && <span className={ibmPlexMono.className} style={{ fontSize: 9, color: "var(--faint)", alignSelf: "center" }}>+{badges.length - 3}</span>}
            {row.newArticlesToday > 0 && (
              <span className={ibmPlexMono.className} style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: 2, fontSize: 9.5, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--unread)", background: "var(--line-strong)" }}>+{row.newArticlesToday} hoy</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={(e) => { e.stopPropagation(); onToggleRead(); }} className={ibmPlexMono.className} style={{
              fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", cursor: "pointer",
              border: `1px solid ${read ? "var(--line)" : "var(--unread)"}`, borderRadius: 3, padding: "2px 8px",
              background: "transparent", color: read ? "var(--muted)" : "var(--unread)",
            }}>{read ? "Leído" : "Marcar leído"}</button>
            <span className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".05em", color: "var(--muted)", whiteSpace: "nowrap" }}>{formatTimeShort(a.analysisDate)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

// --- Rail Card (sidebar — clic navega a detalle) ---

function RailCard({ row, onNavigate, onToggleRead }: { row: DashboardRow; onNavigate: () => void; onToggleRead: () => void }) {
  const a = row.latestAnalysis;
  const dev = hasDeviation(a.deviation);
  const read = a.read;
  const badges = row.perspectiveCoverage.perspectives.slice(0, 3).map((p) => {
    const info = BIAS_INFO[p.bias] ?? BIAS_INFO.other;
    return { name: info.label, color: info.color, count: p.count, bias: p.bias };
  });
  const moreBadges = row.perspectiveCoverage.perspectives.length - 3;

  return (
    <article style={{ borderBottom: "1px solid var(--line)", padding: "15px 0" }}>
      <div style={{ opacity: read ? 0.5 : 1 }}>
        <div onClick={onNavigate} style={{ cursor: "pointer" }}>
          <div className={`${ibmPlexMono.className} flex items-center gap-2`} style={{ fontSize: 9, letterSpacing: ".13em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 7 }}>
            <span className="truncate">{row.thread.title}</span>
            {dev && <span style={{ color: "var(--alarm)", flex: "none" }}>▲</span>}
            {!read && <span className="ml-auto w-[6px] h-[6px] rounded-full flex-none" style={{ background: "var(--unread)" }}></span>}
            {read && <span className="ml-auto flex-none" style={{ letterSpacing: ".14em", color: "var(--faint)" }}>✓</span>}
          </div>
          <div className="flex items-start justify-between gap-3">
            <h4 className="font-medium leading-[1.36] tracking-[-.002em] flex-1 min-w-0" style={{
              margin: 0, fontSize: "15.5px", color: "var(--fg-strong)", textWrap: "pretty",
            }}>{a.verdict}</h4>
            {row.heroImage && (
              <img
                src={row.heroImage}
                alt=""
                loading="lazy"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                className="w-12 h-9 object-cover rounded-sm flex-none"
                style={{ border: "1px solid var(--line)" }}
              />
            )}
          </div>
        </div>

        <div className="flex justify-between items-center gap-[10px] mt-[10px]">
          <div className="flex flex-wrap gap-1">
            {badges.map((b) => (
              <span key={b.bias} className={`${ibmPlexMono.className} inline-flex items-center gap-1 px-[6px] py-[2px] border rounded-sm whitespace-nowrap`} style={{
                fontSize: 9, fontWeight: 500, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--chip-fg)",
                borderColor: `${b.color} / .25`, background: `${b.color} / .08`,
              }}>
                <span style={{ width: 5, height: 5, background: b.color, borderRadius: 1, flex: "none" }}></span>
                {b.name}<span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
              </span>
            ))}
            {moreBadges > 0 && <span className={ibmPlexMono.className} style={{ fontSize: 9, color: "var(--faint)", alignSelf: "center" }}>+{moreBadges}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={(e) => { e.stopPropagation(); onToggleRead(); }} className={ibmPlexMono.className} style={{
              fontSize: 8.5, letterSpacing: ".06em", textTransform: "uppercase", cursor: "pointer",
              border: `1px solid ${read ? "var(--line)" : "var(--unread)"}`, borderRadius: 3, padding: "1px 6px",
              background: "transparent", color: read ? "var(--muted)" : "var(--unread)",
            }}>{read ? "✓" : "Leer"}</button>
            <span className={ibmPlexMono.className} style={{ fontSize: 9, letterSpacing: ".04em", color: "var(--faint)", whiteSpace: "nowrap" }}>{formatTimeShort(a.analysisDate)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
