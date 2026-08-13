"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IBM_Plex_Mono } from "next/font/google";

/*
 * Nav — Cabecera de navegación tipo periódico, bajo el masthead.
 *
 * IBM Plex Mono, mayúsculas, letter-spacing amplio, separadores discretos.
 * Marca la sección activa según la URL. Incluye el selector de 3 temas
 * (claro/oscuro/auto) que cada página le pasa vía props: la página conserva
 * su propio estado de tema (necesario para su themeCSS()) y aquí SOLO se
 * renderiza el selector.
 */

const ibmPlexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"] });

type ThemeMode = "auto" | "light" | "dark";

const LINKS = [
  { href: "/dashboard", label: "Briefing" },
  { href: "/tablero", label: "Tablero" },
  { href: "/predicciones", label: "Predicciones" },
  { href: "/sources", label: "Fuentes" },
];

export default function Nav({
  themePref,
  onThemeChange,
}: {
  themePref: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
}) {
  const pathname = usePathname();

  const current = pathname?.startsWith("/predicciones")
    ? "Predicciones"
    : pathname?.startsWith("/tablero")
      ? "Tablero"
      : pathname?.startsWith("/sources")
        ? "Fuentes"
        : pathname?.startsWith("/dashboard") || pathname?.startsWith("/meta")
          ? "Briefing"
          : "";

  const themeSegs = ([
    { key: "light" as ThemeMode, label: "Claro" },
    { key: "dark" as ThemeMode, label: "Oscuro" },
    { key: "auto" as ThemeMode, label: "Auto" },
  ]).map((t) => ({ isActive: themePref === t.key, onClick: () => onThemeChange(t.key), key: t.key, label: t.label }));

  return (
    <div className={ibmPlexMono.className} style={{
      maxWidth: 1220, margin: "0 auto", padding: "0 16px 0 40px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 16, flexWrap: "wrap", borderBottom: "1px solid var(--line)",
      fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--muted)",
    }}>
      <nav style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
        {LINKS.map((l, i) => (
          <span key={l.href} style={{ display: "inline-flex", alignItems: "center" }}>
            {i > 0 && <span style={{ width: 1, height: 12, background: "var(--line)", margin: "0 14px" }}></span>}
            <Link
              href={l.href}
              style={{
                color: current === l.label ? "var(--fg-strong)" : "var(--muted)",
                fontWeight: current === l.label ? 600 : 400,
                textDecoration: "none", whiteSpace: "nowrap",
              }}
            >
              {l.label}
            </Link>
          </span>
        ))}
      </nav>

      <div style={{ display: "inline-flex", border: "1px solid var(--line-strong)", borderRadius: 3, overflow: "hidden" }}>
        {themeSegs.map((seg) => (
          <button key={seg.key} onClick={seg.onClick} style={{
            fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", border: "none", cursor: "pointer", padding: "5px 12px", fontWeight: 500,
            background: seg.isActive ? "var(--line-strong)" : "transparent", color: seg.isActive ? "var(--fg-strong)" : "var(--muted)",
          }}>{seg.label}</button>
        ))}
      </div>
    </div>
  );
}
