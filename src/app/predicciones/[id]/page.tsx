"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";

/*
 * /predicciones/[id] — Detalle de una predicción.
 *
 * El statement como titular editorial, la condición, la falsación, las fechas,
 * el status, y si está resuelta: la resolución y los artículos de evidencia.
 */

const ibmPlexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["600", "700", "800"] });

type Prediction = {
  id: number;
  sourceType: "thread" | "meta";
  sourceId: number;
  threadId: number | null;
  statement: string;
  condition: string | null;
  falsificationCondition: string | null;
  reviewDate: string | null;
  status: "pending" | "confirmed" | "falsified" | "unverifiable";
  confidence: "alta" | "media" | "baja" | null;
  rebuttal: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  evidenceArticleIds: string | null;
  createdAt: string;
};

type Thread = { id: number; title: string };
type Analysis = { id: number; verdict: string; analysisDate: string };
type Meta = { id: number; verdict: string; periodEnd: string };
type EvidenceArticle = { id: number; title: string; url: string | null; sourceName: string | null };

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

const STATUS_META: Record<string, { label: string; color: string; soft: string }> = {
  confirmed: { label: "CONFIRMADA", color: "var(--confirm)", soft: "var(--confirm-soft)" },
  falsified: { label: "FALSADA", color: "var(--falsify)", soft: "var(--falsify-soft)" },
  unverifiable: { label: "INVERIFICABLE", color: "var(--faint)", soft: "transparent" },
  pending: { label: "EN CURSO", color: "var(--muted)", soft: "transparent" },
};

