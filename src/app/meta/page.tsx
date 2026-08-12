"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";

/*
 * /meta — El editorial de portada: la lectura GLOBAL del tablero.
 *
 * No es un análisis de un teatro: es lo que el CONJUNTO revela que ningún
 * teatro revela por separado. Por eso tiene más peso tipográfico que los
 * análisis individuales (título mayor, secciones con nombre de sección
 * editorial, veredicto destacado).
 */

const ibmPlexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["600", "700", "800"] });

type MetaAnalysis = {
  id: number;
  periodStart: string;
  periodEnd: string;
  systemReading: string;
  blocFormation: string;
  crossPatterns: string;
  contradictions: string;
  predictionStatement: string;
  predictionCondition: string;
  predictionFalsification: string;
  predictionReviewDate: string | null;
  verdict: string;
  threadIds: string;
  createdAt: string;
  read: boolean;
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
        --unread: oklch(0.58 0.16 44);
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
      --unread: oklch(0.82 0.12 80);
      --accent: oklch(0.72 0.1 250);
    }
  `;
}

export default function MetaPage() {
  const [meta, setMeta] = useState<MetaAnalysis | null>(null);
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
        const res = await fetch("/api/meta");
        const json = await res.json();
        setMeta(json.meta ?? null);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const themeSegs = ([
    { key: "light" as ThemeMode, label: "Claro" },
    { key: "dark" as ThemeMode, label: "Oscuro" },
    { key: "auto" as ThemeMode, label: "Auto" },
  ]).map((t) => ({ isActive: themePref === t.key, onClick: () => setThemePref(t.key), key: t.key, label: t.label }));

  return (
    <>
      <style>{`${themeCSS(effectiveTheme)}`}</style>
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)", transition: "background .25s,color .25s", fontFamily: `${playfair.style.fontFamily}, Georgia, serif` }}>

        {/* Nav */}
        <div className="max-w-[860px] mx-auto pt-[26px] px-4 md:px-8">
          <div className="flex justify-between items-center gap-4 flex-wrap pb-[18px]" style={{ borderBottom: "1px solid var(--line)" }}>
            <Link href="/dashboard" className={`${ibmPlexMono.className} inline-flex items-center gap-[9px]`} style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)" }}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>←</span>Volver al boletín
            </Link>
            <div style={{ display: "inline-flex", border: "1px solid var(--line-strong)", borderRadius: 3, overflow: "hidden" }}>
              {themeSegs.map((seg) => (
                <button key={seg.key} onClick={seg.onClick} className={ibmPlexMono.className} style={{
                  fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", border: "none", cursor: "pointer", padding: "5px 12px", fontWeight: 500,
                  background: seg.isActive ? "var(--line-strong)" : "transparent", color: seg.isActive ? "var(--fg-strong)" : "var(--muted)",
                }}>{seg.label}</button>
              ))}
            </div>
          </div>
        </div>

        <main className="max-w-[860px] mx-auto px-4 md:px-8 pb-[120px]">
          {loading ? (
            <div className={`${ibmPlexMono.className} text-xs tracking-[.18em] uppercase`} style={{ color: "var(--muted)", padding: "60px 0", textAlign: "center" }}>
              Cargando lectura global...
            </div>
          ) : !meta ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <p className={`${ibmPlexMono.className} text-xs uppercase tracking-[.2em]`} style={{ color: "var(--muted)" }}>Aún no hay lectura global</p>
              <p style={{ color: "var(--faint)", marginTop: 12 }}>Ejecuta el meta-análisis (POST /api/meta) para generar el primer editorial.</p>
            </div>
          ) : (
            <article style={{ paddingTop: 48 }}>
              {/* Antetítulo editorial */}
              <div className={`${ibmPlexMono.className} flex items-center gap-3 flex-wrap`} style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--accent)" }}>
                <span style={{ fontWeight: 600 }}>◆ Editorial de portada</span>
                <span style={{ width: 16, height: 1, background: "var(--line-strong)" }}></span>
                <span style={{ color: "var(--muted)" }}>Lectura estructural del tablero</span>
              </div>

              {/* Título + veredicto (peso tipográfico máximo) */}
              <h1 className="font-extrabold" style={{ margin: "20px 0 0", fontSize: "clamp(32px, 5.4vw, 56px)", lineHeight: 1.08, letterSpacing: "-.015em", color: "var(--fg-strong)", textWrap: "pretty" }}>
                {meta.verdict}
              </h1>
              <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)", marginTop: 14 }}>
                Veredicto del analista jefe
              </div>

              {/* Fecha del período */}
              <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)", marginTop: 10 }}>
                {new Date(meta.periodStart).toLocaleDateString("es-ES", { day: "numeric", month: "long" })} — {new Date(meta.periodEnd).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })}
              </div>

              {/* Lectura del sistema */}
              <MetaSection title="Lectura del tablero" mt={44}>{meta.systemReading}</MetaSection>

              {/* Formación de bloques */}
              <MetaSection title="Formación de bloques" mt={40}>{meta.blocFormation}</MetaSection>

              {/* Patrones transversales */}
              <MetaSection title="Patrones transversales" mt={40}>{meta.crossPatterns}</MetaSection>

              {/* Contradicciones */}
              <MetaSection title="Contradicciones" mt={40}>{meta.contradictions}</MetaSection>

              {/* Predicción sistémica */}
              <div style={{ marginTop: 48 }}>
                <div style={{ border: "1px solid var(--line-strong)", borderLeft: "3px solid var(--accent)", padding: "26px 28px", background: "var(--page-bg)" }}>
                  <div className="flex justify-between items-center gap-3 flex-wrap">
                    <span className={`${ibmPlexMono.className}`} style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>◆ Predicción sistémica</span>
                    <span className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>
                      Revisión: {meta.predictionReviewDate ? new Date(meta.predictionReviewDate).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }) : "sin fecha válida"}
                    </span>
                  </div>
                  <p style={{ margin: "16px 0 0", fontSize: 19, lineHeight: 1.55, color: "var(--fg-strong)", fontWeight: 500, textWrap: "pretty" }}>{meta.predictionStatement}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 0, marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                    <div className="flex-1 min-w-[180px]">
                      <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)" }}>Condición</div>
                      <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--fg)", marginTop: 5 }}>{meta.predictionCondition}</div>
                    </div>
                    <div className="flex-1 min-w-[180px]">
                      <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--alarm)" }}>Se falsaría si</div>
                      <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--fg)", marginTop: 5 }}>{meta.predictionFalsification}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer del editorial */}
              <footer className={`${ibmPlexMono.className} flex justify-between items-center flex-wrap gap-[10px]`} style={{
                marginTop: 48, paddingTop: 18, borderTop: "1px solid var(--line)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)",
              }}>
                <Link href="/dashboard" style={{ color: "var(--muted)" }}>← Volver al boletín</Link>
                <span>Fuente única · no redistribuir</span>
              </footer>
            </article>
          )}
        </main>
      </div>
    </>
  );
}

function MetaSection({ title, mt, children }: { title: string; mt: number; children: string }) {
  const paragraphs = children.split("\n").filter((p) => p.trim());
  return (
    <section style={{ marginTop: mt }}>
      <div className="flex items-center gap-[14px] mb-4">
        <span className={`${ibmPlexMono.className}`} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--fg-strong)", fontWeight: 600 }}>{title}</span>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
      </div>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ margin: "0 0 18px", fontSize: 18, lineHeight: 1.75, color: "var(--fg)", maxWidth: "68ch" }}>{p}</p>
      ))}
    </section>
  );
}
