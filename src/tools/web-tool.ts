import { parse } from "node-html-parser";
import type { HTMLElement } from "node-html-parser";
import { BaseTool, type ToolSchema } from "./base-tool.js";

const MAX_OUTPUT_CHARS = 20_000;

// Tags whose content is entirely stripped (including children)
const STRIP_TAGS = new Set([
  "script", "style", "svg", "noscript", "iframe", "canvas",
  "nav", "footer", "header", "aside", "form", "button", "input",
  "select", "textarea", "meta", "link", "head",
]);

// Block-level tags that get a blank line after them
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "blockquote",
  "table", "tr", "li", "dd", "dt", "figure", "figcaption",
]);

function nodeToMarkdown(el: HTMLElement): string {
  const tag = el.tagName?.toLowerCase() ?? "";

  if (STRIP_TAGS.has(tag)) return "";

  // Headings
  if (tag === "h1") return `\n# ${el.text.trim()}\n`;
  if (tag === "h2") return `\n## ${el.text.trim()}\n`;
  if (tag === "h3") return `\n### ${el.text.trim()}\n`;
  if (tag === "h4" || tag === "h5" || tag === "h6") return `\n#### ${el.text.trim()}\n`;

  // Links — preserve href so model can follow them
  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    const text = el.text.trim();
    if (!text) return "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
    return `[${text}](${href})`;
  }

  // Code
  if (tag === "code") return "`" + el.text + "`";
  if (tag === "pre") return `\n\`\`\`\n${el.text.trim()}\n\`\`\`\n`;

  // Lists
  if (tag === "ul" || tag === "ol") {
    const items = el.querySelectorAll("li");
    return "\n" + items.map((li) => `- ${li.text.trim()}`).join("\n") + "\n";
  }

  // Walk children for everything else
  let result = el.childNodes
    .map((child) => {
      if (child.nodeType === 3) {
        // Text node
        return (child as unknown as { text: string }).text;
      }
      return nodeToMarkdown(child as HTMLElement);
    })
    .join("");

  if (BLOCK_TAGS.has(tag)) {
    result = result.trim();
    if (result) result = "\n" + result + "\n";
  }

  return result;
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  const root = parse(html);

  // Resolve relative links to absolute using baseUrl
  const base = (() => {
    try { return new URL(baseUrl); } catch { return null; }
  })();

  if (base) {
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (href && !href.startsWith("http") && !href.startsWith("//") && !href.startsWith("javascript:")) {
        try {
          a.setAttribute("href", new URL(href, base).toString());
        } catch { /* skip malformed */ }
      }
    }
  }

  // Extract title
  const title = root.querySelector("title")?.text.trim() ?? "";

  // Try to find main content area first
  const contentEl =
    root.querySelector("main") ??
    root.querySelector("article") ??
    root.querySelector('[role="main"]') ??
    root.querySelector("#content") ??
    root.querySelector(".content") ??
    root.querySelector("body") ??
    root;

  let markdown = nodeToMarkdown(contentEl as HTMLElement);

  // Collapse excessive blank lines
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  const header = title ? `# ${title}\n\n` : "";
  const full = header + markdown;

  if (full.length > MAX_OUTPUT_CHARS) {
    return full.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Truncated — ${full.length} total chars. Fetch with a more specific URL or read a linked section.]`;
  }

  return full;
}

export class WebTool extends BaseTool {
  name(): string {
    return "web";
  }

  toolDescription(): string {
    return "Fetch a URL and return its content as readable markdown text. Links are preserved as [text](url) so you can navigate to related pages.";
  }

  toolSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name(),
        description:
          "Fetch a URL and return its content as clean readable markdown. Scripts, styles, and navigation chrome are stripped. Links are preserved as [text](url) for further navigation.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch",
            },
          },
          required: ["url"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url || typeof url !== "string") return "Error: missing 'url'";

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return `Error: invalid URL "${url}"`;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return `Error: only http/https URLs are supported`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; crab-rave-agent/1.0)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText} for ${url}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("html");
    const isText = contentType.includes("text/") || contentType.includes("json") || contentType.includes("xml");

    const body = await response.text();

    if (!isHtml && isText) {
      // Return plain text/JSON/XML directly, truncated
      const out = body.length > MAX_OUTPUT_CHARS
        ? body.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Truncated — ${body.length} total chars]`
        : body;
      return `${url}\n\n${out}`;
    }

    if (!isHtml) {
      return `Error: response is not HTML or text (content-type: ${contentType})`;
    }

    return `${url}\n\n${htmlToMarkdown(body, url)}`;
  }
}
