// A small, purpose-built Markdown-to-HTML renderer for build-site.mjs's
// landing/docs pages (deploy.config.json's `landing`/`pages`) — not a
// general Markdown implementation, just what those two pages actually use:
// headings, paragraphs, links, bold/italic/inline code, fenced code blocks,
// unordered/ordered lists, and pipe tables. Same restraint as
// songbook_html.js's own renderNoteMarkdown, for the same reason: no new
// dependency, and every construct here is one this repo's own docs already
// use, not a hypothetical future one.
//
// No embedded HTML passthrough, no nested blockquotes, no link reference
// definitions — none of that appears in this repo's own markdown, so none
// of it is supported.

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline spans: `code` (checked first so its contents are never touched by
// the others below), **bold**, *italic*/_italic_, [text](url).
function renderInline(text) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/);
  return parts
    .map((part) => {
      if (!part) return "";
      if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      if (/^\*\*[^*]+\*\*$/.test(part)) return `<strong>${renderInline(part.slice(2, -2))}</strong>`;
      if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part)) return `<em>${renderInline(part.slice(1, -1))}</em>`;
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) return `<a href="${escapeHtml(link[2])}">${renderInline(link[1])}</a>`;
      return escapeHtml(part);
    })
    .join("");
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const fenceLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { fenceLines.push(lines[i]); i++; }
      i++; // skip closing fence
      html.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
      continue;
    }

    // A header row immediately followed by a `---|---` separator: a table.
    if (i + 1 < lines.length && lines[i].includes("|") && isTableSeparator(lines[i + 1])) {
      const headCells = splitTableRow(lines[i]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      html.push("<table>");
      html.push("<thead><tr>" + headCells.map((c) => `<th>${renderInline(c)}</th>`).join("") + "</tr></thead>");
      html.push("<tbody>" + bodyRows.map((row) => "<tr>" + row.map((c) => `<td>${renderInline(c)}</td>`).join("") + "</tr>").join("") + "</tbody>");
      html.push("</table>");
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(m[3]);
        i++;
      }
      html.push(`<${tag}>` + items.map((item) => `<li>${renderInline(item)}</li>`).join("") + `</${tag}>`);
      continue;
    }

    // Plain paragraph: consume contiguous non-blank, non-special lines.
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^(#{1,6})\s/) && !lines[i].startsWith("```")) {
      paraLines.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(paraLines.join(" ").trim())}</p>`);
  }

  return html.join("\n");
}

// Wraps rendered content in a minimal, self-contained page — no external
// assets, matching this repo's other generated pages (songbook.html,
// build-songbook.mjs's output). `title` comes from the markdown's own first
// heading when present, falling back to the site name.
export function renderMarkdownPage(markdown, { fallbackTitle = "ChordPro Songbook Builder" } = {}) {
  const titleMatch = markdown.match(/^#\s+(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.55;
  }
  h1, h2, h3 { line-height: 1.25; }
  code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; }
  pre { background: rgba(127,127,127,0.12); padding: 0.75rem 1rem; overflow-x: auto; border-radius: 6px; }
  code { background: rgba(127,127,127,0.12); padding: 0.1rem 0.35rem; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid rgba(127,127,127,0.35); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  blockquote { border-left: 3px solid rgba(127,127,127,0.35); margin: 1rem 0; padding: 0.1rem 1rem; color: inherit; opacity: 0.85; }
  a { color: #2563eb; }
  @media (prefers-color-scheme: dark) { a { color: #7dabff; } }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
