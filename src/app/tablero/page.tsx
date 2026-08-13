"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import * as topojson from "topojson-client";
import worldTopo from "world-atlas/countries-110m.json";
import lookup from "country-code-lookup";
import Nav from "@/components/Nav";

/*
 * /tablero — Dos vistas del tablero global: MAPA y RED.
 *
 * MAPA: países coloreados por tensionLevel máximo de los teatros que los
 * implican. Click en país → panel lateral con los teatros.
 * RED: grafo de fuerzas (d3-force) de teatros y sus conexiones materiales.
 *
 * Bibliotecas: d3-geo (proyección del mapa), d3-force (simulación del grafo),
 * topojson-client (decodifica world-atlas) + world-atlas (topología de países).
 * Elegí d3 (bajo nivel, SVG) en vez de react-simple-maps o deck.gl: queremos
 * sobriedad de briefing, no un dashboard de videojuego, y d3 nos da control
 * total del render SVG con el mínimo overhead.
 */

const ibmPlexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["600", "700", "800"] });

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
        --map-bg: oklch(0.94 0.004 95);
        --map-land: oklch(0.86 0.006 92);
        --node-link: oklch(0 0 0 / .5);
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
      --map-bg: oklch(0.1 0.005 74);
      --map-land: oklch(0.22 0.008 74);
      --node-link: oklch(1 0 0 / .5);
    }
  `;
}

// Datos del mapa (topología decodificada una sola vez)
const worldTopology = worldTopo as unknown as { objects: { countries: { type: string } } };

// Mapa de ISO numérico (id de world-atlas, 3 dígitos) → ISO alpha-2.
// world-atlas usa el código numérico ISO 3166-1 como id; country-code-lookup
// lo expone como isoNo. Con esto coloreamos cada país por su alpha-2 correcto.
const numericToIso2 = (() => {
  const m = new Map<string, string>();
  for (const c of lookup.countries as Array<{ isoNo?: string; iso2?: string }>) {
    if (c.isoNo && c.iso2) {
      m.set(String(c.isoNo).padStart(3, "0"), c.iso2);
    }
  }
  return m;
})();

// Escala de tensión para el mapa — 5 pasos secuenciales con salto perceptible
// de luminosidad Y saturación en cada nivel.
//   oscuro: gris azulado apagado (1) → ocre/ámbar (3) → rojo intenso (5)
//   claro:  equivalente sobrio sobre fondo blanco
const TENSION_FILL = (t: number, dark: boolean): string => {
  if (dark) {
    switch (t) {
      case 1: return "oklch(0.36 0.02 240)"; // gris azulado apagado
      case 2: return "oklch(0.47 0.06 200)"; // azul-teal perceptible
      case 3: return "oklch(0.62 0.12 75)";  // ocre/ámbar
      case 4: return "oklch(0.62 0.16 40)";  // naranja-rojizo
      default: return "oklch(0.68 0.21 26)"; // rojo intenso
    }
  }
  switch (t) {
    case 1: return "oklch(0.86 0.02 240)"; // gris azulado claro
    case 2: return "oklch(0.78 0.06 200)"; // azul claro perceptible
    case 3: return "oklch(0.76 0.12 80)";  // ocre claro
    case 4: return "oklch(0.66 0.14 40)";  // naranja
    default: return "oklch(0.55 0.19 26)"; // rojo
  }
};

// País sin teatros: claramente más apagado que el nivel 1.
const COUNTRY_EMPTY_FILL = (dark: boolean): string =>
  dark ? "oklch(0.22 0.005 74)" : "oklch(0.9 0.004 95)";

// Tipos de red
type NetworkNode = { id: number; title: string; verdict: string | null; domains: string[]; primaryDomain: string | null; tensionLevel: number | null; articleCount: number };
type NetworkEdge = { source: number | NetworkNode; target: number | NetworkNode; linkType: string; strength: number; rationale: string; timesConfirmed: number; stable: boolean };
type NetworkData = { nodes: NetworkNode[]; edges: NetworkEdge[] };

// Dominio → color (leyenda de la red)
const DOMAIN_COLORS: Record<string, string> = {
  energia_fosil: "oklch(0.68 0.12 55)",
  energia_nuclear: "oklch(0.68 0.12 85)",
  energia_renovable: "oklch(0.6 0.1 140)",
  rutas_maritimas: "oklch(0.62 0.1 220)",
  rutas_terrestres: "oklch(0.62 0.1 240)",
  minerales_criticos: "oklch(0.66 0.12 30)",
  semiconductores: "oklch(0.6 0.1 300)",
  armas_convencionales: "oklch(0.66 0.12 20)",
  armas_estrategicas: "oklch(0.66 0.12 350)",
  agua_alimentos: "oklch(0.62 0.1 160)",
  finanzas: "oklch(0.6 0.1 260)",
  datos_infraestructura: "oklch(0.6 0.1 200)",
  migracion: "oklch(0.62 0.1 90)",
  industria_manufactura: "oklch(0.62 0.1 70)",
  territorio: "oklch(0.64 0.1 40)",
  influencia_politica: "oklch(0.6 0.02 82)",
  other: "oklch(0.5 0.01 82)",
};

// linkType → estilo de arista
const LINK_STYLE: Record<string, string> = {
  cadena_material: "solid",
  mismo_bloque: "solid",
  presion_coordinada: "dashed",
  competencia_recurso: "dashed",
  distraccion: "dotted",
  motor_interno: "dotted",
};

// Abrevia el título de un teatro para la etiqueta del grafo.
function abbrevTitle(title: string, max = 32): string {
  const cleaned = title.replace(/\s*[-—–|]\s*/g, " · ");
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

export default function TableroPage() {
  const [view, setView] = useState<"mapa" | "red">("mapa");
  const [themePref, setThemePref] = useState<ThemeMode>("auto");
  const [systemDark, setSystemDark] = useState(false);
  const [mapData, setMapData] = useState<{ countries: Array<{ code: string; threads: Array<{ id: number; title: string; tensionLevel: number | null }>; maxTension: number; activeDeviations: number }> } | null>(null);
  const [net, setNet] = useState<NetworkData | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NetworkNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ source: number; target: number; linkType: string; strength: number; rationale: string; stable: boolean } | null>(null);
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);
  const [hoveredCountry, setHoveredCountry] = useState<{ code: string; name: string; tension: number } | null>(null);

  // Tamaño real del contenedor del GRAFO (vía ResizeObserver). Solo el grafo
  // necesita medición; el mapa usa proyección fija (1000x520) y escala con
  // viewBox, sin re-proyección (eso distorsionaba la geografía).
  const graphRef = useRef<HTMLDivElement>(null);
  const [vizSize, setVizSize] = useState({ width: 1000, height: 600 });

  useEffect(() => {
    if (view !== "red") return;
    const el = graphRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setVizSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const effectiveTheme: "light" | "dark" = themePref === "auto" ? (systemDark ? "dark" : "light") : themePref;

  // Topología de países decodificada (solo en cliente)
  const countries = useMemo(() => {
    // @ts-expect-error — topojson types
    const fc = topojson.feature(worldTopology, worldTopology.objects.countries) as { features: any[] };
    return fc;
  }, []);

  useEffect(() => {
    fetch("/api/map").then((r) => r.json()).then(setMapData).catch(() => {});
    fetch("/api/network").then((r) => r.json()).then(setNet).catch(() => {});
  }, []);

  const countryByCode = useMemo(() => {
    const map = new Map<string, { code: string; threads: Array<{ id: number; title: string; tensionLevel: number | null }>; maxTension: number; activeDeviations: number }>();
    for (const c of mapData?.countries ?? []) map.set(c.code, c);
    return map;
  }, [mapData]);

  // Altura de la visualización: relativa al viewport, con mínimo razonable
  const [vizHeight, setVizHeight] = useState(560);
  useEffect(() => {
    const compute = () => setVizHeight(Math.max(360, Math.min(window.innerHeight * 0.75, 900)));
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  // Proyección del mapa — SIEMPRE fija (1000x520). La geografía no debe
  // re-proyectarse con el tamaño del contenedor: eso la distorsiona. El SVG
  // escala via viewBox + preserveAspectRatio.
  const projection = useMemo(() => {
    if (!countries.features.length) return null;
    return geoNaturalEarth1().fitSize([1000, 520], countries as any);
  }, [countries]);
  const pathGen = useMemo(() => (projection ? geoPath(projection) : null), [projection]);

  // Layout del grafo — calculado SINCRÓNICAMENTE (useMemo), no en useEffect.
  // Así los nodos SIEMPRE tienen x/y en el primer render: sin parpadeo NaN.
  const graphLayout = useMemo(() => {
    if (view !== "red" || !net || net.nodes.length === 0) return null;
    const nodes = net.nodes.map((n) => ({ ...n }));
    const edges = net.edges.map((e) => ({ ...e }));
    const W = Math.max(400, vizSize.width);
    const H = Math.max(400, vizSize.height);
    const sim = forceSimulation(nodes as any)
      .force("link", forceLink(edges as any).id((d: any) => d.id).distance(Math.min(W, H) / 6).strength((l: any) => 0.5 + l.strength / 6))
      .force("charge", forceManyBody().strength(-Math.min(W, H) / 8))
      .force("center", forceCenter(W / 2, H / 2).strength(0.1))
      .force("collide", forceCollide((d: any) => 16 + Math.sqrt(d.articleCount || 1) * 1.5))
      .stop();
    sim.tick(200);
    return { nodes: nodes as any[], edges: edges as any[], W, H };
  }, [view, net, vizSize.width, vizSize.height]);

  // panel lateral por país
  const selectedCountryData = selectedCountry ? countryByCode.get(selectedCountry) : null;

  // Top 5 por tensión (mapa) y top 5 por conexiones (red) para el panel por defecto
  const topCountries = [...(mapData?.countries ?? [])]
    .sort((a, b) => b.maxTension - a.maxTension || b.threads.length - a.threads.length)
    .slice(0, 5);
  const nodeDegree = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of net?.edges ?? []) {
      const s = typeof e.source === "object" ? (e.source as any).id : e.source;
      const t = typeof e.target === "object" ? (e.target as any).id : e.target;
      m.set(s, (m.get(s) ?? 0) + 1);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [net]);
  const topNodes = [...(net?.nodes ?? [])]
    .sort((a, b) => (nodeDegree.get(b.id) ?? 0) - (nodeDegree.get(a.id) ?? 0) || (b.articleCount ?? 0) - (a.articleCount ?? 0))
    .slice(0, 5);

  return (
    <>
      <style>{`${themeCSS(effectiveTheme)}`}</style>
      <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--fg)", transition: "background .25s,color .25s", fontFamily: `${playfair.style.fontFamily}, Georgia, serif` }}>

        <div style={{ paddingTop: 14 }}>
          <Nav themePref={themePref} onThemeChange={setThemePref} />
        </div>

        <main className="max-w-[1600px] mx-auto px-4 md:px-[44px] pb-[80px]">
          <div className="flex items-center justify-between gap-4 flex-wrap" style={{ padding: "24px 0 16px" }}>
            <h1 className="font-extrabold" style={{ margin: 0, fontSize: "clamp(26px, 4vw, 38px)", letterSpacing: "-.01em", color: "var(--fg-strong)" }}>Tablero</h1>
            <div style={{ display: "inline-flex", border: "1px solid var(--line-strong)", borderRadius: 3, overflow: "hidden" }}>
              {(["mapa", "red"] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className={ibmPlexMono.className} style={{
                  fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", border: "none", cursor: "pointer", padding: "6px 16px", fontWeight: 600,
                  background: view === v ? "var(--line-strong)" : "transparent", color: view === v ? "var(--fg-strong)" : "var(--muted)",
                }}>{v === "mapa" ? "Mapa" : "Red"}</button>
              ))}
            </div>
          </div>

          {view === "mapa" ? (
            <div className="flex flex-col lg:flex-row gap-6">
              {/* Mapa — ocupa el ancho disponible, alto relativo al viewport */}
              <div className="flex-[3] min-w-0" style={{ border: "1px solid var(--line)", background: "var(--map-bg)", borderRadius: 2, position: "relative" }}>
                <div style={{ width: "100%", height: vizHeight, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg viewBox="0 0 1000 520" preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", display: "block" }}>
                    {pathGen && countries.features.map((f: any, i: number) => {
                      const code = numericToIso2.get(String(f.id)) ?? "";
                      const entry = code ? countryByCode.get(code) : undefined;
                      const tension = entry?.maxTension ?? 0;
                      const hasDev = (entry?.activeDeviations ?? 0) > 0;
                      const fill = entry ? TENSION_FILL(tension, effectiveTheme === "dark") : COUNTRY_EMPTY_FILL(effectiveTheme === "dark");
                      const isSelected = selectedCountry === code;
                      return (
                        <path
                          key={i}
                          d={pathGen(f) ?? undefined}
                        fill={fill}
                        stroke={hasDev ? "var(--alarm)" : isSelected ? "var(--fg-strong)" : "var(--map-bg)"}
                        strokeWidth={hasDev ? 1.2 : isSelected ? 1.5 : 0.4}
                        style={{ cursor: entry ? "pointer" : "default", transition: "fill .15s" }}
                        onClick={() => {
                          if (entry) setSelectedCountry(selectedCountry === code ? null : code);
                        }}
                        onMouseEnter={(e) => {
                          if (entry) {
                            e.currentTarget.style.opacity = "0.8";
                            setHoveredCountry({ code, name: f.properties?.name ?? code, tension });
                          }
                        }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; setHoveredCountry(null); }}
                      />
                    );
                  })}
                  </svg>
                </div>
                {/* Tooltip del país */}
                {hoveredCountry && (
                  <div className={ibmPlexMono.className} style={{
                    position: "absolute", top: 12, left: 12, pointerEvents: "none",
                    padding: "6px 10px", background: "var(--page-bg)", border: "1px solid var(--line-strong)",
                    borderRadius: 2, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--fg)",
                  }}>
                    {hoveredCountry.name} · tensión {hoveredCountry.tension}
                  </div>
                )}
                {/* Leyenda */}
                <div className={`${ibmPlexMono.className} flex items-center gap-3 flex-wrap`} style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>
                  <span>Tensión:</span>
                  <span className="flex items-center gap-1"><span style={{ width: 11, height: 11, background: COUNTRY_EMPTY_FILL(effectiveTheme === "dark"), display: "inline-block", borderRadius: 1, border: "1px solid var(--line)" }}></span>sin datos</span>
                  {[1, 2, 3, 4, 5].map((t) => (
                    <span key={t} className="flex items-center gap-1">
                      <span style={{ width: 11, height: 11, background: TENSION_FILL(t, effectiveTheme === "dark"), display: "inline-block", borderRadius: 1 }}></span>{t}
                    </span>
                  ))}
                  <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, border: "1.5px solid var(--alarm)", display: "inline-block", borderRadius: 1 }}></span>Desviación</span>
                </div>
              </div>

              {/* Panel lateral país — ancho flexible */}
              <div className="w-full lg:flex-[1] lg:min-w-[300px] shrink-0">
                {selectedCountryData ? (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 2, padding: "18px 20px" }}>
                    <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>{selectedCountry}</div>
                    <div className={ibmPlexMono.className} style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", margin: "4px 0 12px" }}>
                      Tensión máx: {selectedCountryData.maxTension} · {selectedCountryData.activeDeviations} desviaciones
                    </div>
                    <div className="flex flex-col gap-2">
                      {selectedCountryData.threads.map((t) => (
                        <Link key={t.id} href={`/dashboard/${t.id}`} style={{ textDecoration: "none" }}>
                          <div style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 2, transition: "background .15s" }}>
                            <div style={{ fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>{t.title}</div>
                            <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: t.tensionLevel && t.tensionLevel >= 4 ? "var(--alarm)" : "var(--faint)", marginTop: 3 }}>
                              Tensión {t.tensionLevel ?? "—"} ↗
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 2, padding: "18px 20px" }}>
                    <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>Mayor tensión</div>
                    <div className={`${ibmPlexMono.className} flex flex-col gap-2`} style={{ marginTop: 12 }}>
                      {topCountries.length === 0 && (
                        <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>Sin datos de tensión</div>
                      )}
                      {topCountries.map((c) => (
                        <div
                          key={c.code}
                          onClick={() => setSelectedCountry(c.code)}
                          className={ibmPlexMono.className}
                          style={{ padding: "9px 12px", border: "1px solid var(--line)", borderRadius: 2, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background .15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--line)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <span style={{ fontSize: 11, letterSpacing: ".1em", color: "var(--fg)" }}>{c.code}</span>
                          <span style={{ fontSize: 9, letterSpacing: ".08em", color: c.maxTension >= 4 ? "var(--alarm)" : "var(--faint)" }}>tensión {c.maxTension} · {c.threads.length} teatros</span>
                        </div>
                      ))}
                    </div>
                    <div className={`${ibmPlexMono.className}`} style={{ marginTop: 12, fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>
                      O haz click en un país del mapa
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col lg:flex-row gap-6">
              {/* Grafo — ocupa el ancho disponible, alto relativo al viewport */}
              <div className="flex-[3] min-w-0">
                {/* Contador */}
                {net && (
                  <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", padding: "8px 2px" }}>
                    {net.nodes.length} teatros conectados · {net.edges.length} conexiones ({net.edges.filter((e: any) => e.stable).length} estables)
                  </div>
                )}
                <div className="flex-1 min-w-0" style={{ border: "1px solid var(--line)", background: "var(--map-bg)", borderRadius: 2 }}>
                <div ref={graphRef} style={{ width: "100%", height: vizHeight }}>
                <svg viewBox={`0 0 ${graphLayout?.W ?? vizSize.width} ${graphLayout?.H ?? vizSize.height}`} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}>
                  {graphLayout && graphLayout.edges.map((e: any, i: number) => {
                    const a = typeof e.source === "object" ? e.source : null;
                    const b = typeof e.target === "object" ? e.target : null;
                    if (!a || !b) return null;
                    const isDimmed = hoveredNode !== null && hoveredNode !== a.id && hoveredNode !== b.id;
                    const isSelectedEdge = selectedEdge && ((selectedEdge.source === a.id && selectedEdge.target === b.id) || (selectedEdge.source === b.id && selectedEdge.target === a.id));
                    const stroke = e.stable ? "var(--fg)" : "var(--node-link)";
                    const dash = LINK_STYLE[e.linkType] === "dashed" ? "6 4" : LINK_STYLE[e.linkType] === "dotted" ? "2 4" : "none";
                    return (
                      <line
                        key={i}
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={stroke}
                        strokeWidth={(e.strength || 1) + (e.stable ? 0.5 : 0)}
                        strokeDasharray={dash}
                        opacity={isSelectedEdge ? 1 : isDimmed ? 0.08 : e.stable ? 0.6 : 0.3}
                        style={{ cursor: "pointer" }}
                        onClick={() => setSelectedEdge({ source: a.id, target: b.id, linkType: e.linkType, strength: e.strength, rationale: e.rationale, stable: e.stable })}
                      />
                    );
                  })}
                  {graphLayout && graphLayout.nodes.map((n: any, i: number) => {
                    const isDimmed = hoveredNode !== null && hoveredNode !== n.id;
                    const isSelected = selectedNode?.id === n.id;
                    const r = 10 + Math.sqrt(n.articleCount || 1) * 1.8;
                    const color = DOMAIN_COLORS[n.primaryDomain ?? "other"] ?? DOMAIN_COLORS.other;
                    const label = abbrevTitle(n.title, 36);
                    return (
                      <g
                        key={i}
                        transform={`translate(${n.x},${n.y})`}
                        opacity={isDimmed ? 0.15 : 1}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHoveredNode(n.id)}
                        onMouseLeave={() => setHoveredNode(null)}
                        onClick={() => setSelectedNode(n)}
                      >
                        <circle r={r} fill={color} fillOpacity={isSelected ? 1 : 0.7} stroke={isSelected ? "var(--fg-strong)" : "transparent"} strokeWidth={1.5} />
                        <text
                          dy={-r - 5}
                          textAnchor="middle"
                          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, letterSpacing: ".03em", fill: "var(--fg)", pointerEvents: "none" }}
                        >
                          {label}
                        </text>
                        <title>{n.title}</title>
                      </g>
                    );
                  })}
                  </svg>
                </div>
                {/* Leyenda: SOLO dominios presentes en los nodos visibles */}
                <div className={`${ibmPlexMono.className} flex items-center gap-2 flex-wrap`} style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", fontSize: 8.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--faint)" }}>
                  {(() => {
                    const present = new Set<string>();
                    for (const n of net?.nodes ?? []) for (const d of n.domains ?? []) present.add(d);
                    return [...present].map((k) => (
                      <span key={k} className="flex items-center gap-1"><span style={{ width: 8, height: 8, background: DOMAIN_COLORS[k] ?? DOMAIN_COLORS.other, display: "inline-block", borderRadius: "50%" }}></span>{k.replace(/_/g, " ")}</span>
                    ));
                  })()}
                  <span className="flex items-center gap-1"><span style={{ width: 8, height: 8, display: "inline-block", borderRadius: "50%", border: "1px solid var(--node-link)" }}></span>estable</span>
                </div>
                </div>
                {net && net.edges.length < 15 && (
                  <div className={`${ibmPlexMono.className}`} style={{ fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--faint)", padding: "10px 2px" }}>
                    La red se densifica con cada corrida semanal; las conexiones confirmadas varias veces se marcan como estables.
                  </div>
                )}
              </div>

              {/* Panel lateral red — ancho flexible */}
              <div className="w-full lg:flex-[1] lg:min-w-[300px] shrink-0">
                {selectedEdge ? (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 2, padding: "18px 20px" }}>
                    <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>Conexión</div>
                    <div className={ibmPlexMono.className} style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", margin: "4px 0 10px" }}>
                      {selectedEdge.linkType.replace(/_/g, " ")} · fuerza {selectedEdge.strength} · {selectedEdge.stable ? "estable" : "reciente"}
                    </div>
                    <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--fg)" }}>{selectedEdge.rationale}</p>
                    <button onClick={() => setSelectedEdge(null)} className={ibmPlexMono.className} style={{ marginTop: 12, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer", border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", borderRadius: 2, padding: "4px 10px" }}>Cerrar</button>
                  </div>
                ) : selectedNode ? (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 2, padding: "18px 20px" }}>
                    <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>Teatro</div>
                    <div style={{ fontSize: 17, color: "var(--fg-strong)", fontWeight: 600, margin: "6px 0 10px", fontFamily: `${playfair.style.fontFamily}, Georgia, serif` }}>{selectedNode.title}</div>
                    {selectedNode.verdict && <p style={{ margin: "0 0 10px", fontSize: 13, fontStyle: "italic", color: "var(--fg)", lineHeight: 1.5 }}>{selectedNode.verdict}</p>}
                    <div className={`${ibmPlexMono.className} flex flex-wrap gap-1.5`} style={{ marginBottom: 12 }}>
                      {(selectedNode.domains ?? []).map((d) => (
                        <span key={d} style={{ fontSize: 8.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 2, padding: "2px 6px" }}>{d.replace(/_/g, " ")}</span>
                      ))}
                    </div>
                    <Link href={`/dashboard/${selectedNode.id}`} className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--accent)" }}>Ver teatro →</Link>
                    <button onClick={() => setSelectedNode(null)} className={ibmPlexMono.className} style={{ marginTop: 12, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer", border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", borderRadius: 2, padding: "4px 10px" }}>Cerrar</button>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 2, padding: "18px 20px" }}>
                    <div className={ibmPlexMono.className} style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>Más conectados</div>
                    <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
                      {topNodes.length === 0 && (
                        <div className={`${ibmPlexMono.className}`} style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>Sin conexiones todavía</div>
                      )}
                      {topNodes.map((n) => (
                        <div
                          key={n.id}
                          onClick={() => setSelectedNode(n)}
                          className={ibmPlexMono.className}
                          style={{ padding: "9px 12px", border: "1px solid var(--line)", borderRadius: 2, cursor: "pointer", transition: "background .15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--line)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ fontSize: 11.5, letterSpacing: ".04em", color: "var(--fg)" }}>{n.title}</div>
                          <div style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--faint)", marginTop: 3 }}>{nodeDegree.get(n.id) ?? 0} conexiones</div>
                        </div>
                      ))}
                    </div>
                    <div className={`${ibmPlexMono.className}`} style={{ marginTop: 12, fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>
                      Haz click en un nodo o arista del grafo para ver el detalle
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
