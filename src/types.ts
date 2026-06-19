export type JsonObject = Record<string, unknown>;

export interface FetchTextResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
}

export interface LinkItem {
  label: string;
  url: string;
}

export interface Course {
  id: string;
  name: string;
  code?: string;
  semester?: string;
  url: string;
  raw?: unknown;
}

export interface NormalizedCourse {
  courseId: string;
  courseName: string;
  courseCode?: string;
  semester?: string;
  url: string;
}

export interface ParsedPage {
  source: string;
  status: number;
  contentType?: string;
  title: string;
  emptyState?: string;
  rows: Record<string, string>[];
  links: LinkItem[];
  text: string;
}

export interface DueItem {
  courseId: string;
  courseName: string;
  courseCode?: string;
  type: "assignment" | "quiz" | "calendar" | "content" | "update";
  title: string;
  dueAt?: string;
  dueText?: string;
  status?: string;
  url?: string;
  source: string;
}

export interface Announcement {
  courseId: string;
  courseName: string;
  courseCode?: string;
  title: string;
  postedAt?: string;
  body: string;
  url?: string;
  source: string;
}

export interface ContentTopic {
  id?: string;
  title: string;
  url: string;
  type?: string;
  fileUrl?: string;
}

export interface ContentModule {
  id?: string;
  title: string;
  url?: string;
  topics: ContentTopic[];
  modules: ContentModule[];
}
