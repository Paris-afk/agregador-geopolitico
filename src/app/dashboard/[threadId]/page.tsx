"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";
import { BIAS_LABELS, type BiasValue } from "@/lib/sources-types";

/*
 * /dashboard/[threadId] — Página de lectura dedicada para un teatro.
 *
 * Datos: GET /api/threads/[threadId]
 * Marcar leído: PATCH /api/analyses/[id]/read (optimistic, igual que el dashboard)
 * Temas: mismo sistema de 3 temas (claro/oscuro/auto) que el dashboard
 *
 * Dónde está el marcar-leído:
 *   Lo puse en esta página de detalle (no en el dashboard), porque aquí es
 *   donde el usuario realmente LEE el análisis. En el dashboard solo se ven
 *   titulares; marcar como leído desde ahí sin haber leído el contenido
 *   completo reduce la utilidad del contador de pendientes. Al entrar a la
 *   página de detalle, el análisis se marca como leído automáticamente.
 */

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono",
});
const playfair = Playfair_Display({
  subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-serif",
});

// --- Colores por bias ---
const BIAS_INFO: Record<string, { color: string }> = {
  greek: { color: "oklch(0.65 0.14 240)" },
  turkish: { color: "oklch(0.68 0.16 20)" },
  russian: { color: "oklch(0.7 0.04 140)" },
  chinese: { color: "oklch(0.72 0.12 55)" },
  european: { color: "oklch(0.68 0.1 265)" },
  western_thinktank: { color: "oklch(0.66 0.1 160)" },
  other: { color: "oklch(0.6 0.01 82)" },
};

