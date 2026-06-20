import React from "react";

const URL_RE = /(https?:\/\/[^\s<>"]+)/g;

// Escape is handled by React; we just split bare URLs into links and \n into <br>.
export function RichText({ text }: { text?: string | null }) {
  if (!text) return null;
  const lines = String(text).split("\n");
  return (
    <>
      {lines.map((line, li) => {
        const parts: React.ReactNode[] = [];
        let last = 0;
        let m: RegExpExecArray | null;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(line)) !== null) {
          if (m.index > last) parts.push(line.slice(last, m.index));
          parts.push(
            <a key={`${li}-${m.index}`} href={m[1]} target="_blank" rel="noreferrer">{m[1]}</a>,
          );
          last = m.index + m[1].length;
        }
        if (last < line.length) parts.push(line.slice(last));
        return (
          <React.Fragment key={li}>
            {parts}
            {li < lines.length - 1 && <br />}
          </React.Fragment>
        );
      })}
    </>
  );
}

export function LinkButtons({ linksJson }: { linksJson?: string | null }) {
  if (!linksJson) return null;
  let links: any[];
  try {
    links = JSON.parse(linksJson);
  } catch {
    return null;
  }
  if (!Array.isArray(links)) return null;
  return (
    <>
      {links.map((link, i) => {
        const url = link && typeof link === "object" ? link.url : null;
        if (typeof url !== "string" || !url.startsWith("http")) return null;
        const label = (link.label as string) || "Ссылка";
        return (
          <a key={i} className="button button-ghost" href={url} target="_blank" rel="noreferrer">{label}</a>
        );
      })}
    </>
  );
}
