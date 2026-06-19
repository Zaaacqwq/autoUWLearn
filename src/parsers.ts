import * as cheerio from "cheerio";
import { absoluteLearnUrl } from "./config.js";
import type { ContentModule, ContentTopic, Course, LinkItem } from "./types.js";

const whitespace = /\s+/g;

export function cleanText(value: string | undefined | null): string {
  return (value ?? "").replace(whitespace, " ").trim();
}

export function extractD2lId(url: string): string | undefined {
  return (
    /\/d2l\/home\/(\d+)/i.exec(url)?.[1] ??
    /[?&]ou=(\d+)/i.exec(url)?.[1] ??
    /\/content\/enforced\/(\d+)-/i.exec(url)?.[1]
  );
}

export function parseCoursesJson(input: unknown): Course[] {
  const courses: Course[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const object = node as Record<string, unknown>;
    const id =
      stringish(object.OrgUnitId) ??
      stringish(object.Identifier) ??
      stringish(object.Id) ??
      stringish(object.id);
    const name =
      stringish(object.Name) ??
      stringish(object.CourseName) ??
      stringish(object.DisplayName) ??
      stringish(object.name);
    const href =
      stringish(object.Url) ??
      stringish(object.Link) ??
      stringish(object.href) ??
      (id ? `/d2l/home/${id}` : undefined);

    if (id && name && href && /course|orgunit|name|displayname/i.test(Object.keys(object).join(" "))) {
      courses.push({
        id,
        name,
        code: stringish(object.Code) ?? stringish(object.CourseCode),
        semester: stringish(object.SemesterName) ?? stringish(object.Semester),
        url: absoluteLearnUrl(href),
        raw: object
      });
    }

    Object.values(object).forEach(visit);
  };
  visit(input);

  const byId = new Map<string, Course>();
  for (const course of courses) byId.set(course.id, course);
  return [...byId.values()];
}

export function parseLinks(html: string): LinkItem[] {
  const $ = cheerio.load(html);
  $("script, style, template, noscript").remove();
  const links: LinkItem[] = [];
  $("a[href]").each((_, element) => {
    const label = cleanText($(element).text() || $(element).attr("aria-label"));
    const href = $(element).attr("href");
    if (!label || !href) return;
    if (/^\s*javascript:/i.test(href)) return;
    links.push({ label, url: absoluteLearnUrl(href) });
  });
  return dedupeLinks(links);
}

export function parseCourseHome(html: string): {
  title: string;
  links: LinkItem[];
  nav: LinkItem[];
  announcements: string[];
  updates: string[];
} {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text() || $("h1").first().text());
  const links = parseLinks(html);
  const nav = links.filter((link) =>
    /content|grades|classlist|discussions|group|dropbox|assignment|quiz|survey|calendar|checklist|rubric|award/i.test(
      `${link.label} ${link.url}`
    )
  );
  const bodyLines = cleanText($("body").text())
    .split(/(?<=[.!?])\s+|\n+/)
    .map(cleanText)
    .filter(Boolean);
  return {
    title,
    links,
    nav: dedupeLinks(nav),
    announcements: bodyLines.filter((line) => /announcement|news/i.test(line)).slice(0, 20),
    updates: bodyLines.filter((line) => /update|due|calendar|grade|dropbox|quiz/i.test(line)).slice(0, 20)
  };
}

export function parseContent(html: string): {
  title: string;
  modules: ContentModule[];
  topics: ContentTopic[];
  links: LinkItem[];
} {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text() || $("h1").first().text());
  const links = parseLinks(html);
  const contentLinks = links.filter((link) =>
    /\/d2l\/le\/content\/\d+\/(Home|viewContent|ContentObject)/i.test(link.url)
  );

  const modules: ContentModule[] = [];
  const moduleByUrl = new Map<string, ContentModule>();
  for (const link of contentLinks) {
    if (/\/Home$/i.test(link.url)) continue;
    if (/viewContent\/\d+\/View/i.test(link.url)) continue;
    const id = /\/content\/\d+\/([^/?#]+)/i.exec(link.url)?.[1];
    const module = { id, title: link.label, url: link.url, topics: [], modules: [] };
    moduleByUrl.set(link.url, module);
    modules.push(module);
  }

  const topics: ContentTopic[] = contentLinks
    .filter((link) => /viewContent\/\d+\/View/i.test(link.url))
    .map((link) => ({
      id: /viewContent\/(\d+)\/View/i.exec(link.url)?.[1],
      title: link.label,
      url: link.url,
      type: inferContentType(link.label, link.url)
    }));

  const fileLinks = links.filter((link) => /\/content\/enforced\/|\.pdf(\?|$)|\.docx?(\?|$)|\.pptx?(\?|$)|\.xlsx?(\?|$)/i.test(link.url));
  for (const topic of topics) {
    const matchingFile = fileLinks.find((link) => cleanText(link.label) === cleanText(topic.title)) ?? fileLinks[0];
    if (matchingFile) topic.fileUrl = matchingFile.url;
  }

  return { title, modules, topics, links };
}

export function parseContentItem(html: string): {
  title: string;
  text: string;
  links: LinkItem[];
  fileUrls: string[];
} {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text() || $("h1").first().text());
  const links = parseLinks(html);
  const fileUrls = new Set<string>();
  $("[src],[href]").each((_, element) => {
    const value = $(element).attr("src") ?? $(element).attr("href");
    if (!value) return;
    const url = absoluteLearnUrl(value);
    if (/\/content\/enforced\/|\.pdf(\?|$)|\.docx?(\?|$)|\.pptx?(\?|$)|\.xlsx?(\?|$)/i.test(url)) {
      fileUrls.add(url);
    }
  });
  const text = cleanText($("body").text());
  return { title, text, links, fileUrls: [...fileUrls] };
}

export function parseTableLikePage(html: string): {
  title: string;
  emptyState?: string;
  rows: Record<string, string>[];
  links: LinkItem[];
  text: string;
} {
  const $ = cheerio.load(html);
  $("script, style, template, noscript").remove();
  const title = cleanText($("title").first().text() || $("h1").first().text());
  const rows: Record<string, string>[] = [];
  $("table").each((_, table) => {
    const headers = $(table)
      .find("thead th, tr:first-child th")
      .toArray()
      .map((header) => cleanText($(header).text()));
    $(table)
      .find("tbody tr, tr")
      .each((index, row) => {
        if (index === 0 && headers.length > 0 && $(row).find("th").length > 0) return;
        const cells = $(row)
          .find("td, th")
          .toArray()
          .map((cell) => cleanText($(cell).text()))
          .filter(Boolean);
        if (cells.length === 0) return;
        const record: Record<string, string> = {};
        cells.forEach((cell, cellIndex) => {
          record[headers[cellIndex] || `column_${cellIndex + 1}`] = cell;
        });
        rows.push(record);
      });
  });
  const text = cleanText($("body").text());
  const emptyState = /no items found|there are no assignments|no quizzes available|don't have any discussion topics/i.exec(text)?.[0];
  return { title, emptyState, rows, links: parseLinks(html), text };
}

function stringish(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function dedupeLinks(links: LinkItem[]): LinkItem[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.label}\n${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferContentType(label: string, url: string): string | undefined {
  const value = `${label} ${url}`.toLowerCase();
  if (value.includes(".pdf")) return "pdf";
  if (value.includes(".doc")) return "document";
  if (value.includes(".ppt")) return "slides";
  if (value.includes(".xls")) return "spreadsheet";
  if (value.includes("quiz")) return "quiz";
  if (value.includes("assignment") || value.includes("dropbox")) return "assignment";
  return undefined;
}