// --- CSS vars por tema (mismo sistema que dashboard) ---
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
        --unread-soft: oklch(0.58 0.16 44 / .06);
        --chip-fg: oklch(0.18 0.01 85);
        --surface: oklch(0.99 0.001 95);
        --surface-2: oklch(0.95 0.002 95);
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
      --unread-soft: oklch(0.82 0.12 80 / .06);
      --chip-fg: oklch(0.86 0.015 88);
      --surface: oklch(0.148 0.006 74);
      --surface-2: oklch(0.18 0.006 76);
    }
  `;
}

function hasDeviation(d: string | null): boolean {
  if (!d) return false;
  const l = d.toLowerCase();
  return !(l.includes("no aplica") || l.includes("primer análisis") || l.includes("sin desviaciones") || l.includes("no hay desviación"));
}

// --- Tipos de datos ---
type ThreadData = {
  thread: { id: number; title: string; description: string | null; state: string | null };
  latestAnalysis: {
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
  perspectiveCoverage: { totalArticles: number; perspectives: { bias: string; count: number }[]; isTriangulable: boolean };
  articleCount: number;
  articles: Array<{
    id: number;
    title: string;
    url: string;
    imageUrl: string | null;
    sourceName: string;
    bias: string;
  }>;
};

export default function ThreadDetailPage() {
  const params = useParams();
  const threadId = params.threadId as string;
  const [data, setData] = useState<ThreadData | null>(null);
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
        const res = await fetch(`/api/threads/${threadId}`);
        const json = await res.json();
        if (res.ok) setData(json);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [threadId]);

  // Marcar leído automáticamente al entrar
  useEffect(() => {
    if (!data || data.latestAnalysis.read) return;
    const id = data.latestAnalysis.id;
    fetch(`/api/analyses/${id}/read`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ read: true }) })
      .then(() => setData((prev) => prev ? { ...prev, latestAnalysis: { ...prev.latestAnalysis, read: true } } : prev))
      .catch(() => {});
  }, [data?.latestAnalysis.id]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)" }} className="flex items-center justify-center">
        <p className={`${ibmPlexMono.className} text-xs tracking-[.18em] uppercase`} style={{ color: "var(--muted)" }}>Cargando análisis...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)" }} className="flex flex-col items-center justify-center gap-4">
        <p className={`${playfair.className} text-lg`} style={{ color: "var(--muted)" }}>Teatro no encontrado</p>
        <Link href="/dashboard" className={`${ibmPlexMono.className} text-xs tracking-[.12em] uppercase`} style={{ color: "var(--unread)" }}>← Volver al boletín</Link>
      </div>
    );
  }

  const { thread, latestAnalysis: a, perspectiveCoverage: cov, articleCount } = data;
  const dev = hasDeviation(a.deviation);
  const themeSegs = ([
    { key: "light" as ThemeMode, label: "Claro" },
    { key: "dark" as ThemeMode, label: "Oscuro" },
    { key: "auto" as ThemeMode, label: "Auto" },
  ]).map((t) => ({ isActive: themePref === t.key, onClick: () => setThemePref(t.key), key: t.key, label: t.label }));

  const dateStr = new Date(a.analysisDate).toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" });

  const badges = cov.perspectives.map((p) => {
    const info = BIAS_INFO[p.bias] ?? BIAS_INFO.other;
    return { name: BIAS_LABELS[p.bias as BiasValue] ?? p.bias, color: info.color, count: p.count, bias: p.bias };
  });

  /*
   * Imagen destacada: la del artículo más reciente que tenga imageUrl.
   * Se muestra como hero arriba de la página.
   */
  const heroImage = data.articles.find((ar) => ar.imageUrl)?.imageUrl ?? null;

  return (
    <>
      <style>{`${themeCSS(effectiveTheme)}`}</style>
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)", transition: "background .25s,color .25s", fontFamily: `${playfair.style.fontFamily}, Georgia, serif` }}>

        {/* Nav bar */}
        <div className="max-w-[760px] mx-auto pt-[26px] px-4 md:px-8">
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

        <main className="max-w-[760px] mx-auto px-4 md:px-8 pb-[100px]">
          <article style={{ paddingTop: 40 }}>

            {/* Imagen destacada (hero) — solo si el hilo tiene un artículo con imagen */}
            {heroImage && (
              <div style={{ marginBottom: 28 }}>
                <img
                  src={heroImage}
                  alt={thread.title}
                  loading="lazy"
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                  style={{
                    width: "100%", height: "auto", maxHeight: 360, objectFit: "cover",
                    borderRadius: 3, border: "1px solid var(--line)", display: "block",
                  }}
                />
              </div>
            )}

            {/* Antetítulo + fecha */}
            <div className={`${ibmPlexMono.className} flex items-center gap-[14px] flex-wrap`} style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--muted)" }}>
              <span style={{ color: "var(--alarm)", fontWeight: 600 }}>Teatro</span>
              <span style={{ width: 16, height: 1, background: "var(--line-strong)" }}></span>
              <span style={{ color: "var(--fg)", letterSpacing: ".14em" }}>{thread.title}</span>
            </div>
            <div className={ibmPlexMono.className} style={{ fontSize: "10.5px", letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)", marginTop: 10 }}>
              {dateStr} · {articleCount} artículos analizados
            </div>

            {/* Veredicto */}
            <h1 className="font-semibold leading-[1.16] tracking-[-.012em]" style={{
              margin: "22px 0 0", fontSize: "clamp(29px, 4.6vw, 46px)", color: "var(--fg-strong)", textWrap: "pretty",
            }}>{a.verdict}</h1>
            <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--faint)", marginTop: 18 }}>Veredicto del analista</div>

            {/* Badges */}
            <div className="flex flex-wrap gap-[6px] mt-[22px]">
              {badges.map((b) => (
                <span key={b.bias} className={`${ibmPlexMono.className} inline-flex items-center gap-[6px] px-[9px] py-1 border rounded-sm whitespace-nowrap`} style={{
                  fontSize: 10, fontWeight: 500, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--chip-fg)",
                  borderColor: `${b.color} / .35`, background: `${b.color} / .12`,
                }}>
                  <span style={{ width: 6, height: 6, background: b.color, borderRadius: 1, flex: "none" }}></span>
                  {b.name}<span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
                </span>
              ))}
            </div>

            {/* Desviación */}
            {dev && a.deviation && (
              <div style={{ marginTop: 30, padding: "18px 22px", background: "var(--alarm-soft)", borderLeft: "3px solid var(--alarm)" }}>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--alarm)", fontWeight: 600 }}>▲ Desviación detectada</span>
                  <span className={ibmPlexMono.className} style={{ fontSize: 14, fontWeight: 600, color: "var(--alarm-fg)" }}>Detectada</span>
                </div>
                <p style={{ margin: "11px 0 0", fontStyle: "italic", fontSize: "16.5px", lineHeight: 1.55, color: "var(--fg)", maxWidth: "62ch" }}>{a.deviation}</p>
              </div>
            )}

            {/* Resumen */}
            <Section title="Resumen" mt={56}>{a.summary}</Section>

            {/* Cui bono */}
            <Section title="Cui bono" subtitle="Quién se beneficia" mt={52}>{a.cuiBono}</Section>

            {/* Lo dicho vs lo hecho */}
            <div style={{ marginTop: 52 }}>
              <div className="flex items-center gap-[14px] mb-5">
                <span className={ibmPlexMono.className} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--fg-strong)", fontWeight: 600 }}>Lo dicho vs lo hecho</span>
                <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
              </div>
              <div className="flex flex-col" style={{ gap: 1, background: "var(--line)", border: "1px solid var(--line)" }}>
                <div className="flex flex-wrap" style={{ background: "var(--surface-2)" }}>
                  <div className={`${ibmPlexMono.className} flex-1 min-w-[200px] py-3 px-[18px]`} style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--muted)", borderRight: "1px solid var(--line)" }}>Lo dicho</div>
                  <div className={`${ibmPlexMono.className} flex-1 min-w-[200px] py-3 px-[18px]`} style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--alarm)" }}>Lo hecho</div>
                </div>
                <div className="flex flex-wrap" style={{ background: "var(--surface)" }}>
                  <div className="flex-1 min-w-[200px] py-4 px-[18px]" style={{ fontSize: "15.5px", lineHeight: 1.55, color: "var(--fg)", borderRight: "1px solid var(--line)" }}>{a.saidVsDone}</div>
                  <div className="flex-1 min-w-[200px] py-4 px-[18px]" style={{ fontSize: "15.5px", lineHeight: 1.55, color: "var(--fg)" }}>{a.verdict}</div>
                </div>
              </div>
            </div>

            {/* Predicción */}
            {a.prediction && (
              <div style={{ marginTop: 52 }}>
                <div style={{ border: "1px solid var(--line-strong)", borderLeft: "3px solid var(--unread)", background: "var(--unread-soft)", padding: "24px 26px" }}>
                  <div className="flex justify-between items-center gap-3 flex-wrap">
                    <span className={ibmPlexMono.className} style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--unread)", fontWeight: 600 }}>◆ Predicción registrada</span>
                    <span className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>Pronóstico falsable</span>
                  </div>
                  <p style={{ margin: "16px 0 0", fontSize: 20, lineHeight: 1.5, color: "var(--fg-strong)", fontWeight: 500, maxWidth: "60ch", textWrap: "pretty" }}>{a.prediction}</p>
                  <div className="flex flex-wrap mt-[22px] pt-4" style={{ borderTop: "1px solid var(--line)" }}>
                    <div className="flex-1 min-w-[120px]">
                      <div className={ibmPlexMono.className} style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)" }}>Registrada</div>
                      <div className={ibmPlexMono.className} style={{ fontSize: 13, color: "var(--fg)", marginTop: 4 }}>{dateStr}</div>
                    </div>
                    <div className="flex-1 min-w-[120px]">
                      <div className={ibmPlexMono.className} style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)" }}>Horizonte</div>
                      <div className={ibmPlexMono.className} style={{ fontSize: 13, color: "var(--fg)", marginTop: 4 }}>Ver predicción</div>
                    </div>
                    <div className="flex-1 min-w-[120px]">
                      <div className={ibmPlexMono.className} style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)" }}>Confianza</div>
                      <div className={ibmPlexMono.className} style={{ fontSize: 13, color: "var(--unread)", marginTop: 4, fontWeight: 600 }}>Alta</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Fuentes — artículos que sustentan el análisis */}
            <div style={{ marginTop: 56 }}>
              <div className="flex items-center gap-[14px] mb-[18px]">
                <span className={ibmPlexMono.className} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--fg-strong)", fontWeight: 600 }}>Fuentes</span>
                <span className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--faint)" }}>{data.articles.length} artículos</span>
                <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
              </div>
              <div className="flex flex-col gap-2">
                {data.articles.map((ar) => {
                  const info = BIAS_INFO[ar.bias] ?? BIAS_INFO.other;
                  return (
                    <a
                      key={ar.id}
                      href={ar.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 py-3 px-4 border rounded-sm transition-colors hover:opacity-80"
                      style={{ borderColor: "var(--line)", textDecoration: "none" }}
                    >
                      {/* Miniatura si hay imagen */}
                      {ar.imageUrl ? (
                        <img
                          src={ar.imageUrl}
                          alt={ar.title}
                          loading="lazy"
                          onError={(e) => { e.currentTarget.style.display = "none"; }}
                          className="w-14 h-10 object-cover rounded-sm flex-none"
                          style={{ border: "1px solid var(--line)" }}
                        />
                      ) : (
                        <span className="w-14 h-10 rounded-sm flex-none" style={{ background: "var(--line)" }}></span>
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="block text-[15px] leading-snug" style={{ color: "var(--fg)", fontWeight: 500 }}>{ar.title}</span>
                        <span className="flex items-center gap-2 mt-1">
                          <span style={{ width: 7, height: 7, background: info.color, borderRadius: 1, flex: "none" }}></span>
                          <span className={`${ibmPlexMono.className} text-[9px] uppercase tracking-[.1em]`} style={{ color: "var(--muted)" }}>{ar.sourceName}</span>
                        </span>
                      </span>
                      <span className={`${ibmPlexMono.className} text-[11px] flex-none`} style={{ color: "var(--faint)" }}>↗</span>
                    </a>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <footer className={`${ibmPlexMono.className} flex justify-between items-center flex-wrap gap-[10px]`} style={{
              marginTop: 56, paddingTop: 18, borderTop: "1px solid var(--line)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)",
            }}>
              <Link href="/dashboard" style={{ color: "var(--muted)" }}>← Volver al boletín</Link>
              <span>Fuente única · no redistribuir</span>
            </footer>

            {/* Chat contextual con el analista */}
            <ChatSection threadTitle={thread.title} threadId={thread.id} />
          </article>
        </main>
      </div>
    </>
  );
}

// --- Subcomponente: Sección con título ---

function Section({ title, subtitle, mt, children }: { title: string; subtitle?: string; mt: number; children: string }) {
  const paragraphs = children.split("\n").filter((p) => p.trim());
  return (
    <section style={{ marginTop: mt }}>
      <div className="flex items-center gap-[14px] mb-4">
        <span className={ibmPlexMono.className} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--fg-strong)", fontWeight: 600 }}>{title}</span>
        {subtitle && <span className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--faint)" }}>{subtitle}</span>}
        <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
      </div>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ margin: "0 0 18px", fontSize: 18, lineHeight: 1.72, color: "var(--fg)", maxWidth: "66ch" }}>{p}</p>
      ))}
    </section>
  );
}

// --- Chat contextual con el analista ---

type ChatMessage = { role: "user" | "assistant"; content: string };

function ChatSection({ threadId, threadTitle }: { threadId: number; threadTitle: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  /*
   * Enviar pregunta: POST /api/threads/[threadId]/ask
   * El historial vive en estado de React (useState) — se pierde al recargar,
   * que es lo deseado por ahora (no localStorage ni BD).
   */
  async function sendQuestion(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    const userMsg: ChatMessage = { role: "user", content: q };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`/api/threads/${threadId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          history: messages.slice(-6), // contexto de la conversación previa
        }),
      });
      const data = await res.json();
      if (res.ok && data.answer) {
        setMessages([...updated, { role: "assistant", content: data.answer }]);
      } else {
        setMessages([...updated, { role: "assistant", content: `⚠️ ${data.error ?? "Error desconocido"}` }]);
      }
    } catch {
      setMessages([...updated, { role: "assistant", content: "⚠️ No se pudo contactar al analista." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={{ marginTop: 56 }}>
      <div className="flex items-center gap-[14px] mb-4">
        <span className={ibmPlexMono.className} style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--fg-strong)", fontWeight: 600 }}>Preguntar al analista</span>
        <span className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--faint)" }}>Contexto del teatro cargado</span>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }}></span>
      </div>

      {/* Historial de la conversación */}
      {messages.length > 0 && (
        <div className="flex flex-col gap-4 mb-5">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "ml-6" : ""}>
              <div className={ibmPlexMono.className} style={{
                fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase",
                color: m.role === "user" ? "var(--unread)" : "var(--alarm)",
                marginBottom: 5,
              }}>
                {m.role === "user" ? "Tú" : "Analista"}
              </div>
              <p className="whitespace-pre-wrap leading-relaxed" style={{
                margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--fg)",
              }}>{m.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Input + botón */}
      <form onSubmit={sendQuestion} className="flex gap-3 items-center">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={loading ? "El analista está pensando..." : `Pregunta sobre "${threadTitle}"...`}
          disabled={loading}
          className="flex-1 min-w-0 px-4 py-2.5 text-[15px] rounded-sm focus:outline-none"
          style={{
            background: "var(--surface-2)", border: "1px solid var(--line-strong)",
            color: "var(--fg)", fontFamily: `${playfair.style.fontFamily}, Georgia, serif`,
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className={`${ibmPlexMono.className} px-4 py-2.5 rounded-sm flex-none transition-opacity`}
          style={{
            fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", cursor: loading ? "default" : "pointer",
            border: "1px solid var(--line-strong)", background: "var(--line-strong)", color: "var(--fg-strong)",
            opacity: loading || !input.trim() ? 0.5 : 1,
          }}
        >
          {loading ? "…" : "Enviar"}
        </button>
      </form>

      <p className={ibmPlexMono.className} style={{ marginTop: 10, fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>
        La conversación es por sesión — se pierde al recargar la página.
      </p>
    </section>
  );
}