export default function PredictionDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<{ prediction: Prediction; thread: Thread | null; sourceAnalysis: Analysis | null; sourceMeta: Meta | null; evidenceArticles: EvidenceArticle[] } | null>(null);
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
        const res = await fetch(`/api/predictions/${id}`);
        const json = await res.json();
        if (res.ok) setData(json);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

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
        <div className="max-w-[820px] mx-auto pt-[26px] px-4 md:px-8">
          <div className="flex justify-between items-center gap-4 flex-wrap pb-[18px]" style={{ borderBottom: "1px solid var(--line)" }}>
            <Link href="/predicciones" className={`${ibmPlexMono.className} inline-flex items-center gap-[9px]`} style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)" }}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>←</span>Volver a predicciones
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

        <main className="max-w-[820px] mx-auto px-4 md:px-8 pb-[110px]">
          {loading ? (
            <div className={`${ibmPlexMono.className} text-xs tracking-[.18em] uppercase`} style={{ color: "var(--muted)", padding: "60px 0", textAlign: "center" }}>Cargando predicción...</div>
          ) : !data ? (
            <div className={`${ibmPlexMono.className} text-xs uppercase tracking-[.2em]`} style={{ color: "var(--muted)", padding: "60px 0", textAlign: "center" }}>Predicción no encontrada</div>
          ) : (
            <article style={{ paddingTop: 44 }}>
              {(() => {
                const p = data.prediction;
                const sm = STATUS_META[p.status];
                return (
                  <>
                    {/* Antetítulo + status */}
                    <div className={`${ibmPlexMono.className} flex items-center gap-3 flex-wrap`} style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--muted)" }}>
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>{p.sourceType === "meta" ? "◆ Predicción sistémica" : "◆ Predicción de teatro"}</span>
                      <span style={{ width: 16, height: 1, background: "var(--line-strong)" }}></span>
                      <span style={{ display: "inline-block", padding: "2px 8px", border: "1px solid", borderRadius: 2, fontSize: 9.5, letterSpacing: ".12em", fontWeight: 600, color: sm.color, borderColor: sm.color, background: sm.soft }}>{sm.label}</span>
                      {p.confidence && (
                        <span style={{ display: "inline-block", padding: "2px 8px", border: "1px solid var(--line-strong)", borderRadius: 2, fontSize: 9.5, letterSpacing: ".12em", fontWeight: 600, color: "var(--muted)" }}>
                          Confianza {p.confidence}
                        </span>
                      )}
                    </div>

                    {/* Statement como titular */}
                    <h1 className="font-bold" style={{ margin: "22px 0 0", fontSize: "clamp(26px, 4.2vw, 40px)", lineHeight: 1.2, letterSpacing: "-.01em", color: "var(--fg-strong)", textWrap: "pretty" }}>
                      {p.statement}
                    </h1>
                    <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)", marginTop: 14 }}>Predicción del analista</div>

                    {/* Fechas */}
                    <div className={`${ibmPlexMono.className} flex items-center gap-4 flex-wrap`} style={{ fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)", marginTop: 16 }}>
                      <span>Creada: {new Date(p.createdAt).toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" })}</span>
                      <span>·</span>
                      <span>Revisión: {p.reviewDate ? new Date(p.reviewDate).toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" }) : "sin fecha"}</span>
                      {p.reviewDate && p.status === "pending" && (
                        <>
                          <span>·</span>
                          <span style={{ color: "var(--accent)" }}>{Math.max(0, Math.ceil((new Date(p.reviewDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))} días restantes</span>
                        </>
                      )}
                    </div>

                    {/* Condición y falsación */}
                    <div style={{ marginTop: 30, display: "flex", flexDirection: "column", gap: 14 }}>
                      {p.condition && (
                        <InfoBox label="Condición que la dispara">{p.condition}</InfoBox>
                      )}
                      {p.falsificationCondition && (
                        <InfoBox label="Se falsaría si" accent="var(--alarm)">{p.falsificationCondition}</InfoBox>
                      )}
                    </div>

                    {/* Resolución si está resuelta */}
                    {p.status !== "pending" && (
                      <div style={{ marginTop: 34 }}>
                        <div className="flex items-center gap-[14px] mb-3">
                          <span className={`${ibmPlexMono.className}`} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--fg-strong)", fontWeight: 600 }}>Resolución</span>
                          <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
                        </div>
                        <div style={{ padding: "18px 22px", border: "1px solid var(--line)", borderLeft: `3px solid ${sm.color}`, background: sm.soft }}>
                          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6, color: "var(--fg)" }}>{p.resolution ?? "Sin resolución registrada."}</p>
                          {p.resolvedAt && (
                            <div className={`${ibmPlexMono.className}`} style={{ marginTop: 10, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>Resuelta: {p.resolvedAt.slice(0, 10)}</div>
                          )}
                        </div>

                        {/* Evidencia */}
                        {data.evidenceArticles.length > 0 && (
                          <div style={{ marginTop: 22 }}>
                            <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 12 }}>Evidencia ({data.evidenceArticles.length} artículos)</div>
                            <div className="flex flex-col gap-2">
                              {data.evidenceArticles.map((a) => (
                                <a key={a.id} href={a.url ?? "#"} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 px-4 py-3 border rounded-sm transition-colors hover:opacity-80" style={{ borderColor: "var(--line)", textDecoration: "none" }}>
                                  <span style={{ fontSize: 14, color: "var(--fg)" }}>{a.title}</span>
                                  <span className={`${ibmPlexMono.className} text-[11px] flex-none`} style={{ color: "var(--faint)" }}>{a.sourceName ?? ""} ↗</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* REFUTACIÓN — el analista escéptico habla */}
                    {p.rebuttal && (
                      <div style={{ marginTop: 40 }}>
                        <div className="flex items-center gap-[14px] mb-3">
                          <span className={`${ibmPlexMono.className}`} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--alarm)", fontWeight: 600 }}>Refutación</span>
                          <span className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>Contra-argumento que sobrevivió</span>
                          <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
                        </div>
                        <div style={{ border: "1px solid var(--alarm)", borderLeft: "3px solid var(--alarm)", background: "var(--alarm-soft)", padding: "20px 24px" }}>
                          <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--alarm)", fontWeight: 600, marginBottom: 8 }}>El analista escéptico</div>
                          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--fg)" }}>{p.rebuttal}</p>
                        </div>
                      </div>
                    )}

                    {/* Contexto de origen */}
                    <div style={{ marginTop: 36, paddingTop: 20, borderTop: "1px solid var(--line)" }}>
                      <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 14 }}>Contexto de origen</div>
                      {data.thread && (
                        <Link href={`/dashboard/${data.thread.id}`} className={`${ibmPlexMono.className} inline-flex items-center gap-2`} style={{ fontSize: 12, color: "var(--accent)" }}>
                          Teatro: {data.thread.title} →
                        </Link>
                      )}
                      {data.sourceAnalysis && (
                        <div className={`${ibmPlexMono.className}`} style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                          Análisis #{data.sourceAnalysis.id} ({new Date(data.sourceAnalysis.analysisDate).toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" })})
                          <div style={{ marginTop: 4, color: "var(--fg)", fontSize: 13, fontStyle: "italic" }}>{data.sourceAnalysis.verdict}</div>
                        </div>
                      )}
                      {data.sourceMeta && (
                        <div className={`${ibmPlexMono.className}`} style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                          Meta-análisis #{data.sourceMeta.id}
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </article>
          )}
        </main>
      </div>
    </>
  );
}

function InfoBox({ label, children, accent }: { label: string; children: string; accent?: string }) {
  return (
    <div style={{ padding: "14px 18px", border: "1px solid var(--line)", borderLeft: `3px solid ${accent ?? "var(--accent)"}` }}>
      <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: accent ?? "var(--accent)", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "var(--fg)" }}>{children}</p>
    </div>
  );
}
